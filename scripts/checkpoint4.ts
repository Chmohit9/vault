// scripts/checkpoint4.ts
//
// Checkpoint 4:
// Autonomous failure detection + self-healing end-to-end test.
//
// This intentionally exercises the real HTTP storage-node cluster through the public API.
// The autopilot is started through /api/autopilot/start, so the test does not depend on
// VAULT_AUTOPILOT being present in .env.
//
// Expected cluster:
//   - 6 registered HTTP storage nodes
//   - Docker Compose storage-node containers running
//
// Usage:
//   npm run checkpoint4:e2e
//

import "dotenv/config";

const base = process.env.VAULT_BASE_URL || "http://localhost:3000";

const POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`CHECKPOINT 4 ASSERTION FAILED: ${message}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json().catch(() => null);

  if (!response.ok || (body && body.success === false)) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(body)}`
    );
  }

  return body as T;
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      const elapsed = Date.now() - started;
      console.log(`   PASS: ${description} (${elapsed}ms)`);
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for: ${description}`);
}

interface NodeView {
  id: string;
  name: string;
  status: string;
  available: boolean;
  isCrashed: boolean;
  isPartitioned: boolean;
  baseUrl: string | null;
  backedBy: string;
}

interface ReplicaView {
  node: string;
  status: string;
  effectiveStatus: string;
  version: number;
}

interface ChunkView {
  index: number;
  replicas: ReplicaView[];
}

interface ObjectMeta {
  object: {
    key: string;
    version: number;
    replicationFactor: number;
    writeQuorum: number;
    readQuorum: number;
    chunks: ChunkView[];
  };
}

async function getNodes(): Promise<NodeView[]> {
  const response = await json<{ nodes: NodeView[] }>("/api/nodes");
  return response.nodes;
}

async function getMeta(key: string): Promise<ObjectMeta> {
  return json<ObjectMeta>(
    `/api/objects/${encodeURIComponent(key)}?meta=1`
  );
}

function allReplicas(meta: ObjectMeta) {
  return meta.object.chunks.flatMap((chunk) => chunk.replicas);
}

function syncedReplicas(meta: ObjectMeta) {
  return allReplicas(meta).filter(
    (replica) =>
      replica.status === "SYNCED" &&
      replica.effectiveStatus === "SYNCED"
  );
}

function uniqueReplicaNodes(meta: ObjectMeta) {
  return [...new Set(syncedReplicas(meta).map((replica) => replica.node))];
}

async function readObject(key: string): Promise<Buffer> {
  const response = await fetch(
    `${base}/api/objects/${encodeURIComponent(key)}`
  );

  const bytes = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(
      `GET /api/objects/${key} failed: ${response.status} ${bytes.toString()}`
    );
  }

  return bytes;
}

async function uploadObject(
  key: string,
  contents: Buffer,
  ifVersion?: number
) {
  const form = new FormData();

  form.set("key", key);
  form.set(
  "file",
  new Blob(
    [new Uint8Array(contents)],
    { type: "application/octet-stream" }
  ),
  key
);

  form.set("replicationFactor", "3");
  form.set("writeQuorum", "2");
  form.set("readQuorum", "2");

  if (ifVersion !== undefined) {
    form.set("ifVersion", String(ifVersion));
  }

  return json<{
    object: {
      key: string;
      version: number;
      replicationFactor: number;
      writeQuorum: number;
      readQuorum: number;
    };
  }>("/api/objects", {
    method: "POST",
    body: form,
  });
}

async function postChaos(path: string, body: Record<string, unknown>) {
  return json<Record<string, unknown>>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function startAutopilot() {
  await postChaos("/api/autopilot/start", {});
}

async function stopAutopilot() {
  try {
    await postChaos("/api/autopilot/stop", {});
  } catch {
    // Cleanup must never hide the original test failure.
  }
}

async function main() {
  console.log(`CHECKPOINT 4 E2E against ${base}`);

  const key = `checkpoint4-${Date.now()}.txt`;
  const v1 = Buffer.from(
    "Vault checkpoint 4 autonomous recovery test - version one."
  );
  const v2 = Buffer.from(
    "Vault checkpoint 4 autonomous recovery test - version two."
  );

  try {
    // -----------------------------------------------------------------------
    // 0. Preconditions
    // -----------------------------------------------------------------------
    const nodes = await getNodes();

    assert(nodes.length >= 6, `expected at least 6 nodes, found ${nodes.length}`);

    const httpNodes = nodes.filter(
      (node) => node.backedBy === "http" && node.baseUrl
    );

    assert(
      httpNodes.length >= 6,
      `expected at least 6 HTTP-backed nodes, found ${httpNodes.length}`
    );

    console.log(
      `0. cluster preconditions: PASS (${httpNodes.length} HTTP storage nodes)`
    );

    // -----------------------------------------------------------------------
    // 1. Start autonomous maintenance
    // -----------------------------------------------------------------------
    await startAutopilot();

    await waitFor("autopilot is running", async () => {
      const response = await json<{
        running: boolean;
      }>("/api/autopilot/status");

      return response.running === true;
    });

    console.log("1. autonomous autopilot: PASS");

    // -----------------------------------------------------------------------
    // 2. Initial replicated write
    // -----------------------------------------------------------------------
    const firstWrite = await uploadObject(key, v1);

    assert(
      firstWrite.object.version === 1,
      `expected version 1, got ${firstWrite.object.version}`
    );

    let meta = await getMeta(key);

    assert(
      meta.object.replicationFactor === 3,
      `expected RF=3, got ${meta.object.replicationFactor}`
    );

    assert(
      syncedReplicas(meta).length >= 3,
      `expected at least 3 synced replicas, got ${syncedReplicas(meta).length}`
    );

    console.log(
      `2. initial RF3/W2 write: PASS (${uniqueReplicaNodes(meta).join(", ")})`
    );

    // -----------------------------------------------------------------------
    // 3. Kill one replica node
    // -----------------------------------------------------------------------
    const initialReplicaNodes = uniqueReplicaNodes(meta);
    const failedNode = initialReplicaNodes[0];

    assert(failedNode, "could not identify an initial replica node");

    await postChaos("/api/chaos/kill", {
      nodeId: failedNode,
    });

    await waitFor(`node ${failedNode} is OFFLINE`, async () => {
      const currentNodes = await getNodes();
      const node = currentNodes.find((n) => n.name === failedNode);

      return Boolean(node && node.status === "OFFLINE" && node.isCrashed);
    });

    // -----------------------------------------------------------------------
    // 4. Verify read availability while degraded
    // -----------------------------------------------------------------------
    const degradedRead = await readObject(key);

    assert(
      degradedRead.equals(v1),
      "object bytes changed while one replica node was down"
    );

    console.log(
      `3. read availability during node failure: PASS (failed node=${failedNode})`
    );

    // -----------------------------------------------------------------------
    // 5. Autopilot should restore RF automatically
    // -----------------------------------------------------------------------
    await waitFor(
      `autopilot restores RF=3 after ${failedNode} failure`,
      async () => {
        const current = await getMeta(key);

        return (
          syncedReplicas(current).length >=
          current.object.replicationFactor
        );
      }
    );

    meta = await getMeta(key);

    assert(
      syncedReplicas(meta).length >= 3,
      `expected RF3 after automatic recovery, got ${syncedReplicas(meta).length}`
    );

    console.log(
      `4. automatic replica recovery/rebalance: PASS (${uniqueReplicaNodes(meta).join(", ")})`
    );

    // -----------------------------------------------------------------------
    // 6. Revive the failed node
    // -----------------------------------------------------------------------
    await postChaos("/api/chaos/revive", {
      nodeId: failedNode,
    });

    await waitFor(`node ${failedNode} recovers`, async () => {
      const currentNodes = await getNodes();
      const node = currentNodes.find((n) => n.name === failedNode);

      return Boolean(
        node &&
          node.status === "HEALTHY" &&
          !node.isCrashed &&
          !node.isPartitioned
      );
    });

    console.log(`5. node recovery: PASS (${failedNode} HEALTHY)`);

    // -----------------------------------------------------------------------
    // 7. Corrupt a healthy replica
    // -----------------------------------------------------------------------
    meta = await getMeta(key);

    const corruptionReplica = syncedReplicas(meta).find(
      (replica) => replica.node !== failedNode
    );

    assert(
      corruptionReplica,
      "could not find a healthy replica to corrupt"
    );

    await postChaos("/api/chaos/corrupt", {
      objectKey: key,
      chunkIndex: 0,
      nodeId: corruptionReplica.node,
    });

    console.log(
      `6. injected corruption: PASS (${corruptionReplica.node})`
    );

    // -----------------------------------------------------------------------
    // 8. Autopilot scrub + repair
    // -----------------------------------------------------------------------
    await waitFor(
      `autopilot detects and repairs corruption on ${corruptionReplica.node}`,
      async () => {
        const current = await getMeta(key);

        return current.object.chunks.every((chunk) =>
          chunk.replicas.every(
            (replica) =>
              replica.node === corruptionReplica.node
                ? replica.status === "SYNCED" &&
                  replica.effectiveStatus === "SYNCED"
                : true
          )
        );
      }
    );

    const repairedRead = await readObject(key);

    assert(
      repairedRead.equals(v1),
      "object bytes changed after automatic corruption repair"
    );

    console.log(
      `7. automatic scrub + corruption repair: PASS (${corruptionReplica.node})`
    );

    // -----------------------------------------------------------------------
    // 9. Create version 2 and deliberately stale one replica
    // -----------------------------------------------------------------------
    const secondWrite = await uploadObject(
      key,
      v2,
      firstWrite.object.version
    );

    assert(
      secondWrite.object.version === 2,
      `expected version 2, got ${secondWrite.object.version}`
    );

    meta = await getMeta(key);

    const staleTarget = syncedReplicas(meta)[0];

    assert(staleTarget, "could not find replica for stale test");

    await postChaos("/api/chaos/stale", {
      objectKey: key,
      chunkIndex: 0,
      nodeId: staleTarget.node,
    });

    console.log(`8. stale replica injection: PASS (${staleTarget.node})`);

    // -----------------------------------------------------------------------
    // 10. Autopilot should repair stale replica
    // -----------------------------------------------------------------------
    await waitFor(
      `autopilot repairs stale replica on ${staleTarget.node}`,
      async () => {
        const current = await getMeta(key);

        return current.object.chunks.every((chunk) =>
          chunk.replicas
            .filter((replica) => replica.node === staleTarget.node)
            .every(
              (replica) =>
                replica.status === "SYNCED" &&
                replica.effectiveStatus === "SYNCED" &&
                replica.version === current.object.version
            )
        );
      }
    );

    const staleRepairedRead = await readObject(key);

    assert(
      staleRepairedRead.equals(v2),
      "object bytes changed after stale replica repair"
    );

    console.log(
      `9. automatic stale-replica repair: PASS (${staleTarget.node})`
    );

    // -----------------------------------------------------------------------
    // 11. Partition a replica node
    // -----------------------------------------------------------------------
    meta = await getMeta(key);

    const partitionNode = syncedReplicas(meta)[0]?.node;

    assert(partitionNode, "could not find a replica node for partition test");

    await postChaos("/api/chaos/partition", {
      nodeId: partitionNode,
      value: true,
    });

    const partitionRead = await readObject(key);

    assert(
      partitionRead.equals(v2),
      "object became unreadable during single-node partition"
    );

    console.log(
      `10. read availability during network partition: PASS (${partitionNode})`
    );

    // -----------------------------------------------------------------------
    // 12. Heal partition
    // -----------------------------------------------------------------------
    await postChaos("/api/chaos/partition", {
      nodeId: partitionNode,
      value: false,
    });

    await waitFor(`partition healed for ${partitionNode}`, async () => {
      const currentNodes = await getNodes();
      const node = currentNodes.find((n) => n.name === partitionNode);

      return Boolean(
        node &&
          node.status === "HEALTHY" &&
          !node.isPartitioned
      );
    });

    await waitFor("final object remains fully healthy", async () => {
      const current = await getMeta(key);

      return (
        syncedReplicas(current).length >=
        current.object.replicationFactor
      );
    });

    const finalRead = await readObject(key);

    assert(
      finalRead.equals(v2),
      "final object contents do not match version 2"
    );

    console.log(
      `11. partition healing + final convergence: PASS (${partitionNode})`
    );

    // -----------------------------------------------------------------------
    // 13. Final metadata verification
    // -----------------------------------------------------------------------
    meta = await getMeta(key);

    const finalReplicas = syncedReplicas(meta);

    assert(
      finalReplicas.length >= 3,
      `final synced replica count is ${finalReplicas.length}, expected >=3`
    );

    assert(
      allReplicas(meta).every(
        (replica) =>
          replica.status !== "CORRUPTED" &&
          replica.status !== "STALE" &&
          replica.status !== "REPAIRING"
      ),
      "final metadata still contains an unhealthy replica state"
    );

    console.log(
      `12. final integrity/convergence: PASS (${finalReplicas.length} synced replicas)`
    );

    console.log("");
    console.log("CHECKPOINT 4 E2E: PASS");
  } finally {
    await stopAutopilot();
  }
}

main().catch((err) => {
  console.error("");
  console.error("CHECKPOINT 4 E2E: FAILED");
  console.error(err);
  process.exit(1);
});