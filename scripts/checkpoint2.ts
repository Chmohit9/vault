import "dotenv/config";

const base = process.env.VAULT_E2E_BASE_URL ?? "http://localhost:3000";
const key = `checkpoint2-${Date.now()}.txt`;
const contentV1 = "Vault checkpoint 2 version one\n";
const contentV2 = "Vault checkpoint 2 version two — durability, stale replicas, and partitions\n";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function json(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json().catch(() => ({}));
  assert(res.ok, `${init?.method ?? "GET"} ${path} returned ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function upload(content: string, ifVersion?: number) {
  const form = new FormData();
  form.set("file", new Blob([content], { type: "text/plain" }), key);
  form.set("key", key);
  form.set("replicationFactor", "3");
  form.set("writeQuorum", "2");
  form.set("readQuorum", "2");
  if (ifVersion !== undefined) form.set("ifVersion", String(ifVersion));
  return json("/api/objects", { method: "POST", body: form });
}

async function main() {
  console.log("CHECKPOINT 2 E2E");

  const policy = await json("/api/policy");
  assert(policy.policy.replicationFactor === 3, "expected RF=3");
  assert(policy.policy.writeQuorum === 2, "expected W=2");
  assert(policy.policy.readQuorum === 2, "expected R=2");
  assert(policy.policy.minHealthyReplicas >= 1, "minimum healthy replica policy missing");
  console.log("1. durability policy: PASS");

  const nodes = await json("/api/nodes");
  const domains = new Set(nodes.nodes.map((n: { failureDomain: string }) => n.failureDomain));
  assert(domains.size >= 2, "expected at least two failure domains");
  console.log("2. failure domains exposed: PASS", [...domains].join(", "));

  await upload(contentV1);
  await upload(contentV2, 1);
  const meta1 = await json(`/api/objects/${encodeURIComponent(key)}?meta=1`);
  assert(meta1.object.version === 2, "object did not reach version 2");
  const replicas = meta1.object.chunks[0].replicas;
  assert(replicas.length >= 3, "expected at least 3 replicas");
  console.log("3. versioned RF3 write: PASS");

  const replicaForStale = replicas.find((r: { status: string; effectiveStatus: string }) => r.effectiveStatus === "SYNCED");
  assert(replicaForStale, "no synced replica available for stale test");
  await json("/api/chaos/stale", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objectKey: key, chunkIndex: 0, nodeId: replicaForStale.node }),
  });
  const staleMeta = await json(`/api/objects/${encodeURIComponent(key)}?meta=1`);
  assert(staleMeta.object.chunks[0].replicas.some((r: { effectiveStatus: string }) => r.effectiveStatus === "STALE"), "stale replica was not visible");
  console.log("4. stale replica injection/detection: PASS");

  await json("/api/repair/scrub", { method: "POST" });
  const afterScrub = await json(`/api/objects/${encodeURIComponent(key)}?meta=1`);
  assert(afterScrub.object.chunks[0].replicas.some((r: { effectiveStatus: string }) => r.effectiveStatus === "STALE"), "scrub failed to preserve stale classification");
  await json("/api/repair/run", { method: "POST" });
  const afterRepair = await json(`/api/objects/${encodeURIComponent(key)}?meta=1`);
  assert(afterRepair.object.chunks[0].replicas.every((r: { effectiveStatus: string }) => r.effectiveStatus === "SYNCED"), "repair did not converge replicas to SYNCED");
  console.log("5. stale detection + repair: PASS");

  const partitionTarget = afterRepair.object.chunks[0].replicas[0].node as string;
  await json("/api/chaos/partition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: partitionTarget, value: true }),
  });
  const partitionedNodes = await json("/api/nodes");
  const partitioned = partitionedNodes.nodes.find((n: { name: string }) => n.name === partitionTarget);
  assert(partitioned?.isPartitioned === true && partitioned.available === false, "partition was not visible to coordinator");

  const read = await fetch(`${base}/api/objects/${encodeURIComponent(key)}`);
  const bytes = Buffer.from(await read.arrayBuffer());
  assert(read.ok, `read during partition failed with ${read.status}`);
  assert(bytes.toString() === contentV2, "read during partition returned wrong bytes");
  console.log(`6. quorum read during partition (${partitionTarget}): PASS`);

  await json("/api/chaos/partition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: partitionTarget, value: false }),
  });
  await json("/api/repair/rebalance", { method: "POST" });
  const finalMeta = await json(`/api/objects/${encodeURIComponent(key)}?meta=1`);
  assert(finalMeta.object.chunks[0].replicas.filter((r: { effectiveStatus: string }) => r.effectiveStatus === "SYNCED").length >= 3, "final durability below RF");
  console.log("7. partition heal + rebalance: PASS");

  console.log("CHECKPOINT 2 E2E: PASS");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
