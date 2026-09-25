// src/app/api/repair/rebalance/route.ts
import { rebalanceCluster } from "@/lib/repair/rebalance";
import { fail, ok } from "@/lib/http";

export async function POST() {
  try {
    return ok({ ...(await rebalanceCluster()) });
  } catch (err) {
    return fail(err);
  }
}