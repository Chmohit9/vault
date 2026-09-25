// src/lib/repair/scrub.ts
// Verifies bytes and replica version against canonical chunk/object metadata.

import { db } from "@/lib/db";
import { currentCluster } from "@/config/policy";
import { emit } from "@/lib/events/bus";
import { computeChecksum } from "@/lib/integrity/checksum";
import { getStorageNode } from "@/lib/storage/storageNode";
import { isNodeAvailable } from "@/lib/nodes/availability";
import { logRepair } from "./log";

export interface ScrubResult {
  scanned: number;
  verifiedOk: number;
  newlyCorrupted: string[];
  stale: string[];
  unreachable: number;
}

export async function scrubCluster(limit = 500): Promise<ScrubResult> {
  const cluster = currentCluster();
  const replicas = await db.replica.findMany({
    where: { chunk: { object: { cluster } } },
    orderBy: { lastVerifiedAt: "asc" },
    take: limit,
    include: { chunk: { include: { object: true } }, node: true },
  });

  let verifiedOk = 0;
  let unreachable = 0;
  const newlyCorrupted: string[] = [];
  const stale: string[] = [];

  for (const replica of replicas) {
    const label = `${replica.chunk.object.key}#${replica.chunk.index}@${replica.node.name}`;

    if (!isNodeAvailable(replica.node)) {
      unreachable++;
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await getStorageNode(replica.node).get(replica.storageKey);
    } catch {
      unreachable++;
      if (replica.status !== "MISSING") {
        await db.replica.update({ where: { id: replica.id }, data: { status: "MISSING" } });
        await logRepair("SCRUB", `${label} is missing from storage`, false, {
          objectKey: replica.chunk.object.key,
          chunkId: replica.chunkId,
          nodeId: replica.nodeId,
        });
      }
      continue;
    }

    const checksumOk = computeChecksum(bytes) === replica.chunk.checksum;
    if (!checksumOk) {
      newlyCorrupted.push(label);
      if (replica.status !== "CORRUPTED") {
        await db.replica.update({ where: { id: replica.id }, data: { status: "CORRUPTED" } });
        emit("replica.checksum_mismatch", `Scrub found corruption: ${label}`, {
          level: "error",
          data: { key: replica.chunk.object.key, chunkIndex: replica.chunk.index, node: replica.node.name },
        });
      }
      await logRepair("SCRUB", `Scrub found corruption: ${label}`, false, {
        objectKey: replica.chunk.object.key,
        chunkId: replica.chunkId,
        nodeId: replica.nodeId,
      });
      continue;
    }

    if (replica.version !== replica.chunk.object.version) {
      stale.push(label);
      if (replica.status !== "STALE") {
        await db.replica.update({ where: { id: replica.id }, data: { status: "STALE" } });
        emit("replica.stale", `Scrub found stale replica: ${label}`, {
          level: "warn",
          data: {
            key: replica.chunk.object.key,
            chunkIndex: replica.chunk.index,
            node: replica.node.name,
            replicaVersion: replica.version,
            objectVersion: replica.chunk.object.version,
          },
        });
      }
      await logRepair("SCRUB", `Scrub found stale replica: ${label}`, false, {
        objectKey: replica.chunk.object.key,
        chunkId: replica.chunkId,
        nodeId: replica.nodeId,
      });
      continue;
    }

    verifiedOk++;
    await db.replica.update({
      where: { id: replica.id },
      data: { status: "SYNCED", lastVerifiedAt: new Date() },
    });
  }

  emit(
    "scrub.completed",
    `Scrub: ${replicas.length} scanned, ${verifiedOk} ok, ${newlyCorrupted.length} corrupted, ${stale.length} stale, ${unreachable} unreachable`,
    {
      level: newlyCorrupted.length > 0 || stale.length > 0 ? "warn" : "info",
      data: { scanned: replicas.length, verifiedOk, corrupted: newlyCorrupted.length, stale: stale.length, unreachable },
    }
  );

  return { scanned: replicas.length, verifiedOk, newlyCorrupted, stale, unreachable };
}
