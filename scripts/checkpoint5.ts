import "dotenv/config";

const base = process.env.VAULT_BASE_URL || "http://localhost:3000";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`CHECKPOINT 5 ASSERTION FAILED: ${message}`);
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

async function upload(
  key: string,
  contents: string,
  ifVersion?: number
) {
  const form = new FormData();

  form.set("key", key);
  form.set(
    "file",
    new Blob([contents], { type: "text/plain" }),
    key
  );
  form.set("replicationFactor", "3");
  form.set("writeQuorum", "2");
  form.set("readQuorum", "2");

  if (ifVersion !== undefined) {
    form.set("ifVersion", String(ifVersion));
  }

  const response = await fetch(`${base}/api/objects`, {
    method: "POST",
    body: form,
  });

  const body = await response.json().catch(() => null);

  return {
    response,
    body,
  };
}

async function readText(key: string) {
  const response = await fetch(
    `${base}/api/objects/${encodeURIComponent(key)}`
  );

  const bytes = Buffer.from(await response.arrayBuffer());

  assert(
    response.ok,
    `read failed for ${key}: ${response.status} ${bytes.toString()}`
  );

  return bytes.toString();
}

async function getMeta(key: string) {
  return json<{
    object: {
      key: string;
      version: number;
      replicationFactor: number;
      writeQuorum: number;
      readQuorum: number;
      chunks: Array<{
        replicas: Array<{
          node: string;
          status: string;
          effectiveStatus: string;
          version: number;
        }>;
      }>;
    };
  }>(`/api/objects/${encodeURIComponent(key)}?meta=1`);
}

function syncedNodes(meta: Awaited<ReturnType<typeof getMeta>>) {
  return [
    ...new Set(
      meta.object.chunks.flatMap((chunk) =>
        chunk.replicas
          .filter(
            (replica) =>
              replica.status === "SYNCED" &&
              replica.effectiveStatus === "SYNCED"
          )
          .map((replica) => replica.node)
      )
    ),
  ];
}

