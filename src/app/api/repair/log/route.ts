// src/app/api/repair/log/route.ts
// Recent RepairLog entries for the current cluster — feeds the dashboard's repair/event feed later.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { currentCluster } from "@/config/policy";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const raw = Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10);
    const limit = Math.min(200, Math.max(1, Number.isFinite(raw) ? raw : 50));
    const logs = await db.repairLog.findMany({
      where: { cluster: currentCluster() },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return ok({ logs: logs.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })) });
  } catch (err) {
    return fail(err);
  }
}