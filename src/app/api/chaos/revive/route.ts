// src/app/api/chaos/revive/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { reviveNode } from "@/lib/nodes/registry";
import { fail, ok, readJson } from "@/lib/http";

const schema = z.object({ nodeId: z.string().min(1) });

export async function POST(req: NextRequest) {
  try {
    const { nodeId } = schema.parse(await readJson(req));
    const node = await reviveNode(nodeId);
    return ok({ node, message: `Node ${node.name} restarted (HEALTHY)` });
  } catch (err) {
    return fail(err);
  }
}