async function main() {
  console.log(`CHECKPOINT 5 HARDENING against ${base}`);

  // -------------------------------------------------------------------------
  // 1. Policy validation
  // -------------------------------------------------------------------------
  const policy = await json<{
    policy: {
      replicationFactor: number;
      writeQuorum: number;
      readQuorum: number;
    };
  }>("/api/policy");

  assert(
    policy.policy.replicationFactor >= 1,
    "replication factor must be >= 1"
  );

  assert(
    policy.policy.writeQuorum >= 1,
    "write quorum must be >= 1"
  );

  assert(
    policy.policy.readQuorum >= 1,
    "read quorum must be >= 1"
  );

  assert(
    policy.policy.writeQuorum <= policy.policy.replicationFactor,
    "write quorum exceeds replication factor"
  );

  assert(
    policy.policy.readQuorum <= policy.policy.replicationFactor,
    "read quorum exceeds replication factor"
  );

  console.log(
    `1. policy validation: PASS (RF=${policy.policy.replicationFactor}, W=${policy.policy.writeQuorum}, R=${policy.policy.readQuorum})`
  );

  // -------------------------------------------------------------------------
  // 2. Concurrent writes to different objects
  // -------------------------------------------------------------------------
  const parallelKeys = Array.from(
    { length: 6 },
    (_, i) => `checkpoint5-parallel-${Date.now()}-${i}.txt`
  );

  const parallelResults = await Promise.all(
    parallelKeys.map(async (key, i) => {
      const result = await upload(
        key,
        `checkpoint5 parallel payload ${i}`
      );

      assert(
        result.response.ok,
        `parallel write failed for ${key}: ${result.response.status}`
      );

      return result;
    })
  );

  assert(
    parallelResults.length === 6,
    "not all concurrent writes returned"
  );

  await Promise.all(
    parallelKeys.map(async (key, i) => {
      const value = await readText(key);

      assert(
        value === `checkpoint5 parallel payload ${i}`,
        `parallel read mismatch for ${key}`
      );
    })
  );

  console.log("2. concurrent independent writes/reads: PASS (6 objects)");

  // -------------------------------------------------------------------------
  // 3. Versioned write
  // -------------------------------------------------------------------------
  const key = `checkpoint5-versioned-${Date.now()}.txt`;

  const first = await upload(key, "checkpoint5-version-one");

  assert(
    first.response.ok,
    `initial versioned write failed: ${first.response.status}`
  );

  const firstBody = first.body as {
    success?: boolean;
    object?: {
      version: number;
    };
  };

  assert(
    firstBody.object?.version === 1,
    `expected initial version 1, got ${firstBody.object?.version}`
  );

  const second = await upload(
    key,
    "checkpoint5-version-two",
    1
  );

  assert(
    second.response.ok,
    `conditional version-2 write failed: ${second.response.status}`
  );

  const secondBody = second.body as {
    object?: {
      version: number;
    };
  };

  assert(
    secondBody.object?.version === 2,
    `expected version 2, got ${secondBody.object?.version}`
  );

  assert(
    (await readText(key)) === "checkpoint5-version-two",
    "version 2 contents do not match"
  );

  console.log("3. versioned write with ifVersion: PASS (v1 -> v2)");

  // -------------------------------------------------------------------------
  // 4. Stale ifVersion must not overwrite newer data
  // -------------------------------------------------------------------------
  const staleAttempt = await upload(
    key,
    "checkpoint5-invalid-stale-write",
    1
  );

  assert(
    !staleAttempt.response.ok || staleAttempt.body?.success === false,
    "stale ifVersion write was unexpectedly accepted"
  );

  const afterStaleAttempt = await readText(key);

  assert(
    afterStaleAttempt === "checkpoint5-version-two",
    "stale conditional write changed object contents"
  );

  console.log(
    `4. stale conditional-write protection: PASS (HTTP ${staleAttempt.response.status})`
  );

  // -------------------------------------------------------------------------
  // 5. Concurrent conditional writes
  // -------------------------------------------------------------------------
  const concurrentKey = `checkpoint5-race-${Date.now()}.txt`;

  const initialRace = await upload(
    concurrentKey,
    "race-version-one"
  );

  assert(
    initialRace.response.ok,
    `race initial write failed: ${initialRace.response.status}`
  );

  const raceAttempts = await Promise.all([
    upload(concurrentKey, "race-update-A", 1),
    upload(concurrentKey, "race-update-B", 1),
    upload(concurrentKey, "race-update-C", 1),
  ]);

  const accepted = raceAttempts.filter(
    (attempt) => attempt.response.ok
  );

  assert(
    accepted.length === 1,
    `expected exactly one concurrent ifVersion=1 write to succeed, got ${accepted.length}`
  );

  const raceMeta = await getMeta(concurrentKey);

  assert(
    raceMeta.object.version === 2,
    `expected race object version 2, got ${raceMeta.object.version}`
  );

  const raceValue = await readText(concurrentKey);

  assert(
    ["race-update-A", "race-update-B", "race-update-C"].includes(raceValue),
    `unexpected winning race value: ${raceValue}`
  );

  console.log(
    "5. concurrent same-version write protection: PASS (exactly one winner)"
  );

  // -------------------------------------------------------------------------
  // 6. Replica convergence
  // -------------------------------------------------------------------------
  const meta = await getMeta(key);

  assert(
    meta.object.replicationFactor === 3,
    `expected RF3, got ${meta.object.replicationFactor}`
  );

  const nodes = syncedNodes(meta);

  assert(
    nodes.length >= 3,
    `expected at least 3 synced replica nodes, got ${nodes.length}`
  );

  assert(
    meta.object.chunks.every((chunk) =>
      chunk.replicas.every(
        (replica) =>
          replica.status !== "CORRUPTED" &&
          replica.status !== "STALE" &&
          replica.status !== "REPAIRING"
      )
    ),
    "final metadata contains an unhealthy replica"
  );

  console.log(
    `6. replica convergence/integrity: PASS (${nodes.length} synced nodes)`
  );

  // -------------------------------------------------------------------------
  // 7. Short final consistency check
  // -------------------------------------------------------------------------
  await sleep(1_000);

  const finalValue = await readText(key);

  assert(
    finalValue === "checkpoint5-version-two",
    "final object contents changed unexpectedly"
  );

  console.log("7. final read consistency: PASS");

  console.log("");
  console.log("CHECKPOINT 5 HARDENING: PASS");
}

main().catch((error) => {
  console.error("");
  console.error("CHECKPOINT 5 HARDENING: FAILED");
  console.error(error);
  process.exit(1);
});