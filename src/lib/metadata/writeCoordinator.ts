// src/lib/metadata/writeCoordinator.ts
// Transactional object write path: chunk -> replicate -> enforce write quorum -> commit metadata.
// Data writes happen first (they can't be transactional across simulated nodes); metadata is only
// committed once every chunk has reached its write quorum. Anything written but not committed is
// rolled back so we never report success without durable, quorum-satisfying data.

import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import {
  currentCluster,
  CHUNK_SIZE_BYTES,
  MAX_OBJECT_BYTES,
  DEFAULT_POLICY,
  validatePolicy,
  requiredWriteAcks,
  type ReplicationPolicy,
  failureDomainForNode,
} from "@/config/policy";
import { ValidationError, ConflictError, QuorumError, isUniqueViolation } from "@/lib/errors";
import { computeChecksum } from "@/lib/integrity/checksum";
import { emit } from "@/lib/events/bus";
import { getStorageNode } from "@/lib/storage/storageNode";
import { selectWriteTargets, type PlacementNode } from "@/lib/replication/placement";
import { hasWriteQuorum, type WriteAttempt } from "@/lib/replication/quorum";

export interface PutObjectInput {
  key: string;
  data: Buffer;
  contentType?: string | null;
  // Optimistic concurrency: caller's expected CURRENT version (0 = "must not already exist").
  // Omitted => unconditional write, but it is still version-guarded against concurrent writers.
  ifVersion?: number;
  policyOverride?: Partial<ReplicationPolicy>;
}

export interface PutObjectResult {
  key: string;
  version: number;
  size: number;
  checksum: string;
  chunkCount: number;
  replicationFactor: number;
  writeQuorum: number;
  readQuorum: number;
  nodesUsed: string[];
}

// Keys map directly onto simulated-disk file paths (via LocalBackend), so keep them conservative.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}$/;

function splitChunks(data: Buffer): Buffer[] {
  if (data.length === 0) return [Buffer.alloc(0)];
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE_BYTES) {
    chunks.push(data.subarray(offset, Math.min(offset + CHUNK_SIZE_BYTES, data.length)));
  }
  return chunks;
}

interface ChunkPlan {
  index: number;
  data: Buffer;
  checksum: string;
  size: number;
  storageKey: string;
  attempts: WriteAttempt[];
}

interface WrittenByte {
  nodeId: string;
  storageKey: string;
}

// Best-effort: delete bytes that were physically written but must not be kept (rollback, or GC of an
// old version after a successful update). Never throws — a cleanup failure must not mask the real error.
async function deleteBestEffort(targets: PlacementNode[] | { id: string; backendPrefix: string; baseUrl: string | null; name: string; status: "HEALTHY" | "OFFLINE" | "DEGRADED"; isPartitioned: boolean; isCorrupting: boolean; isCrashed: boolean }[], entries: WrittenByte[]) {
  for (const entry of entries) {
    const target = targets.find((t) => t.id === entry.nodeId);
    if (!target) continue;
    try {
      await getStorageNode(target).delete(entry.storageKey);
    } catch {
      // Node may be unreachable for cleanup too — a future scrub pass will find and ignore/remove it.
    }
  }
}

