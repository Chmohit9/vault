// src/app/api/health/route.ts

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  // Sequential, not Promise.all: the DB is reached through a single pooled connection (Supabase
  // transaction pooler, connection_limit=1), so firing these concurrently just queues them all on
  // that one connection anyway — and under load (autopilot's own tick, chaos actions, etc.) that
  // queueing can run long enough to trip the pool's connection-checkout timeout. Awaiting one at a
  // time keeps at most one query from this route in flight, matching the pattern used everywhere
  // else in the app (see README "A note on the connection pool").
  const totalNodes = await db.node.count();
  const healthyNodes = await db.node.count({ where: { status: "HEALTHY" } });
  const totalObjects = await db.storedObject.count();
  const corruptedReplicas = await db.replica.count({ where: { status: "CORRUPTED" } });

  return NextResponse.json({
    status: "ok",
    totalNodes,
    healthyNodes,
    totalObjects,
    corruptedReplicas,
  });
}