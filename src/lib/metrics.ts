import { db } from "@/lib/db";
import { currentCluster, DEFAULT_POLICY, failureDomainForNode } from "@/config/policy";
import { isNodeAvailable } from "@/lib/nodes/availability";

interface TimingState {
  repairCount: number;
  repairDurationSumMs: number;
  repairDurationLastMs: number;
  recoveryCount: number;
  recoveryDurationSumMs: number;
  recoveryDurationLastMs: number;
  firstBrokenAt: Map<string, number>;
}

const g = globalThis as unknown as { __vaultMetrics?: TimingState };
function state(): TimingState {
  if (!g.__vaultMetrics) {
    g.__vaultMetrics = { repairCount: 0, repairDurationSumMs: 0, repairDurationLastMs: 0, recoveryCount: 0, recoveryDurationSumMs: 0, recoveryDurationLastMs: 0, firstBrokenAt: new Map() };
  }
  return g.__vaultMetrics;
}

export function markReplicaBroken(replicaId: string) {
  const s = state();
  if (!s.firstBrokenAt.has(replicaId)) s.firstBrokenAt.set(replicaId, Date.now());
}

export function recordReplicaRecovered(replicaId: string) {
  const s = state();
  const started = s.firstBrokenAt.get(replicaId);
  if (started === undefined) return;
  const duration = Math.max(0, Date.now() - started);
  s.recoveryCount += 1;
  s.recoveryDurationSumMs += duration;
  s.recoveryDurationLastMs = duration;
  s.firstBrokenAt.delete(replicaId);
}

export function recordRepairDuration(durationMs: number) {
  const s = state();
  const duration = Math.max(0, durationMs);
  s.repairCount += 1;
  s.repairDurationSumMs += duration;
  s.repairDurationLastMs = duration;
}

