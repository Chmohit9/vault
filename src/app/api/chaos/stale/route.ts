// POST /api/chaos/stale
// Deliberately marks one replica as an older logical version without touching its bytes.
// Scrub/repair then demonstrates replica-version inconsistency detection and healing.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { currentCluster } from "@/config/policy";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { emit } from "@/lib/events/bus";
import { fail, ok, readJson } from "@/lib/http";

const schema = z.object({
  objectKey: z.string().min(1),
  chunkIndex: z.number().int().nonnegative().default(0),
  nodeId: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const input = schema.parse(await readJson(req));
    const cluster = currentCluster();
    const object = await db.storedObject.findUnique({
      where: { cluster_key: { cluster, key: input.objectKey } },
    });
    if (!object) throw new NotFoundError(`Object not found: ${input.objectKey}`);
    if (object.version <= 1) throw new ValidationError("Object must have version 2+ before a stale replica can be simulated");

    const chunk = await db.chunk.findUnique({
      where: { objectId_index: { objectId: object.id, index: input.chunkIndex } },
      include: { replicas: { include: { node: true } } },
    });
    if (!chunk) throw new NotFoundError(`Chunk ${input.chunkIndex} not found for ${input.objectKey}`);

    const candidates = chunk.replicas.filter((r) => r.status === "SYNCED" && !r.node.isCrashed && !r.node.isPartitioned);
    const replica = input.nodeId
      ? candidates.find((r) => r.nodeId === input.nodeId || r.node.name === input.nodeId)
      : candidates[0];
    if (!replica) throw new NotFoundError("No reachable SYNCED replica is available to mark stale");

    const staleVersion = Math.max(1, object.version - 1);
    const updated = await db.replica.update({
      where: { id: replica.id },
      data: { status: "STALE", version: staleVersion },
    });

    const detail = `Marked ${object.key} chunk ${chunk.index} on ${replica.node.name} stale: replica v${staleVersion}, object v${object.version}`;
    emit("replica.stale", detail, {
      level: "warn",
      data: { objectKey: object.key, chunkIndex: chunk.index, node: replica.node.name, staleVersion, objectVersion: object.version },
    });

    return ok({
      replicaId: updated.id,
      objectKey: object.key,
      chunkIndex: chunk.index,
      node: replica.node.name,
      replicaVersion: staleVersion,
      objectVersion: object.version,
      status: updated.status,
    });
  } catch (err) {
    return fail(err);
  }
}
