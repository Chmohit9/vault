// src/lib/metadata/readCoordinator.ts
// Read path: for each chunk, try its replicas (best candidates first), verify SHA-256 against the
// checksum recorded in metadata at write time, and fall back to the next replica on a mismatch or an
// unreachable node. A checksum-invalid replica is never counted as a successful read, and it is marked
// CORRUPTED in the DB the moment it's caught (read-repair) so the repair subsystem can fix it later.

import { db } from "@/lib/db";
import { currentCluster } from "@/config/policy";
import { NotFoundError, QuorumError } from "@/lib/errors";
import { emit } from "@/lib/events/bus";
import { computeChecksum } from "@/lib/integrity/checksum";
import { getStorageNode } from "@/lib/storage/storageNode";
import { isNodeAvailable } from "@/lib/nodes/availability";

export interface ChunkReadReport {
  index: number;
  servedByNode: string;
  replicasAvailable: number;
  replicasAttempted: number;
  corruptedFound: string[];
}

export interface GetObjectResult {
  key: string;
  version: number;
  size: number;
  contentType: string | null;
  checksum: string;
  data: Buffer;
  chunkReport: ChunkReadReport[];
}

export async function getObjectMeta(key: string) {
  const cluster = currentCluster();
  const object = await db.storedObject.findUnique({
    where: { cluster_key: { cluster, key } },
    include: { chunks: { orderBy: { index: "asc" }, include: { replicas: { include: { node: true } } } } },
  });
  if (!object) throw new NotFoundError(`Object not found: ${key}`);
  return object;
}

export async function listObjects() {
  const cluster = currentCluster();
  const objects = await db.storedObject.findMany({
    where: { cluster },
    orderBy: { key: "asc" },
    include: { _count: { select: { chunks: true } } },
  });
  return objects.map((o) => ({
    key: o.key,
    size: o.size,
    version: o.version,
    contentType: o.contentType,
    checksum: o.checksum,
    replicationFactor: o.replicationFactor,
    writeQuorum: o.writeQuorum,
    readQuorum: o.readQuorum,
    chunkCount: o._count.chunks,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  }));
}

export async function getObject(key: string): Promise<GetObjectResult> {
  const object = await getObjectMeta(key);
  const parts: Buffer[] = [];
  const chunkReport: ChunkReadReport[] = [];

  for (const chunk of object.chunks) {
    const candidates = [...chunk.replicas]
      .filter((r) => isNodeAvailable(r.node))
      .sort((a, b) => {
        const rank = (status: string) => (status === "SYNCED" ? 0 : status === "STALE" ? 1 : 2);
        const byStatus = rank(a.status) - rank(b.status);
        if (byStatus !== 0) return byStatus;
        return (b.lastVerifiedAt?.getTime() ?? 0) - (a.lastVerifiedAt?.getTime() ?? 0);
      });

    if (candidates.length === 0) {
      emit("read.no_replicas", `No available replica for ${key} chunk ${chunk.index}`, {
        level: "error",
        data: { key, chunkIndex: chunk.index },
      });
      throw new QuorumError(`No available replica for ${key} chunk ${chunk.index}: every holder is unreachable`, {
        key,
        chunkIndex: chunk.index,
      });
    }

    if (candidates.length < object.readQuorum) {
      emit(
        "read.quorum_failed",
        `Read quorum unavailable for ${key} chunk ${chunk.index}: ${candidates.length}/${object.readQuorum} replicas reachable`,
        { level: "error", data: { key, chunkIndex: chunk.index, available: candidates.length, readQuorum: object.readQuorum } }
      );
      throw new QuorumError(
        `${key} chunk ${chunk.index}: read quorum ${object.readQuorum} cannot be reached (${candidates.length} reachable)`,
        { key, chunkIndex: chunk.index, available: candidates.length, readQuorum: object.readQuorum }
      );
    }

        let resolved: { data: Buffer; nodeName: string } | null = null;
    const corruptedFound: string[] = [];
    let attempted = 0;
    let validResponses = 0;

    // Deliberately check EVERY available replica, not just until the first success: a read is also
    // this chunk's integrity check, and a corrupted replica ranked ahead of a healthy one must still
    // be caught even though the read itself will succeed from the healthy one.
    for (const replica of candidates) {
      attempted++;
      const sim = getStorageNode(replica.node);
      let bytes: Buffer;
      try {
        bytes = await sim.get(replica.storageKey);
      } catch {
        continue; // unreachable mid-read, or bytes missing — try the next candidate
      }

      const actualChecksum = computeChecksum(bytes);
      if (actualChecksum === chunk.checksum) {
        validResponses++;
        if (!resolved) {
          resolved = { data: bytes, nodeName: replica.node.name };
        }
        if (replica.status !== "SYNCED" || !replica.lastVerifiedAt) {
          await db.replica.update({
            where: { id: replica.id },
            data: { status: "SYNCED", lastVerifiedAt: new Date() },
          });
        }
        continue;
      }

      corruptedFound.push(replica.node.name);
      if (replica.status !== "CORRUPTED") {
        await db.replica.update({ where: { id: replica.id }, data: { status: "CORRUPTED" } });
        emit(
          "replica.checksum_mismatch",
          `Checksum mismatch for ${key} chunk ${chunk.index} on ${replica.node.name}`,
          { level: "error", data: { key, chunkIndex: chunk.index, node: replica.node.name } }
        );
      }
    }

    if (!resolved || validResponses < object.readQuorum) {
      throw new QuorumError(
        `${key} chunk ${chunk.index}: read quorum ${object.readQuorum} was not satisfied (${validResponses} valid responses)`,
        { key, chunkIndex: chunk.index, attempted, validResponses, readQuorum: object.readQuorum, corrupted: corruptedFound }
      );
    }

    chunkReport.push({
      index: chunk.index,
      servedByNode: resolved.nodeName,
      replicasAvailable: candidates.length,
      replicasAttempted: attempted,
      corruptedFound,
    });
    parts.push(resolved.data);
  }

  const data = Buffer.concat(parts);
  const wholeChecksum = computeChecksum(data);
  if (wholeChecksum !== object.checksum) {
    // Shouldn't happen if every chunk matched its own canonical checksum — this catches a framing bug
    // rather than silently returning the wrong bytes.
    throw new QuorumError(`Reconstructed object ${key} failed whole-object checksum verification`, { key });
  }

  emit("object.read", `Read ${key} v${object.version} (${object.chunks.length} chunk(s))`, {
    level: chunkReport.some((c) => c.corruptedFound.length > 0) ? "warn" : "info",
    data: { key, version: object.version },
  });

  return {
    key: object.key,
    version: object.version,
    size: object.size,
    contentType: object.contentType,
    checksum: object.checksum,
    data,
    chunkReport,
  };
}