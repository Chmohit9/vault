// src/lib/nodes/registry.ts

import { db } from "@/lib/db";
import { currentCluster, failureDomainForNode } from "@/config/policy";
import {
  ConflictError,
  NodeUnavailableError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from "@/lib/errors";
import { emit } from "@/lib/events/bus";
import { compareNodeNames, isNodeAvailable } from "./availability";

const NODE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

type ChaosActionName =
  | "KILL_NODE"
  | "REVIVE_NODE"
  | "CORRUPT_CHUNK"
  | "PARTITION_NODE"
  | "HEAL_PARTITION";

export async function logChaos(
  action: ChaosActionName,
  detail: string,
  ref: { nodeId?: string; chunkId?: string } = {}
) {
  await db.chaosEvent.create({
    data: {
      cluster: currentCluster(),
      action,
      nodeId: ref.nodeId ?? null,
      chunkId: ref.chunkId ?? null,
      detail,
    },
  });
}

// Accepts a node id OR its name ("node-2"), always scoped to the current cluster.
export async function resolveNode(idOrName: string) {
  const node = await db.node.findFirst({
    where: { cluster: currentCluster(), OR: [{ id: idOrName }, { name: idOrName }] },
  });
  if (!node) throw new NotFoundError(`Node not found: ${idOrName}`);
  return node;
}

export const getNode = resolveNode;

// baseUrl: when provided, the node is backed by a real HTTP storage-node service (apps/storage-node)
// at that URL instead of the shared simulated backend. See src/lib/storage/storageNode.ts.
export async function createNode(name: string, baseUrl?: string | null) {
  if (!NODE_NAME_RE.test(name)) {
    throw new ValidationError(
      "Node name must be 1-40 chars: letters, digits, '.', '_' or '-' (starting with a letter/digit)"
    );
  }
  const cluster = currentCluster();
  try {
    const node = await db.node.create({
      data: {
        cluster,
        name,
        backendPrefix: `${cluster}/${name}`,
        baseUrl: baseUrl ?? null,
        // App clock, not the DB clock, so heartbeat ages are never skewed.
        lastHeartbeat: new Date(),
      },
    });
    emit("node.created", `Node ${name} joined the cluster`, { level: "success", data: { node: name } });
    return node;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`Node ${name} already exists`);
    throw err;
  }
}

export async function listNodes() {
  const nodes = await db.node.findMany({ where: { cluster: currentCluster() } });
  return nodes.sort(compareNodeNames);
}

export interface NodeView {
  id: string;
  name: string;
  status: "HEALTHY" | "OFFLINE" | "DEGRADED";
  available: boolean;
  isCrashed: boolean;
  isPartitioned: boolean;
  flakyDisk: boolean;
  baseUrl: string | null;
  backedBy: "simulated" | "http";
  failureDomain: string;
  lastHeartbeat: string;
  heartbeatAgeMs: number;
  replicas: {
    total: number;
    synced: number;
    corrupted: number;
    missing: number;
    stale: number;
    repairing: number;
  };
}

// Nodes plus per-node replica health, computed from actual DB state.
export async function listNodesWithStats(now = new Date()): Promise<NodeView[]> {
  const cluster = currentCluster();
  // Sequential, not Promise.all: the DB is reached through a single pooled connection (Supabase
  // transaction pooler, connection_limit=1), so firing these concurrently just queues them on that
  // one connection anyway and risks tripping the pool's connection-checkout timeout under load.
  // Awaiting one at a time matches the pattern used everywhere else in the app (see README "A note
  // on the connection pool").
  const nodes = await db.node.findMany({ where: { cluster } });
  const grouped = await db.replica.groupBy({
    by: ["nodeId", "status"],
    where: { node: { cluster } },
    _count: { _all: true },
  });

  const counts = new Map<string, NodeView["replicas"]>();
  for (const row of grouped) {
    const entry =
      counts.get(row.nodeId) ?? { total: 0, synced: 0, corrupted: 0, missing: 0, stale: 0, repairing: 0 };
    const n = row._count._all;
    entry.total += n;
    if (row.status === "SYNCED") entry.synced += n;
    else if (row.status === "CORRUPTED") entry.corrupted += n;
    else if (row.status === "MISSING") entry.missing += n;
    else if (row.status === "STALE") entry.stale += n;
    else if (row.status === "REPAIRING") entry.repairing += n;
    counts.set(row.nodeId, entry);
  }

  return nodes.sort(compareNodeNames).map((node) => ({
    id: node.id,
    name: node.name,
    status: node.status,
    available: isNodeAvailable(node),
    isCrashed: node.isCrashed,
    isPartitioned: node.isPartitioned,
    flakyDisk: node.isCorrupting,
    baseUrl: node.baseUrl,
    backedBy: node.baseUrl ? "http" : "simulated",
    failureDomain: failureDomainForNode(node.name),
    lastHeartbeat: node.lastHeartbeat.toISOString(),
    heartbeatAgeMs: Math.max(0, now.getTime() - node.lastHeartbeat.getTime()),
    replicas:
      counts.get(node.id) ?? { total: 0, synced: 0, corrupted: 0, missing: 0, stale: 0, repairing: 0 },
  }));
}

