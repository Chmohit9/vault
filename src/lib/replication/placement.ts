// src/lib/replication/placement.ts

import { db } from "@/lib/db";
import { currentCluster, failureDomainForNode } from "@/config/policy";
import { ValidationError } from "@/lib/errors";
import { compareNodeNames, isNodeAvailable, type NodeLike } from "@/lib/nodes/availability";

export type PlacementNode = NodeLike & { replicaCount: number; failureDomain: string };

export async function loadClusterNodes(): Promise<PlacementNode[]> {
  const rows = await db.node.findMany({
    where: { cluster: currentCluster() },
    include: { _count: { select: { replicas: true } } },
  });
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      backendPrefix: row.backendPrefix,
      baseUrl: row.baseUrl,
      status: row.status,
      isPartitioned: row.isPartitioned,
      isCorrupting: row.isCorrupting,
      isCrashed: row.isCrashed,
      replicaCount: row._count.replicas,
      failureDomain: failureDomainForNode(row.name),
    }))
    .sort(compareNodeNames);
}

function byLoad(a: PlacementNode, b: PlacementNode): number {
  return a.replicaCount - b.replicaCount || compareNodeNames(a, b);
}

function distributeByFailureDomain(nodes: PlacementNode[], count: number): PlacementNode[] {
  const remaining = [...nodes].sort(byLoad);
  const chosen: PlacementNode[] = [];
  const usedDomains = new Set<string>();

  while (chosen.length < count && remaining.length > 0) {
    const distinct = remaining.find((node) => !usedDomains.has(node.failureDomain));
    const pick = distinct ?? remaining[0];
    chosen.push(pick);
    usedDomains.add(pick.failureDomain);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return chosen;
}

export function chooseWriteTargets(nodes: PlacementNode[], n: number) {
  const available = nodes.filter((x) => isNodeAvailable(x)).sort(byLoad);
  const unavailable = nodes.filter((x) => !isNodeAvailable(x)).sort(byLoad);
  const targets = distributeByFailureDomain(available, n);
  if (targets.length < n) {
    targets.push(...distributeByFailureDomain(unavailable.filter((x) => !targets.some((t) => t.id === x.id)), n - targets.length));
  }
  return { targets, availableCount: available.length };
}

export async function selectWriteTargets(n: number) {
  const nodes = await loadClusterNodes();
  if (nodes.length < n) {
    throw new ValidationError(`Replication factor ${n} exceeds the ${nodes.length} node(s) registered in this cluster`);
  }
  return { ...chooseWriteTargets(nodes, n), totalNodes: nodes.length, nodes };
}

export function pickReplacementNodes(
  nodes: PlacementNode[],
  excludeNodeIds: Set<string>,
  count: number,
  existingFailureDomains: Set<string> = new Set()
): PlacementNode[] {
  const candidates = nodes.filter((x) => isNodeAvailable(x) && !excludeNodeIds.has(x.id)).sort(byLoad);
  const selected: PlacementNode[] = [];
  const domains = new Set(existingFailureDomains);

  while (selected.length < count && candidates.length > 0) {
    const distinct = candidates.find((node) => !domains.has(node.failureDomain));
    const pick = distinct ?? candidates[0];
    selected.push(pick);
    domains.add(pick.failureDomain);
    candidates.splice(candidates.indexOf(pick), 1);
  }
  return selected;
}
