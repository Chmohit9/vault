import "dotenv/config";

const base =
  process.env.VAULT_E2E_BASE_URL ??
  process.env.VAULT_BASE_URL ??
  "http://localhost:3000";

type Result = {
  name: string;
  passed: boolean;
  detail: string;
};

const results: Result[] = [];

function record(name: string, passed: boolean, detail: string) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} — ${detail}`);
}

async function responseBody(response: Response) {
  const text = await response.text();

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function json(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, init);
  const body = await responseBody(response);

  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} -> HTTP ${response.status}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`,
    );
  }

  return body;
}

function makeBytes(size: number, seed = 17): Buffer {
  const buffer = Buffer.alloc(size);

  for (let i = 0; i < size; i++) {
    buffer[i] = (i * 31 + seed * 17 + Math.floor(i / 97)) % 256;
  }

  return buffer;
}

async function upload(
  key: string,
  data: Buffer,
  ifVersion?: number,
) {
  const form = new FormData();

  form.set(
    "file",
    new Blob([new Uint8Array(data)], { type: "application/octet-stream" }),    key,
  );

  form.set("key", key);
  form.set("replicationFactor", "3");
  form.set("writeQuorum", "2");
  form.set("readQuorum", "2");

  if (ifVersion !== undefined) {
    form.set("ifVersion", String(ifVersion));
  }

  return json("/api/objects", {
    method: "POST",
    body: form,
  });
}