// A node "checks in". Crashed or partitioned nodes cannot deliver a heartbeat.
export async function updateHeartbeat(idOrName: string) {
  const node = await resolveNode(idOrName);
  if (node.isCrashed) throw new NodeUnavailableError(node.name, "node process is crashed");
  if (node.isPartitioned) {
    throw new NodeUnavailableError(node.name, "network partition: heartbeat not delivered");
  }
  const wasDown = node.status !== "HEALTHY";
  const updated = await db.node.update({
    where: { id: node.id },
    data: { lastHeartbeat: new Date(), status: "HEALTHY" },
  });
  if (wasDown) {
    emit("node.recovered", `Node ${node.name} is heartbeating again (HEALTHY)`, {
      level: "success",
      data: { node: node.name },
    });
  }
  return updated;
}

// CHAOS: the node process dies. Its stored data is untouched (a crash is not data loss).
export async function killNode(idOrName: string) {
  const node = await resolveNode(idOrName);
  const updated = await db.node.update({
    where: { id: node.id },
    data: { isCrashed: true, status: "OFFLINE" },
  });
  await logChaos("KILL_NODE", `Node ${node.name} crashed (OFFLINE)`, { nodeId: node.id });
  emit("node.killed", `Node ${node.name} crashed`, { level: "error", data: { node: node.name } });
  return updated;
}

// The crashed node's process restarts. Data is intact; replicas become reachable again.
export async function reviveNode(idOrName: string) {
  const node = await resolveNode(idOrName);
  const updated = await db.node.update({
    where: { id: node.id },
    data: { isCrashed: false, status: "HEALTHY", lastHeartbeat: new Date() },
  });
  await logChaos("REVIVE_NODE", `Node ${node.name} restarted (HEALTHY)`, { nodeId: node.id });
  emit("node.revived", `Node ${node.name} restarted`, { level: "success", data: { node: node.name } });
  return updated;
}

// CHAOS: cut (value=true) or heal (value=false) the node's network link. The process stays alive.
export async function setPartitioned(idOrName: string, value: boolean) {
  const node = await resolveNode(idOrName);
  const data: { isPartitioned: boolean; status?: "HEALTHY"; lastHeartbeat?: Date } = {
    isPartitioned: value,
  };
  if (!value && !node.isCrashed) {
    // Link restored: the live node reconnects and heartbeats immediately.
    data.status = "HEALTHY";
    data.lastHeartbeat = new Date();
  }
  const updated = await db.node.update({ where: { id: node.id }, data });
  if (value) {
    await logChaos("PARTITION_NODE", `Node ${node.name} partitioned from the coordinator`, {
      nodeId: node.id,
    });
    emit("node.partitioned", `Node ${node.name} partitioned`, { level: "warn", data: { node: node.name } });
  } else {
    await logChaos("HEAL_PARTITION", `Partition around ${node.name} healed`, { nodeId: node.id });
    emit("node.healed", `Partition around ${node.name} healed`, {
      level: "success",
      data: { node: node.name },
    });
  }
  return updated;
}

// CHAOS: flaky disk — the node silently damages every byte-stream it stores from now on.
// (Corrupting data that is ALREADY stored is chaos.ts → corruptReplica.)
export async function setFlakyDisk(idOrName: string, value: boolean) {
  const node = await resolveNode(idOrName);
  const updated = await db.node.update({ where: { id: node.id }, data: { isCorrupting: value } });
  await logChaos("CORRUPT_CHUNK", `Flaky disk on ${node.name} set to ${value}`, { nodeId: node.id });
  emit("node.flaky_disk", `Flaky disk on ${node.name}: ${value ? "ON" : "OFF"}`, {
    level: value ? "warn" : "info",
    data: { node: node.name, value },
  });
  return updated;
}