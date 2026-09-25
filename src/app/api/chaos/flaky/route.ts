// src/app/api/chaos/flaky/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { setFlakyDisk } from "@/lib/nodes/registry";
import { fail, ok, readJson } from "@/lib/http";

const schema = z.object({ nodeId: z.string().min(1), value: z.boolean().default(true) });

export async function POST(req: NextRequest) {
  try {
    const { nodeId, value } = schema.parse(await readJson(req));
    const node = await setFlakyDisk(nodeId, value);
    return ok({ node, message: `Flaky disk on ${node.name}: ${value ? "ON" : "OFF"}` });
  } catch (err) {
    return fail(err);
  }
}