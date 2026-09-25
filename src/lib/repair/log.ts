// src/lib/repair/log.ts
// Shared RepairLog writer used by scrub, repair and (later) rebalance — one consistent audit trail
// for every self-healing action the cluster takes, success or failure.

import { db } from "@/lib/db";
import { currentCluster } from "@/config/policy";

export type RepairLogType = "REPLICA_REPAIR" | "SCRUB" | "REBALANCE" | "NODE_FAILOVER";

export async function logRepair(
  type: RepairLogType,
  detail: string,
  success: boolean,
  ref: { objectKey?: string; chunkId?: string; nodeId?: string } = {}
) {
  await db.repairLog.create({
    data: {
      cluster: currentCluster(),
      type,
      detail,
      success,
      objectKey: ref.objectKey ?? null,
      chunkId: ref.chunkId ?? null,
      nodeId: ref.nodeId ?? null,
    },
  });
}