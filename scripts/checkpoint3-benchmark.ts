import "dotenv/config";

const base = process.env.VAULT_BASE_URL || "http://localhost:3000";
const objectCount = Number.parseInt(process.env.VAULT_BENCH_OBJECTS || "12", 10);
const concurrency = Number.parseInt(process.env.VAULT_BENCH_CONCURRENCY || "4", 10);
const sizeBytes = Number.parseInt(process.env.VAULT_BENCH_SIZE_BYTES || "4096", 10);

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`CHECKPOINT 3 ASSERTION FAILED: ${message}`); }
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init); const body = await res.json().catch(() => null);
  if (!res.ok || (body && body.success === false)) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}
async function runPool<T>(items: number[], workers: number, fn: (item: number) => Promise<T>): Promise<T[]> {
  const results: T[] = []; let cursor = 0;
  async function worker() { while (true) { const i = cursor++; if (i >= items.length) return; results[i] = await fn(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker)); return results;
}
function p95(values: number[]) { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? 0; }

async function main() {
  assert(objectCount > 0 && concurrency > 0 && sizeBytes > 0, "benchmark settings must be positive");
  console.log(`CHECKPOINT 3 BENCHMARK against ${base}`);
  console.log(`objects=${objectCount}, concurrency=${concurrency}, payload=${sizeBytes} bytes`);
  const payload = new Blob([Buffer.alloc(sizeBytes, 0x56)], { type: "application/octet-stream" });
  const ids = Array.from({ length: objectCount }, (_, i) => i);

  const writeStart = performance.now();
  const writes = await runPool(ids, concurrency, async (i) => {
    const key = `checkpoint3-${Date.now()}-${i}.bin`; const form = new FormData(); form.set("key", key); form.set("file", payload, key);
    const started = performance.now(); await json("/api/objects", { method: "POST", body: form }); return { key, ms: performance.now() - started };
  });
  const writeElapsed = performance.now() - writeStart;
  console.log(`1. concurrent writes: PASS (${objectCount} objects, ${(objectCount / (writeElapsed / 1000)).toFixed(2)} objects/s, p95=${p95(writes.map((r) => r.ms)).toFixed(1)}ms)`);

  const readStart = performance.now();
  const reads = await runPool(writes.map((_, i) => i), concurrency, async (i) => {
    const started = performance.now(); const res = await fetch(`${base}/api/objects/${encodeURIComponent(writes[i].key)}`); const bytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`read ${writes[i].key} failed: ${res.status}`); return { bytes: bytes.length, ms: performance.now() - started };
  });
  const readElapsed = performance.now() - readStart; assert(reads.every((r) => r.bytes === sizeBytes), "read byte count mismatch");
  console.log(`2. concurrent reads: PASS (${objectCount} objects, ${(objectCount / (readElapsed / 1000)).toFixed(2)} objects/s, p95=${p95(reads.map((r) => r.ms)).toFixed(1)}ms)`);

  const metricsRes = await fetch(`${base}/api/metrics`); const metrics = await metricsRes.text(); assert(metricsRes.ok, `metrics endpoint returned ${metricsRes.status}`);
  const overhead = metrics.match(/^vault_storage_overhead_ratio\s+([0-9.]+)$/m); const logical = metrics.match(/^vault_logical_bytes_total\s+([0-9.]+)$/m); const replicated = metrics.match(/^vault_replicated_bytes_total\s+([0-9.]+)$/m);
  assert(overhead && logical && replicated, "required storage metrics were not exposed");
  console.log(`3. Prometheus metrics: PASS (logical=${logical![1]} bytes, replicated=${replicated![1]} bytes, overhead=${Number(overhead![1]).toFixed(2)}x)`);
  const recovery = metrics.match(/^vault_recovery_time_seconds_last\s+([0-9.]+)$/m); const repair = metrics.match(/^vault_repair_duration_seconds_last\s+([0-9.]+)$/m);
  console.log(`4. recovery/repair timing metrics: PASS (lastRecovery=${recovery?.[1] ?? "0"}s, lastRepairCycle=${repair?.[1] ?? "0"}s)`);
  console.log("CHECKPOINT 3 BENCHMARK: PASS");
}
main().catch((err) => { console.error(err); process.exit(1); });
