// src/lib/nodes/availability.ts
// The single definition of "can the coordinator talk to this node right now?"

export interface NodeLike {
  id: string;
  name: string;
  backendPrefix: string;
  // Set only for nodes backed by a real HTTP storage-node service (apps/storage-node); null for
  // nodes still using the shared simulated backend. See src/lib/storage/storageNode.ts.
  baseUrl: string | null;
  status: "HEALTHY" | "OFFLINE" | "DEGRADED";
  isPartitioned: boolean;
  isCorrupting: boolean;
  isCrashed: boolean;
}

export function isNodeAvailable(
  n: Pick<NodeLike, "status" | "isPartitioned"> & { isCrashed?: boolean }
): boolean {
  return n.status !== "OFFLINE" && !n.isPartitioned && !n.isCrashed;
}

export function unavailableReason(
  n: Pick<NodeLike, "status" | "isPartitioned"> & { isCrashed?: boolean }
): string {
  if (n.isCrashed) return "node crashed";
  if (n.isPartitioned) return "network partition";
  if (n.status === "OFFLINE") return "marked OFFLINE";
  return "unavailable";
}

// node-2 sorts before node-10
export function compareNodeNames(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}