// src/app/api/nodes/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { createNode, listNodesWithStats } from "@/lib/nodes/registry";
import { fail, ok, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok({ nodes: await listNodesWithStats() });
  } catch (err) {
    return fail(err);
  }
}

// Add a node to the cluster (used by the "add node" demo step; rebalance then uses it).
export async function POST(req: NextRequest) {
  try {
    const { name, baseUrl } = z
      .object({ name: z.string().min(1), baseUrl: z.string().url().nullish() })
      .parse(await readJson(req));
    const node = await createNode(name, baseUrl);
    return ok({ node }, 201);
  } catch (err) {
    return fail(err);
  }
}