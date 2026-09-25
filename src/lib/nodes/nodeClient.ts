// src/lib/nodes/nodeClient.ts
// Coordinator-side HTTP client for a real, independently-addressable storage-node service
// (apps/storage-node). One instance per request — cheap, no persistent connection state kept here.
//
// This is the "distributed HTTP node backend" half of the StorageBackend abstraction described in
// docs/DESIGN.md; the other half is the existing SimulatedNode. src/lib/storage/storageNode.ts picks
// between the two per-node, based on whether Node.baseUrl is set.

import { computeChecksum } from "@/lib/integrity/checksum";

const DEFAULT_TIMEOUT_MS = 5_000;

export type NodeClientErrorReason =
  | "connection_refused"
  | "timeout"
  | "not_found"
  | "server_error"
  | "checksum_mismatch"
  | "unavailable";

// A single typed error for every way a call to a storage node can fail, so callers (writeCoordinator,
// readCoordinator, repairEngine, scrub, rebalance) can branch on `reason` instead of parsing messages.
export class NodeClientError extends Error {
  readonly reason: NodeClientErrorReason;
  readonly nodeName: string;

  constructor(nodeName: string, reason: NodeClientErrorReason, message: string) {
    super(`storage node ${nodeName}: ${message}`);
    this.name = "NodeClientError";
    this.nodeName = nodeName;
    this.reason = reason;
  }
}

export interface PutChunkResult {
  checksum: string;
  size: number;
}

export interface HealthResult {
  ok: boolean;
  nodeId: string;
  uptimeSeconds: number;
  chunkCount: number;
}

// storageKey is the same value used everywhere else in the system (e.g. "<objectId>/v2/c0") — it
// maps directly onto the URL path after /chunks/, same convention LocalBackend uses on disk.
function chunkUrl(baseUrl: string, storageKey: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chunks/${storageKey}`;
}

async function withTimeout<T>(
  nodeName: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new NodeClientError(nodeName, "timeout", `request timed out after ${timeoutMs}ms`);
    }
    // Node's fetch throws a generic TypeError for connection failures (refused, DNS, reset, etc).
    if (err instanceof TypeError) {
      throw new NodeClientError(nodeName, "connection_refused", err.message);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class NodeClient {
  constructor(
    private readonly nodeName: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {}

  async health(): Promise<HealthResult> {
    const res = await withTimeout(this.nodeName, this.timeoutMs, (signal) =>
      fetch(`${this.baseUrl.replace(/\/+$/, "")}/health`, { signal })
    );
    if (!res.ok) {
      throw new NodeClientError(this.nodeName, "server_error", `/health returned ${res.status}`);
    }
    return (await res.json()) as HealthResult;
  }

  async putChunk(storageKey: string, data: Buffer): Promise<PutChunkResult> {
    const res = await withTimeout(this.nodeName, this.timeoutMs, (signal) =>
      fetch(chunkUrl(this.baseUrl, storageKey), {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(data),
        signal,
      })
    );
    if (res.status === 500) {
      throw new NodeClientError(this.nodeName, "server_error", `PUT chunk failed: ${res.status}`);
    }
    if (!res.ok) {
      throw new NodeClientError(this.nodeName, "server_error", `PUT chunk failed: ${res.status}`);
    }
    const body = (await res.json()) as PutChunkResult;
    // Belt-and-suspenders: verify what the node reports it stored matches what we sent, so a bug in
    // the node's own checksum path can't silently pass as a healthy write.
    const expected = computeChecksum(data);
    if (body.checksum !== expected) {
      throw new NodeClientError(
        this.nodeName,
        "checksum_mismatch",
        `node reported checksum ${body.checksum}, expected ${expected}`
      );
    }
    return body;
  }

  async getChunk(storageKey: string): Promise<Buffer> {
    const res = await withTimeout(this.nodeName, this.timeoutMs, (signal) =>
      fetch(chunkUrl(this.baseUrl, storageKey), { signal })
    );
    if (res.status === 404) {
      throw new NodeClientError(this.nodeName, "not_found", `chunk not found: ${storageKey}`);
    }
    if (!res.ok) {
      throw new NodeClientError(this.nodeName, "server_error", `GET chunk failed: ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const reportedChecksum = res.headers.get("x-checksum");
    if (reportedChecksum && reportedChecksum !== computeChecksum(buf)) {
      // The node itself verifies on read (see apps/storage-node/src/server.ts), but re-verify here
      // too: readCoordinator relies on this throwing rather than silently returning bad bytes.
      throw new NodeClientError(this.nodeName, "checksum_mismatch", `checksum mismatch on read of ${storageKey}`);
    }
    return buf;
  }

  async headChunk(storageKey: string): Promise<boolean> {
    const res = await withTimeout(this.nodeName, this.timeoutMs, (signal) =>
      fetch(chunkUrl(this.baseUrl, storageKey), { method: "HEAD", signal })
    );
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new NodeClientError(this.nodeName, "server_error", `HEAD chunk failed: ${res.status}`);
    }
    return true;
  }

  async deleteChunk(storageKey: string): Promise<void> {
    const res = await withTimeout(this.nodeName, this.timeoutMs, (signal) =>
      fetch(chunkUrl(this.baseUrl, storageKey), { method: "DELETE", signal })
    );
    // Deleting something already gone is not an error — matches LocalBackend's fs.rm({ force: true }).
    if (!res.ok && res.status !== 404) {
      throw new NodeClientError(this.nodeName, "server_error", `DELETE chunk failed: ${res.status}`);
    }
  }

  // CHAOS: ask the real node to damage its own on-disk bytes for a chunk it already has.
  async corruptChunk(
    storageKey: string
  ): Promise<{ byteOffset: number; originalChecksum: string; corruptedChecksum: string }> {
    const res = await withTimeout(this.nodeName, this.timeoutMs, (signal) =>
      fetch(`${this.baseUrl.replace(/\/+$/, "")}/chaos/corrupt/${storageKey}`, { method: "POST", signal })
    );
    if (res.status === 404) {
      throw new NodeClientError(this.nodeName, "not_found", `chunk not found: ${storageKey}`);
    }
    if (!res.ok) {
      throw new NodeClientError(this.nodeName, "server_error", `chaos/corrupt failed: ${res.status}`);
    }
    return (await res.json()) as { byteOffset: number; originalChecksum: string; corruptedChecksum: string };
  }
}