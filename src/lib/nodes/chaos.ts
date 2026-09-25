// src/lib/nodes/chaos.ts
// Real corruption of an EXISTING replica.

import { db } from "@/lib/db";
import { currentCluster } from "@/config/policy";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { emit } from "@/lib/events/bus";
import { getStorageNode } from "@/lib/storage/storageNode";
import { isNodeAvailable } from "./availability";
import { logChaos, resolveNode } from "./registry";

export interface CorruptReplicaInput {
  replicaId?: string;
  objectKey?: string;
  chunkIndex?: number; // default 0
  nodeId?: string; // id or name; if omitted, a SYNCED replica on a reachable node is chosen
}

export async function corruptReplica(input: CorruptReplicaInput) {
  const cluster = currentCluster();
  let replicaId = input.replicaId;

  if (!replicaId) {
    if (!input.objectKey) {
      throw new ValidationError("Provide replicaId, or objectKey (optionally chunkIndex and nodeId)");
    }
    const object = await db.storedObject.findUnique({
      where: { cluster_key: { cluster, key: input.objectKey } },
    });
    if (!object) throw new NotFoundError(`Object not found: ${input.objectKey}`);

    const chunk = await db.chunk.findUnique({
      where: { objectId_index: { objectId: object.id, index: input.chunkIndex ?? 0 } },
    });
    if (!chunk) throw new NotFoundError(`Chunk ${input.chunkIndex ?? 0} not found for ${input.objectKey}`);

    const candidates = await db.replica.findMany({
      where: { chunkId: chunk.id },
      include: { node: true },
    });

    let picked;
    if (input.nodeId) {
      const node = await resolveNode(input.nodeId);
      picked = candidates.find((r) => r.nodeId === node.id);
      if (!picked) throw new NotFoundError(`No replica of that chunk on node ${node.name}`);
    } else {
      const ranked = [...candidates].sort((a, b) => {
        const score = (r: (typeof candidates)[number]) =>
          (r.status === "SYNCED" ? 0 : 2) + (isNodeAvailable(r.node) ? 0 : 1);
        return score(a) - score(b);
      });
      picked = ranked[0];
      if (!picked) throw new NotFoundError("That chunk has no replicas to corrupt");
    }
    replicaId = picked.id;
  }

  const replica = await db.replica.findFirst({
    where: { id: replicaId, node: { cluster } },
    include: { node: true, chunk: { include: { object: true } } },
  });
  if (!replica) throw new NotFoundError(`Replica not found: ${replicaId}`);

  // Damage the bytes that are actually stored. Metadata is deliberately NOT updated:
  // silent corruption must be discovered by checksum verification (read or scrub).
  const sim = getStorageNode(replica.node);
  const damage = await sim.corruptExisting(replica.storageKey);

  const detail = `Corrupted stored bytes of ${replica.chunk.object.key} chunk ${replica.chunk.index} on ${replica.node.name}`;
  await logChaos("CORRUPT_CHUNK", detail, { nodeId: replica.nodeId, chunkId: replica.chunkId });
  emit("replica.corrupted", detail, {
    level: "warn",
    data: { object: replica.chunk.object.key, chunkIndex: replica.chunk.index, node: replica.node.name },
  });

  return {
    replicaId: replica.id,
    objectKey: replica.chunk.object.key,
    chunkIndex: replica.chunk.index,
    node: replica.node.name,
    storageKey: replica.storageKey,
    metadataStatusStillReports: replica.status,
    ...damage,
  };
}