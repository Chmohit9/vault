// src/app/api/repair/run/route.ts
import { repairCluster } from "@/lib/repair/repairEngine";
import { fail, ok } from "@/lib/http";

export async function POST() {
  try {
    return ok({ ...(await repairCluster()) });
  } catch (err) {
    return fail(err);
  }
}