async function readObject(key: string): Promise<Buffer> {
  const response = await fetch(
    `${base}/api/objects/${encodeURIComponent(key)}`,
  );

  if (!response.ok) {
    throw new Error(
      `GET /api/objects/${encodeURIComponent(key)} -> HTTP ${
        response.status
      }`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  console.log("");
  console.log("==============================================");
  console.log("VAULT CHECKPOINT 6 — FULL COVERAGE E2E");
  console.log(`BASE_URL=${base}`);
  console.log("==============================================");
  console.log("");

  const suffix = Date.now();

  const largeKey = `checkpoint6-large-${suffix}.bin`;
  const largePayload = makeBytes(10 * 1024 * 1024, 91);
  // ------------------------------------------------------------
  // 1. Cluster availability
  // ------------------------------------------------------------

  try {
    const result = await json("/api/nodes");
    const nodes = Array.isArray(result?.nodes) ? result.nodes : [];

    const httpNodes = nodes.filter(
      (node: any) => node.backedBy === "http",
    );

    if (httpNodes.length < 3) {
      throw new Error(
        `expected at least 3 HTTP storage nodes, found ${httpNodes.length}`,
      );
    }

    record(
      "cluster availability",
      true,
      `${httpNodes.length} HTTP storage nodes registered`,
    );
  } catch (error) {
    record(
      "cluster availability",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 2. Configurable durability
  // ------------------------------------------------------------

  try {
    const result = await json("/api/policy");
    const policy = result?.policy;

    const rf = Number(policy?.replicationFactor);
    const w = Number(policy?.writeQuorum);
    const r = Number(policy?.readQuorum);

    if (!(rf >= 3 && w >= 2 && r >= 2)) {
      throw new Error(
        `expected RF>=3, W>=2, R>=2; received RF=${rf}, W=${w}, R=${r}`,
      );
    }

    record(
      "configurable durability policy",
      true,
      `RF=${rf}, W=${w}, R=${r}`,
    );
  } catch (error) {
    record(
      "configurable durability policy",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 3. Large multi-chunk object
  // ------------------------------------------------------------

  try {
    const uploaded = await upload(largeKey, largePayload);

    record(
      "large multi-chunk object storage",
      true,
    `${largePayload.length} bytes uploaded; ${uploaded?.chunkCount ?? "multiple"} chunks`,
);
  } catch (error) {
    record(
      "large multi-chunk object storage",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 4. Physical replication
  // ------------------------------------------------------------

  try {
    const metadata = await json(
      `/api/objects/${encodeURIComponent(largeKey)}?meta=1`,
    );

    const chunks = metadata?.object?.chunks ?? [];

    if (chunks.length < 2) {
      throw new Error(
        `expected multi-chunk object; found ${chunks.length} chunks`,
      );
    }

    const replicaCounts = chunks.map(
      (chunk: any) =>
        Array.isArray(chunk.replicas) ? chunk.replicas.length : 0,
    );

    if (!replicaCounts.every((count: number) => count >= 3)) {
      throw new Error(
        `replica counts per chunk: ${replicaCounts.join(", ")}`,
      );
    }

    record(
      "replication",
      true,
      `${chunks.length} chunks, minimum 3 replicas per chunk`,
    );
  } catch (error) {
    record(
      "replication",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 5. Large-object read + byte integrity
  // ------------------------------------------------------------

  try {
    const actual = await readObject(largeKey);

    if (!actual.equals(largePayload)) {
      throw new Error(
        `byte mismatch: expected ${largePayload.length}, got ${actual.length}`,
      );
    }

    record(
      "large-object retrieval and integrity",
      true,
      `${actual.length} bytes match uploaded payload exactly`,
    );
  } catch (error) {
    record(
      "large-object retrieval and integrity",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 6. Concurrent writes
  // ------------------------------------------------------------

  const concurrentKeys = Array.from(
    { length: 8 },
    (_, index) => `checkpoint6-concurrent-${suffix}-${index}`,
  );

  const concurrentPayloads = concurrentKeys.map((_, index) =>
    makeBytes(16 * 1024 + index * 101, index + 3),
  );

  try {
    const responses = await Promise.all(
      concurrentKeys.map((key, index) =>
        upload(key, concurrentPayloads[index]),
      ),
    );

    record(
      "concurrent writes",
      responses.length === concurrentKeys.length,
      `${responses.length}/${concurrentKeys.length} parallel object writes succeeded`,
    );
  } catch (error) {
    record(
      "concurrent writes",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 7. Concurrent reads
  // ------------------------------------------------------------

  try {
    const reads = await Promise.all(
      concurrentKeys.map(async (key, index) => {
        const data = await readObject(key);
        return data.equals(concurrentPayloads[index]);
      }),
    );

    if (!reads.every(Boolean)) {
      throw new Error(
        `${reads.filter(Boolean).length}/${reads.length} reads matched`,
      );
    }

    record(
      "concurrent reads",
      true,
      `${reads.length}/${reads.length} objects read concurrently with byte integrity`,
    );
  } catch (error) {
    record(
      "concurrent reads",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 8. Metadata consistency / conditional writes
  // ------------------------------------------------------------

  const versionKey = `checkpoint6-versioned-${suffix}`;
  const versionOne = makeBytes(8192, 201);
  const versionTwo = makeBytes(8192, 202);

  try {
    const created = await upload(versionKey, versionOne);

    const version =
      Number(
        created?.version ??
          created?.object?.version ??
          created?.data?.version,
      ) || 1;

    const updated = await upload(
      versionKey,
      versionTwo,
      version,
    );

    const updatedVersion = Number(
      updated?.version ??
        updated?.object?.version ??
        updated?.data?.version,
    );

    if (updatedVersion !== version + 1) {
      throw new Error(
        `expected version ${version + 1}, received ${updatedVersion}`,
      );
    }

    const staleForm = new FormData();

    staleForm.set(
      "file",
      new Blob([new Uint8Array(versionOne)], {
        type: "application/octet-stream",
      }),
      versionKey,
    );

    staleForm.set("key", versionKey);
    staleForm.set("replicationFactor", "3");
    staleForm.set("writeQuorum", "2");
    staleForm.set("readQuorum", "2");
    staleForm.set("ifVersion", String(version));

    const staleResponse = await fetch(`${base}/api/objects`, {
      method: "POST",
      body: staleForm,
    });

    if (staleResponse.status !== 409) {
      throw new Error(
        `expected stale conditional write HTTP 409, received ${staleResponse.status}`,
      );
    }

    record(
      "metadata consistency and conditional writes",
      true,
      `version ${version} -> ${updatedVersion}; stale writer rejected with HTTP 409`,
    );
  } catch (error) {
    record(
      "metadata consistency and conditional writes",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 9. Prometheus / storage metrics
  // ------------------------------------------------------------

  try {
    const response = await fetch(`${base}/api/metrics`);
    const metrics = await response.text();

    if (!response.ok) {
      throw new Error(
        `metrics endpoint returned HTTP ${response.status}`,
      );
    }

    const required = [
      "vault_logical_bytes_total",
      "vault_replicated_bytes_total",
      "vault_storage_overhead_ratio",
      "vault_repair_duration_seconds_last",
      "vault_recovery_time_seconds_last",
    ];

    const missing = required.filter(
      (metric) => !metrics.includes(metric),
    );

    if (missing.length > 0) {
      throw new Error(`missing metrics: ${missing.join(", ")}`);
    }

    record(
      "observability and storage overhead metrics",
      true,
      "logical bytes, replicated bytes, overhead, repair duration and recovery time exposed",
    );
  } catch (error) {
    record(
      "observability and storage overhead metrics",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 10. Start autopilot explicitly
  // ------------------------------------------------------------

  try {
    const start = await fetch(`${base}/api/autopilot/start`, {
      method: "POST",
    });

    if (!start.ok) {
      const body = await responseBody(start);

      throw new Error(
        `autopilot start returned HTTP ${start.status}: ${
          typeof body === "string" ? body : JSON.stringify(body)
        }`,
      );
    }

    const status = await json("/api/autopilot/status");

    if (!(status?.running ?? status?.enabled)) {
      throw new Error("autopilot start succeeded but status is not running");
    }

    record(
      "automatic background maintenance",
      true,
      "autopilot is running",
    );
  } catch (error) {
    record(
      "automatic background maintenance",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // 11. Machine-readable coverage endpoint
  // ------------------------------------------------------------

  try {
    const coverage = await json("/api/coverage");

    if (!Array.isArray(coverage?.requirements)) {
      throw new Error("coverage API did not return requirements[]");
    }

    if (coverage.requirements.length < 15) {
      throw new Error(
        `coverage API returned only ${coverage.requirements.length} requirements`,
      );
    }

    record(
      "machine-readable coverage endpoint",
      true,
      `${coverage.requirements.length} problem-statement requirements exposed`,
    );
  } catch (error) {
    record(
      "machine-readable coverage endpoint",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------
  // Final report
  // ------------------------------------------------------------

  console.log("");
  console.log("==============================================");
  console.log("CHECKPOINT 6 COVERAGE SUMMARY");
  console.log("==============================================");

  for (const result of results) {
    console.log(
      `${result.passed ? "PASS" : "FAIL"} | ${result.name} | ${result.detail}`,
    );
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.filter((result) => !result.passed).length;

  console.log("");
  console.log(`TOTAL: ${results.length}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);

  if (failed > 0) {
    console.log("");
    console.log("CHECKPOINT 6: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("CHECKPOINT 6: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});