export async function putObject(input: PutObjectInput): Promise<PutObjectResult> {
  const cluster = currentCluster();
  const key = input.key;

  if (!KEY_RE.test(key)) {
    throw new ValidationError(
      "Object key must be 1-256 chars: letters, digits, '/', '.', '_' or '-' (starting with a letter/digit)"
    );
  }
  if (input.data.length > MAX_OBJECT_BYTES) {
    throw new ValidationError(`Object exceeds maximum size of ${MAX_OBJECT_BYTES} bytes`);
  }

  const policy: ReplicationPolicy = {
    replicationFactor: input.policyOverride?.replicationFactor ?? DEFAULT_POLICY.replicationFactor,
    writeQuorum: input.policyOverride?.writeQuorum ?? DEFAULT_POLICY.writeQuorum,
    readQuorum: input.policyOverride?.readQuorum ?? DEFAULT_POLICY.readQuorum,
    minHealthyReplicas: input.policyOverride?.minHealthyReplicas ?? DEFAULT_POLICY.minHealthyReplicas,
    allowTemporaryOverReplication:
      input.policyOverride?.allowTemporaryOverReplication ?? DEFAULT_POLICY.allowTemporaryOverReplication,
  };
  const policyError = validatePolicy(policy);
  if (policyError) throw new ValidationError(policyError);

  const existing = await db.storedObject.findUnique({ where: { cluster_key: { cluster, key } } });

  if (input.ifVersion !== undefined) {
    const currentVersion = existing?.version ?? 0;
    if (input.ifVersion !== currentVersion) {
      throw new ConflictError(
        `Version conflict on ${key}: expected current version ${input.ifVersion}, found ${currentVersion}`,
        { expected: input.ifVersion, actual: currentVersion },
        "VERSION_CONFLICT"
      );
    }
  }

  // Snapshot the previous version's replicas now, while we still have metadata for them — they'll be
  // garbage-collected from storage after a successful commit (they're about to be superseded).
  const previousChunks = existing
    ? await db.chunk.findMany({
        where: { objectId: existing.id },
        include: { replicas: { include: { node: true } } },
      })
    : [];

  const objectId = existing?.id ?? nanoid();
  const nextVersion = (existing?.version ?? 0) + 1;

  const targetsInfo = await selectWriteTargets(policy.replicationFactor);
  const targets = targetsInfo.targets;
  const requiredAcks = requiredWriteAcks(policy);
  if (targetsInfo.availableCount < requiredAcks) {
    throw new QuorumError(
      `Only ${targetsInfo.availableCount} node(s) available; durability requires ${requiredAcks} healthy replica acknowledgement(s)`,
      { available: targetsInfo.availableCount, writeQuorum: policy.writeQuorum, minHealthyReplicas: policy.minHealthyReplicas, requiredAcks }
    );
  }

  const rawChunks = splitChunks(input.data);
const objectChecksum = computeChecksum(input.data);

// Every physical write attempt gets a unique storage namespace.
// This is critical for concurrent same-version writers: two writers may
// both temporarily calculate v2, but a losing writer must never be able
// to delete the winning writer's bytes during rollback.
const writeToken = nanoid();

const plan: ChunkPlan[] = rawChunks.map((data, index) => ({
  index,
  data,
  checksum: computeChecksum(data),
  size: data.length,
  storageKey: `${objectId}/v${nextVersion}/${writeToken}/c${index}`,
  attempts: [],
}));

  // Phase 1: write bytes to every target node, for every chunk. Independent per (chunk, node) — one
  // node being unreachable must not block writes to the others.
  const written: WrittenByte[] = [];
  for (const chunk of plan) {
    for (const target of targets) {
      const sim = getStorageNode(target);
      try {
        await sim.put(chunk.storageKey, chunk.data);
        chunk.attempts.push({ nodeId: target.id, success: true });
        written.push({ nodeId: target.id, storageKey: chunk.storageKey });
      } catch {
        chunk.attempts.push({ nodeId: target.id, success: false });
      }
    }
  }

  // Phase 2: every chunk must independently reach write quorum, or the whole object write is rejected.
  const failedChunks = plan.filter((c) => !hasWriteQuorum(c.attempts, requiredAcks));
  if (failedChunks.length > 0) {
    await deleteBestEffort(targets, written);
    const detail = failedChunks
      .map((c) => `chunk ${c.index}: ${c.attempts.filter((a) => a.success).length}/${requiredAcks}`)
      .join(", ");
    emit("write.quorum_failed", `Write quorum not reached for ${key}: ${detail}`, {
      level: "error",
      data: { key, failedChunks: failedChunks.map((c) => c.index) },
    });
    throw new QuorumError(`Write quorum not reached for ${key} (${detail})`, {
      key,
      failedChunks: failedChunks.map((c) => c.index),
    });
  }

  // Phase 3: commit metadata transactionally. Only nodes that actually succeeded for a given chunk
  // are recorded SYNCED; nodes that failed become MISSING replicas for the repair subsystem to heal.
  try {
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      if (existing) {
        const res = await tx.storedObject.updateMany({
          where: { id: existing.id, version: existing.version },
          data: {
            size: input.data.length,
            contentType: input.contentType ?? null,
            checksum: objectChecksum,
            version: nextVersion,
            replicationFactor: policy.replicationFactor,
            writeQuorum: policy.writeQuorum,
            readQuorum: policy.readQuorum,
          },
        });
        if (res.count !== 1) {
          throw new ConflictError(
            `Version conflict on ${key}: object changed concurrently`,
            undefined,
            "VERSION_CONFLICT"
          );
        }
        // Replace this object's chunk set entirely; cascades to delete the old Replica rows too.
        await tx.chunk.deleteMany({ where: { objectId: existing.id } });
      } else {
        try {
          await tx.storedObject.create({
            data: {
              id: objectId,
              cluster,
              key,
              size: input.data.length,
              contentType: input.contentType ?? null,
              checksum: objectChecksum,
              version: nextVersion,
              replicationFactor: policy.replicationFactor,
              writeQuorum: policy.writeQuorum,
              readQuorum: policy.readQuorum,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ConflictError(`Object ${key} was created concurrently`, undefined, "VERSION_CONFLICT");
          }
          throw err;
        }
      }

      for (const chunk of plan) {
        const createdChunk = await tx.chunk.create({
          data: {
            objectId,
            index: chunk.index,
            size: chunk.size,
            checksum: chunk.checksum,
          },
        });
        const succeededNodeIds = new Set(chunk.attempts.filter((a) => a.success).map((a) => a.nodeId));
        for (const target of targets) {
          await tx.replica.create({
            data: {
              chunkId: createdChunk.id,
              nodeId: target.id,
              storageKey: chunk.storageKey,
              checksum: chunk.checksum,
              status: succeededNodeIds.has(target.id) ? "SYNCED" : "MISSING",
              version: nextVersion,
              lastVerifiedAt: succeededNodeIds.has(target.id) ? new Date() : null,
            },
          });
        }
      }
    });
  } catch (err) {
    // Metadata failed to commit (e.g. a version race) even though bytes are already on disk.
    await deleteBestEffort(targets, written);
    throw err;
  }

  // Garbage-collect the previous version's bytes now that the new version is durably committed.
  if (previousChunks.length > 0) {
    const oldEntries: WrittenByte[] = previousChunks.flatMap((c) =>
      c.replicas.map((r) => ({ nodeId: r.nodeId, storageKey: r.storageKey }))
    );
    const oldTargets: PlacementNode[] = previousChunks
      .flatMap((c) => c.replicas.map((r) => r.node))
      .reduce<PlacementNode[]>((acc, node) => {
        if (!acc.find((n) => n.id === node.id)) {
          acc.push({
            id: node.id,
            name: node.name,
            backendPrefix: node.backendPrefix,
            baseUrl: node.baseUrl,
            status: node.status,
            isPartitioned: node.isPartitioned,
            isCorrupting: node.isCorrupting,
            isCrashed: node.isCrashed,
            replicaCount: 0,
            failureDomain: failureDomainForNode(node.name),
          });
        }
        return acc;
      }, []);
    await deleteBestEffort(oldTargets, oldEntries);
  }

  const nodesUsed = [...new Set(written.map((w) => targets.find((t) => t.id === w.nodeId)?.name).filter(Boolean))] as string[];

  emit(
    "object.written",
    `Wrote ${key} v${nextVersion} (${plan.length} chunk(s), RF=${policy.replicationFactor}, W=${policy.writeQuorum})`,
    { level: "success", data: { key, version: nextVersion, chunks: plan.length, nodes: nodesUsed } }
  );

  return {
    key,
    version: nextVersion,
    size: input.data.length,
    checksum: objectChecksum,
    chunkCount: plan.length,
    replicationFactor: policy.replicationFactor,
    writeQuorum: policy.writeQuorum,
    readQuorum: policy.readQuorum,
    nodesUsed,
  };
}