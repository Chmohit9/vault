// src/lib/repair/rebalance.ts
// Restores durability, respects failure domains, and converges temporary over-replication toward RF.

import { db } from "@/lib/db";
import { currentCluster, failureDomainForNode, DEFAULT_POLICY } from "@/config/policy";
import { emit } from "@/lib/events/bus";
import { getStorageNode } from "@/lib/storage/storageNode";
import { isNodeAvailable, type NodeLike } from "@/lib/nodes/availability";
import { loadClusterNodes, pickReplacementNodes, type PlacementNode } from "@/lib/replication/placement";
import { logRepair } from "./log";

export interface RebalanceResult {
  chunksExamined: number;
  chunksAlreadySatisfied: number;
  replicasAdded: string[];
  replicasRemoved: string[];
  chunksStillUnderReplicated: string[];
}

function chooseExtraReplica(replicas: Array<{ id: string; nodeId: string; storageKey: string; lastVerifiedAt: Date | null; node: NodeLike }>) {
  const domainCounts = new Map<string, number>();
  for (const r of replicas) {
    const domain = failureDomainForNode(r.node.name);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  }

  return [...replicas].sort((a, b) => {
    const aDomain = failureDomainForNode(a.node.name);
    const bDomain = failureDomainForNode(b.node.name);
    const aDuplicate = domainCounts.get(aDomain)! > 1 ? 0 : 1;
    const bDuplicate = domainCounts.get(bDomain)! > 1 ? 0 : 1;
    return aDuplicate - bDuplicate ||
      (a.lastVerifiedAt?.getTime() ?? 0) - (b.lastVerifiedAt?.getTime() ?? 0);
  })[0];
}

export async function rebalanceCluster(limit = 200): Promise<RebalanceResult> {
  const cluster = currentCluster();
  const chunks = await db.chunk.findMany({
    where: { object: { cluster } },
    take: limit,
    include: { object: true, replicas: { include: { node: true } } },
  });
  const clusterNodes = await loadClusterNodes();
  const added: string[] = [];
  const removed: string[] = [];
  const stillUnder: string[] = [];
  let alreadySatisfied = 0;

  for (const chunk of chunks) {
    const rf = chunk.object.replicationFactor;
    const healthy = chunk.replicas.filter((r) => r.status === "SYNCED" && r.version === chunk.object.version && isNodeAvailable(r.node));

    if (healthy.length < rf) {
      const deficit = rf - healthy.length;
      const existingNodeIds = new Set(chunk.replicas.map((r) => r.nodeId));
      const existingDomains = new Set(healthy.map((r) => failureDomainForNode(r.node.name)));
      const freshNodes: PlacementNode[] = pickReplacementNodes(clusterNodes, existingNodeIds, deficit, existingDomains);
      const source = healthy[0];

      if (!source || freshNodes.length === 0) {
        stillUnder.push(`${chunk.object.key}#${chunk.index}`);
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await getStorageNode(source.node).get(source.storageKey);
      } catch {
        stillUnder.push(`${chunk.object.key}#${chunk.index}`);
        continue;
      }

      for (const target of freshNodes) {
        const storageKey = `${chunk.objectId}/v${chunk.object.version}/c${chunk.index}`;
        try {
          await getStorageNode(target).put(storageKey, bytes);
          await db.replica.create({
            data: {
              chunkId: chunk.id,
              nodeId: target.id,
              storageKey,
              checksum: chunk.checksum,
              status: "SYNCED",
              version: chunk.object.version,
              lastVerifiedAt: new Date(),
            },
          });
          const label = `${chunk.object.key}#${chunk.index}->${target.name}`;
          added.push(label);
          await logRepair("REBALANCE", `Placed new replica ${label} (source ${source.node.name}, domain ${target.failureDomain})`, true, {
            objectKey: chunk.object.key, chunkId: chunk.id, nodeId: target.id,
          });
        } catch (err) {
          await logRepair("REBALANCE", `Failed to place ${chunk.object.key}#${chunk.index} on ${target.name}: ${err instanceof Error ? err.message : String(err)}`, false, {
            objectKey: chunk.object.key, chunkId: chunk.id, nodeId: target.id,
          });
        }
      }
    }

    const refreshed = await db.replica.findMany({ where: { chunkId: chunk.id }, include: { node: true } });
    const healthyNow = refreshed.filter((r) => r.status === "SYNCED" && r.version === chunk.object.version && isNodeAvailable(r.node));

    if (healthyNow.length > rf) {
      if (!DEFAULT_POLICY.allowTemporaryOverReplication) {
        continue;
      }
      let excess = healthyNow.length - rf;
      while (excess > 0) {
        const candidate = chooseExtraReplica(healthyNow);
        if (!candidate) break;
        try {
          await getStorageNode(candidate.node).delete(candidate.storageKey);
        } catch {
          break;
        }
        await db.replica.delete({ where: { id: candidate.id } });
        removed.push(`${chunk.object.key}#${chunk.index}<-${candidate.node.name}`);
        healthyNow.splice(healthyNow.findIndex((r) => r.id === candidate.id), 1);
        excess--;
      }
    }

    if (healthyNow.length >= rf) alreadySatisfied++;
    else stillUnder.push(`${chunk.object.key}#${chunk.index}`);
  }

  emit(
    "rebalance.completed",
    `Rebalance: ${added.length} added, ${removed.length} removed, ${stillUnder.length} under-replicated`,
    { level: stillUnder.length > 0 ? "warn" : "info", data: { added: added.length, removed: removed.length, stillUnder: stillUnder.length } }
  );

  return {
    chunksExamined: chunks.length,
    chunksAlreadySatisfied: alreadySatisfied,
    replicasAdded: added,
    replicasRemoved: removed,
    chunksStillUnderReplicated: stillUnder,
  };
}
