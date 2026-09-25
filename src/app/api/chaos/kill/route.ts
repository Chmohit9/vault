// src/app/api/chaos/kill/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { killNode } from "@/lib/nodes/registry";
import { fail, ok, readJson } from "@/lib/http";

const schema = z.object({ nodeId: z.string().min(1) }); // node id or name

export async function POST(req: NextRequest) {
  try {
    const { nodeId } = schema.parse(await readJson(req));
    const node = await killNode(nodeId);
    return ok({ node, message: `Node ${node.name} crashed (OFFLINE)` });
  } catch (err) {
    return fail(err);
  }
}