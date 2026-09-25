// src/app/api/nodes/[id]/route.ts
import { NextRequest } from "next/server";
import { listNodesWithStats } from "@/lib/nodes/registry";
import { NotFoundError } from "@/lib/errors";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const node = (await listNodesWithStats()).find((n) => n.id === id || n.name === id);
    if (!node) throw new NotFoundError(`Node not found: ${id}`);
    return ok({ node });
  } catch (err) {
    return fail(err);
  }
}