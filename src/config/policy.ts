// src/config/policy.ts

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ReplicationPolicy {
  replicationFactor: number;
  writeQuorum: number;
  readQuorum: number;
  minHealthyReplicas: number;
  allowTemporaryOverReplication: boolean;
}

export const MAX_REPLICATION_FACTOR = 9;

export const DEFAULT_POLICY: ReplicationPolicy = {
  replicationFactor: intEnv("VAULT_N", 3),
  writeQuorum: intEnv("VAULT_W", 2),
  readQuorum: intEnv("VAULT_R", 2),
  minHealthyReplicas: intEnv("VAULT_MIN_HEALTHY_REPLICAS", 2),
  allowTemporaryOverReplication: (process.env.VAULT_ALLOW_TEMP_OVERREPLICATION ?? "on").toLowerCase() === "on",
};

export function validatePolicy(p: ReplicationPolicy): string | null {
  const values = [
    ["replicationFactor", p.replicationFactor],
    ["writeQuorum", p.writeQuorum],
    ["readQuorum", p.readQuorum],
    ["minHealthyReplicas", p.minHealthyReplicas],
  ] as const;
  for (const [label, v] of values) {
    if (!Number.isInteger(v) || v < 1) return `${label} must be a positive integer`;
  }
  if (p.replicationFactor > MAX_REPLICATION_FACTOR) {
    return `replicationFactor cannot exceed ${MAX_REPLICATION_FACTOR}`;
  }
  if (p.writeQuorum > p.replicationFactor) {
    return `writeQuorum (${p.writeQuorum}) cannot exceed replicationFactor (${p.replicationFactor})`;
  }
  if (p.readQuorum > p.replicationFactor) {
    return `readQuorum (${p.readQuorum}) cannot exceed replicationFactor (${p.replicationFactor})`;
  }
  if (p.minHealthyReplicas > p.replicationFactor) {
    return `minHealthyReplicas (${p.minHealthyReplicas}) cannot exceed replicationFactor (${p.replicationFactor})`;
  }
  return null;
}

export function isStrongQuorum(p: ReplicationPolicy): boolean {
  return p.readQuorum + p.writeQuorum > p.replicationFactor;
}

export function requiredWriteAcks(p: ReplicationPolicy): number {
  return Math.max(p.writeQuorum, p.minHealthyReplicas);
}

export interface FailureDomainConfig {
  [nodeName: string]: string;
}

function configuredFailureDomains(): FailureDomainConfig {
  const raw = process.env.VAULT_FAILURE_DOMAINS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: FailureDomainConfig = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) {
        result[key] = value.trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function failureDomainForNode(nodeName: string): string {
  const configured = configuredFailureDomains()[nodeName];
  if (configured) return configured;

  const match = nodeName.match(/(\d+)$/);
  if (match) return Number.parseInt(match[1], 10) <= 3 ? "rack-a" : "rack-b";
  return "domain-default";
}

export function effectiveReplicaStatus(replica: {
  status: string;
  version: number;
  node: { status: string; isPartitioned: boolean; isCrashed: boolean };
}, objectVersion: number): "SYNCED" | "STALE" | "CORRUPTED" | "MISSING" | "REPAIRING" | "UNREACHABLE" {
  if (replica.node.isCrashed || replica.node.isPartitioned || replica.node.status === "OFFLINE") {
    return "UNREACHABLE";
  }
  if (replica.status === "SYNCED" && replica.version !== objectVersion) return "STALE";
  return replica.status as "SYNCED" | "STALE" | "CORRUPTED" | "MISSING" | "REPAIRING";
}

export const CHUNK_SIZE_BYTES = intEnv("VAULT_CHUNK_SIZE_BYTES", 4 * 1024 * 1024);
export const MAX_OBJECT_BYTES = intEnv("VAULT_MAX_OBJECT_BYTES", 25 * 1024 * 1024);
export const HEARTBEAT_INTERVAL_MS = intEnv("VAULT_HEARTBEAT_INTERVAL_MS", 5_000);
export const HEARTBEAT_TIMEOUT_MS = intEnv("VAULT_HEARTBEAT_TIMEOUT_MS", 15_000);
export const REPAIR_INTERVAL_MS = intEnv("VAULT_REPAIR_INTERVAL_MS", 15_000);
export const SCRUB_INTERVAL_MS = intEnv("VAULT_SCRUB_INTERVAL_MS", 60_000);
export const SCRUB_BATCH_SIZE = intEnv("VAULT_SCRUB_BATCH_SIZE", 40);

export function autopilotDefault(): boolean {
  return (process.env.VAULT_AUTOPILOT ?? "off").toLowerCase() === "on";
}

export function currentCluster(): string {
  return process.env.VAULT_CLUSTER || "main";
}
