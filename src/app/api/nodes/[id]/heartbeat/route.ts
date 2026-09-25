// src/app/api/nodes/[id]/heartbeat/route.ts
import { NextRequest } from "next/server";
import { updateHeartbeat } from "@/lib/nodes/registry";
import { fail, ok } from "@/lib/http";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const node = await updateHeartbeat(id);
    return ok({ node });
  } catch (err) {
    return fail(err);
  }
}