function esc(value: string) { return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n"); }
function labels(values: Record<string, string>) {
  const entries = Object.entries(values);
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}` : "";
}
function metric(name: string, value: number, values: Record<string, string> = {}) {
  return `${name}${labels(values)} ${Number.isFinite(value) ? value : 0}`;
}

export async function collectPrometheusMetrics(): Promise<string> {
  const cluster = currentCluster();
  const now = Date.now();
  const s = state();
  const objects = await db.storedObject.findMany({ where: { cluster }, select: { size: true } });
  const chunks = await db.chunk.findMany({ where: { object: { cluster } }, select: { id: true, size: true } });
  const replicas = await db.replica.findMany({ where: { chunk: { object: { cluster } } }, select: { chunkId: true, status: true } });
  const nodes = await db.node.findMany({ where: { cluster } });
  const repairs = await db.repairLog.findMany({ where: { cluster, createdAt: { gte: new Date(now - 86400000) } }, select: { type: true, success: true } });

  const logicalBytes = objects.reduce((sum, row) => sum + row.size, 0);
  const chunkSize = new Map(chunks.map((row) => [row.id, row.size]));
  const replicatedBytes = replicas.reduce((sum, row) => sum + (chunkSize.get(row.chunkId) ?? 0), 0);
  const statusCounts = new Map<string, number>();
  for (const row of replicas) statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  const repairCounts = new Map<string, number>();
  let repairSuccess = 0;
  for (const row of repairs) {
    repairCounts.set(row.type, (repairCounts.get(row.type) ?? 0) + 1);
    if (row.success) repairSuccess += 1;
  }

  const lines = [
    "# HELP vault_objects_total Number of stored objects.", "# TYPE vault_objects_total gauge", metric("vault_objects_total", objects.length),
    "# HELP vault_chunks_total Number of stored chunks.", "# TYPE vault_chunks_total gauge", metric("vault_chunks_total", chunks.length),
    "# HELP vault_logical_bytes_total Logical object bytes.", "# TYPE vault_logical_bytes_total gauge", metric("vault_logical_bytes_total", logicalBytes),
    "# HELP vault_replicated_bytes_total Bytes represented by all replica copies.", "# TYPE vault_replicated_bytes_total gauge", metric("vault_replicated_bytes_total", replicatedBytes),
    "# HELP vault_storage_overhead_ratio Replica bytes divided by logical bytes.", "# TYPE vault_storage_overhead_ratio gauge", metric("vault_storage_overhead_ratio", logicalBytes ? replicatedBytes / logicalBytes : 0),
    "# HELP vault_replica_rows_total Replica metadata rows.", "# TYPE vault_replica_rows_total gauge", metric("vault_replica_rows_total", replicas.length),
    "# HELP vault_replica_status_total Replica rows by status.", "# TYPE vault_replica_status_total gauge",
  ];
  for (const status of ["SYNCED", "STALE", "CORRUPTED", "MISSING", "REPAIRING"]) lines.push(metric("vault_replica_status_total", statusCounts.get(status) ?? 0, { status }));
  lines.push(
    "# HELP vault_config_replication_factor Configured replication factor.", "# TYPE vault_config_replication_factor gauge", metric("vault_config_replication_factor", DEFAULT_POLICY.replicationFactor),
    "# HELP vault_config_write_quorum Configured write quorum.", "# TYPE vault_config_write_quorum gauge", metric("vault_config_write_quorum", DEFAULT_POLICY.writeQuorum),
    "# HELP vault_config_read_quorum Configured read quorum.", "# TYPE vault_config_read_quorum gauge", metric("vault_config_read_quorum", DEFAULT_POLICY.readQuorum),
    "# HELP vault_repair_events_24h_total Repair log events in the last 24 hours.", "# TYPE vault_repair_events_24h_total gauge", metric("vault_repair_events_24h_total", repairs.length),
    "# HELP vault_repair_events_24h_success_total Successful repair log events in the last 24 hours.", "# TYPE vault_repair_events_24h_success_total gauge", metric("vault_repair_events_24h_success_total", repairSuccess),
    "# HELP vault_repair_events_24h_by_type Repair log events by type.", "# TYPE vault_repair_events_24h_by_type gauge",
  );
  for (const type of ["REPLICA_REPAIR", "SCRUB", "REBALANCE", "NODE_FAILOVER"]) lines.push(metric("vault_repair_events_24h_by_type", repairCounts.get(type) ?? 0, { type }));
  lines.push(
    "# HELP vault_repair_duration_seconds_last Last repair-cycle duration.", "# TYPE vault_repair_duration_seconds_last gauge", metric("vault_repair_duration_seconds_last", s.repairDurationLastMs / 1000),
    "# HELP vault_repair_duration_seconds_sum Sum of repair-cycle durations in this process.", "# TYPE vault_repair_duration_seconds_sum counter", metric("vault_repair_duration_seconds_sum", s.repairDurationSumMs / 1000),
    "# HELP vault_repair_duration_cycles_total Timed repair cycles in this process.", "# TYPE vault_repair_duration_cycles_total counter", metric("vault_repair_duration_cycles_total", s.repairCount),
    "# HELP vault_recovery_time_seconds_last Last broken-replica detection-to-repair duration.", "# TYPE vault_recovery_time_seconds_last gauge", metric("vault_recovery_time_seconds_last", s.recoveryDurationLastMs / 1000),
    "# HELP vault_recovery_time_seconds_sum Sum of detection-to-repair durations in this process.", "# TYPE vault_recovery_time_seconds_sum counter", metric("vault_recovery_time_seconds_sum", s.recoveryDurationSumMs / 1000),
    "# HELP vault_recoveries_total Successful broken-replica recoveries in this process.", "# TYPE vault_recoveries_total counter", metric("vault_recoveries_total", s.recoveryCount),
  );
  for (const node of nodes) {
    lines.push(metric("vault_node_available", isNodeAvailable(node) ? 1 : 0, { node: node.name, failure_domain: failureDomainForNode(node.name) }));
    lines.push(metric("vault_node_heartbeat_age_seconds", Math.max(0, now - node.lastHeartbeat.getTime()) / 1000, { node: node.name }));
  }
  return `${lines.join("\n")}\n`;
}
