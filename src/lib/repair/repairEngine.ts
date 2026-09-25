// src/lib/repair/repairEngine.ts
// Repairs CORRUPTED, MISSING, STALE and effectively-unreachable replicas by copying verified bytes
// from a current, healthy source. Unreachable nodes are retried after they recover.

import { db } from "@/lib/db";
import { currentCluster } from "@/config/policy";
import { emit } from "@/lib/events/bus";
import { computeChecksum } from "@/lib/integrity/checksum";
import { getStorageNode } from "@/lib/storage/storageNode";
import { isNodeAvailable } from "@/lib/nodes/availability";
import { logRepair } from "./log";
import { markReplicaBroken, recordReplicaRecovered, recordRepairDuration } from "@/lib/metrics";

export interface RepairResult {
  chunksExamined: number;
  replicasRepaired: string[];
  replicasSkipped: string[];
}

export async function repairCluster(limit = 200): Promise<RepairResult> {
  const cluster = currentCluster();

  const brokenReplicas = await db.replica.findMany({
    where: {
      status: { in: ["CORRUPTED", "MISSING", "STALE"] },
      chunk: { object: { cluster } },
    },
    take: limit,
    include: {
      chunk: { include: { object: true, replicas: { include: { node: true } } } },
      node: true,
    },
  });

  const cycleStartedAt = Date.now();
  const repaired: string[] = [];
  const skipped: string[] = [];
  const examinedChunkIds = new Set<string>();

  for (const broken of brokenReplicas) {
    examinedChunkIds.add(broken.chunkId);
    markReplicaBroken(broken.id);
    const label = `${broken.chunk.object.key}#${broken.chunk.index}@${broken.node.name}`;

    if (!isNodeAvailable(broken.node)) {
      skipped.push(label);
      continue;
    }

    // Only a current-version, SYNCED replica can be a repair source. This prevents a stale or
    // corrupted replica from propagating its inconsistency to other nodes.
    const source = broken.chunk.replicas.find(
      (r) =>
        r.id !== broken.id &&
        r.status === "SYNCED" &&
        r.version === broken.chunk.object.version &&
        isNodeAvailable(r.node)
    );
    if (!source) {
      skipped.push(label);
      await logRepair("REPLICA_REPAIR", `No current healthy source available to repair ${label}`, false, {
        objectKey: broken.chunk.object.key,
        chunkId: broken.chunkId,
        nodeId: broken.nodeId,
      });
      continue;
    }

    try {
      const sourceSim = getStorageNode(source.node);
      const bytes = await sourceSim.get(source.storageKey);
      if (computeChecksum(bytes) !== broken.chunk.checksum) {
        skipped.push(label);
        await logRepair(
          "REPLICA_REPAIR",
          `Source ${source.node.name} failed checksum verification while repairing ${label}`,
          false,
          { objectKey: broken.chunk.object.key, chunkId: broken.chunkId, nodeId: broken.nodeId }
        );
        continue;
      }

      const targetSim = getStorageNode(broken.node);
      await db.replica.update({ where: { id: broken.id }, data: { status: "REPAIRING" } });
      await targetSim.put(broken.storageKey, bytes);

      const written = await targetSim.get(broken.storageKey);
      const writtenChecksum = computeChecksum(written);
      if (writtenChecksum !== broken.chunk.checksum) {
        skipped.push(label);
        await db.replica.update({ where: { id: broken.id }, data: { status: "CORRUPTED" } });
        await logRepair(
          "REPLICA_REPAIR",
          `Repair write for ${label} failed verification (target disk may be flaky)`,
          false,
          { objectKey: broken.chunk.object.key, chunkId: broken.chunkId, nodeId: broken.nodeId }
        );
        continue;
      }

      await db.replica.update({
        where: { id: broken.id },
        data: {
          status: "SYNCED",
          checksum: writtenChecksum,
          version: broken.chunk.object.version,
          lastVerifiedAt: new Date(),
        },
      });

      repaired.push(label);
      recordReplicaRecovered(broken.id);
      await logRepair("REPLICA_REPAIR", `Repaired ${label} from ${source.node.name}`, true, {
        objectKey: broken.chunk.object.key,
        chunkId: broken.chunkId,
        nodeId: broken.nodeId,
      });
      emit("replica.repaired", `Repaired ${label} from ${source.node.name}`, {
        level: "success",
        data: {
          key: broken.chunk.object.key,
          chunkIndex: broken.chunk.index,
          node: broken.node.name,
          source: source.node.name,
          previousStatus: broken.status,
        },
      });
    } catch (err) {
      skipped.push(label);
      await db.replica.update({ where: { id: broken.id }, data: { status: broken.status } }).catch(() => undefined);
      await logRepair(
        "REPLICA_REPAIR",
        `Repair attempt failed for ${label}: ${err instanceof Error ? err.message : String(err)}`,
        false,
        { objectKey: broken.chunk.object.key, chunkId: broken.chunkId, nodeId: broken.nodeId }
      );
    }
  }

  if (repaired.length > 0 || skipped.length > 0) {
    emit("repair.cycle_completed", `Repair cycle: ${repaired.length} repaired, ${skipped.length} skipped`, {
      level: skipped.length > 0 ? "warn" : "info",
      data: { repaired: repaired.length, skipped: skipped.length },
    });
  }

  recordRepairDuration(Date.now() - cycleStartedAt);

  return { chunksExamined: examinedChunkIds.size, replicasRepaired: repaired, replicasSkipped: skipped };
}
