// src/types/index.ts

export type NodeHealth = "HEALTHY" | "OFFLINE" | "DEGRADED";

export interface NodeSummary {
  id: string;
  name: string;
  status: NodeHealth;
  isCorrupting: boolean;
  isPartitioned: boolean;
  lastHeartbeat: string;
}

export interface ObjectSummary {
  id: string;
  key: string;
  size: number;
  version: number;
  replicationFactor: number;
  writeQuorum: number;
  readQuorum: number;
}

export interface ReplicaSummary {
  id: string;
  chunkId: string;
  nodeId: string;
  status: "SYNCED" | "STALE" | "CORRUPTED" | "MISSING" | "REPAIRING";
  version: number;
}