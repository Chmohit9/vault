// src/lib/nodes/failureDetector.ts
// Heartbeat-based failure detection.
//  - simulateHeartbeats(): the "node agents" — every node whose process is alive AND reachable checks in.
//  - detectFailures(): the coordinator's view — stale heartbeat => DEGRADED, then OFFLINE.
// A partitioned node cannot deliver heartbeats, so it is eventually declared OFFLINE, exactly as a
// real detector cannot tell a partition from a crash.

import { db } from "@/lib/db";
import { currentCluster, HEARTBEAT_TIMEOUT_MS } from "@/config/policy";
import { emit } from "@/lib/events/bus";
import { NodeClient } from "./nodeClient";

// Nodes with no baseUrl are still fully simulated: the coordinator IS the source of truth for their
// "process alive" state, so it's correct to just mark them heartbeated in bulk.
//
// Nodes WITH a baseUrl (apps/storage-node, e.g. via Docker Compose) get a REAL heartbeat: an actual
// GET /health call. This means stopping a node's container (`docker compose stop storage-node-2`)
// is detected here even if nobody clicked "Kill" in the dashboard — the failure is discovered the
// same way a real distributed system would discover it, not just read back out of a DB flag.
const HTTP_HEALTH_TIMEOUT_MS = 2_000;

export async function simulateHeartbeats(now = new Date()) {
  const cluster = currentCluster();
  const candidates = await db.node.findMany({
    where: { cluster, isCrashed: false, isPartitioned: false },
    select: { id: true, name: true, baseUrl: true, status: true },
  });

  const simulated = candidates.filter((n) => !n.baseUrl);
  const httpNodes = candidates.filter((n) => n.baseUrl);

  const recoveredNames: string[] = [];
  let heartbeatCount = 0;

  if (simulated.length > 0) {
    const wasDown = simulated.filter((n) => n.status !== "HEALTHY");
    const res = await db.node.updateMany({
      where: { id: { in: simulated.map((n) => n.id) } },
      data: { lastHeartbeat: now, status: "HEALTHY" },
    });
    heartbeatCount += res.count;
    recoveredNames.push(...wasDown.map((n) => n.name));
  }

  // Real HTTP calls to independent nodes don't contend for the DB connection pool the way concurrent
  // Prisma queries would, so it's safe (and much faster) to check them all at once.
  const results = await Promise.allSettled(
    httpNodes.map(async (n) => {
      const client = new NodeClient(n.name, n.baseUrl!, HTTP_HEALTH_TIMEOUT_MS);
      await client.health();
      return n;
    })
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const n = httpNodes[i];
    if (result.status !== "fulfilled") continue; // unreachable — leave heartbeat stale, let detectFailures age it out
    const wasDown = n.status !== "HEALTHY";
    await db.node.update({ where: { id: n.id }, data: { lastHeartbeat: now, status: "HEALTHY" } });
    heartbeatCount++;
    if (wasDown) recoveredNames.push(n.name);
  }

  for (const name of recoveredNames) {
    emit("node.recovered", `Node ${name} is heartbeating again (HEALTHY)`, {
      level: "success",
      data: { node: name },
    });
  }
  return { sent: heartbeatCount, recovered: recoveredNames };
}

export interface FailureDetectionResult {
  checked: number;
  markedOffline: string[];
  markedDegraded: string[];
}

export async function detectFailures(
  now = new Date(),
  timeoutMs = HEARTBEAT_TIMEOUT_MS
): Promise<FailureDetectionResult> {
  const cluster = currentCluster();
  const nodes = await db.node.findMany({ where: { cluster } });
  const markedOffline: string[] = [];
  const markedDegraded: string[] = [];

  for (const node of nodes) {
    const age = now.getTime() - node.lastHeartbeat.getTime();

    if (node.status !== "OFFLINE" && age > timeoutMs) {
      // Conditional update: if a heartbeat landed meanwhile, do nothing.
      const res = await db.node.updateMany({
        where: { id: node.id, status: node.status, lastHeartbeat: node.lastHeartbeat },
        data: { status: "OFFLINE" },
      });
      if (res.count === 1) {
        const seconds = Math.round(age / 1000);
        await db.repairLog.create({
          data: {
            cluster,
            type: "NODE_FAILOVER",
            nodeId: node.id,
            detail: `Node ${node.name} declared OFFLINE: no heartbeat for ${seconds}s`,
            success: true,
          },
        });
        emit("node.suspected_down", `Node ${node.name} declared OFFLINE (no heartbeat for ${seconds}s)`, {
          level: "error",
          data: { node: node.name, silentForMs: age },
        });
        markedOffline.push(node.name);
      }
    } else if (node.status === "HEALTHY" && age > timeoutMs / 2) {
      const res = await db.node.updateMany({
        where: { id: node.id, status: "HEALTHY", lastHeartbeat: node.lastHeartbeat },
        data: { status: "DEGRADED" },
      });
      if (res.count === 1) {
        emit("node.degraded", `Node ${node.name} is late with heartbeats (DEGRADED)`, {
          level: "warn",
          data: { node: node.name, silentForMs: age },
        });
        markedDegraded.push(node.name);
      }
    }
  }

  return { checked: nodes.length, markedOffline, markedDegraded };
}

// One full cycle, used by the background loop, the manual endpoint and tests.
export async function runFailureDetectionCycle(now = new Date()) {
  const heartbeats = await simulateHeartbeats(now);
  const detection = await detectFailures(now);
  return { heartbeats, detection };
}