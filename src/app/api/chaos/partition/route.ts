// src/app/api/chaos/partition/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { setPartitioned } from "@/lib/nodes/registry";
import { fail, ok, readJson } from "@/lib/http";

const schema = z.object({ nodeId: z.string().min(1), value: z.boolean().default(true) });

export async function POST(req: NextRequest) {
  try {
    const { nodeId, value } = schema.parse(await readJson(req));
    const node = await setPartitioned(nodeId, value);
    return ok({
      node,
      message: value ? `Node ${node.name} partitioned` : `Partition around ${node.name} healed`,
    });
  } catch (err) {
    return fail(err);
  }
}