// src/app/api/chaos/corrupt/route.ts
// Corrupts the stored bytes of an EXISTING replica.
//   { "replicaId": "..." }
//   { "objectKey": "report.txt", "chunkIndex": 0, "nodeId": "node-2" }   (chunkIndex/nodeId optional)
import { NextRequest } from "next/server";
import { z } from "zod";
import { corruptReplica } from "@/lib/nodes/chaos";
import { fail, ok, readJson } from "@/lib/http";

const schema = z
  .object({
    replicaId: z.string().min(1).optional(),
    objectKey: z.string().min(1).optional(),
    chunkIndex: z.number().int().min(0).optional(),
    nodeId: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.replicaId || v.objectKey), {
    message: "Provide replicaId, or objectKey (optionally with chunkIndex and nodeId)",
  });

export async function POST(req: NextRequest) {
  try {
    const input = schema.parse(await readJson(req));
    const result = await corruptReplica(input);
    return ok({
      corruption: result,
      message: `Corrupted ${result.objectKey} chunk ${result.chunkIndex} on ${result.node}`,
    });
  } catch (err) {
    return fail(err);
  }
}