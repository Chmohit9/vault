// apps/storage-node/src/server.ts
// A standalone, independently addressable storage-node service. Each instance owns its own disk
// (STORAGE_PATH) and knows nothing about any other node, replication, quorum, or the coordinator's
// database — it only stores and serves chunks by key, honestly and with a checksum on every read.
//
// Config (env):
//   NODE_ID       e.g. "node-1"        (required)
//   NODE_PORT     e.g. "4101"          (required)
//   STORAGE_PATH  e.g. "/data"         (default "./data")
//
// Routes:
//   GET    /health
//   PUT    /chunks/:chunkId            body = raw bytes, returns { checksum, size }
//   GET    /chunks/:chunkId            returns raw bytes, header X-Checksum
//   HEAD   /chunks/:chunkId
//   DELETE /chunks/:chunkId
//   POST   /chaos/corrupt/:chunkId     flips a byte of the stored chunk on disk
//   POST   /chaos/clear                wipes every chunk this node holds
//   GET    /stats

import http from "http";
import { Storage, ChunkNotFoundError } from "./storage";
import { computeChecksum } from "./checksum";

const NODE_ID = process.env.NODE_ID;
const NODE_PORT = Number(process.env.NODE_PORT ?? 0);
const STORAGE_PATH = process.env.STORAGE_PATH || "./data";

if (!NODE_ID) {
  console.error("NODE_ID env var is required");
  process.exit(1);
}
if (!NODE_PORT) {
  console.error("NODE_PORT env var is required");
  process.exit(1);
}

const storage = new Storage(STORAGE_PATH);
const startedAt = Date.now();

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Same damage model as the coordinator's corruptBuffer (src/lib/storage/simulatedNode.ts): flip
// every bit of the middle byte, so a checksum always changes but the payload length never does.
function corruptBuffer(data: Buffer): { damaged: Buffer; byteOffset: number } {
  if (data.length === 0) return { damaged: Buffer.from([0xff]), byteOffset: 0 };
  const damaged = Buffer.from(data);
  const mid = Math.floor(damaged.length / 2);
  damaged[mid] = damaged[mid] ^ 0xff;
  return { damaged, byteOffset: mid };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURI(url.pathname);
    const method = req.method ?? "GET";

    if (pathname === "/health" && method === "GET") {
      const { chunkCount } = await storage.stats();
      return sendJson(res, 200, {
        ok: true,
        nodeId: NODE_ID,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        chunkCount,
      });
    }

    if (pathname === "/stats" && method === "GET") {
      const stats = await storage.stats();
      return sendJson(res, 200, { nodeId: NODE_ID, ...stats });
    }

    if (pathname === "/chaos/clear" && method === "POST") {
      const cleared = await storage.clear();
      return sendJson(res, 200, { cleared });
    }

    if (pathname.startsWith("/chaos/corrupt/") && method === "POST") {
      const key = pathname.slice("/chaos/corrupt/".length);
      if (!key) return sendJson(res, 400, { error: "missing chunk key" });
      try {
        const original = await storage.get(key);
        const { damaged, byteOffset } = corruptBuffer(original);
        await storage.put(key, damaged);
        return sendJson(res, 200, {
          byteOffset,
          originalChecksum: computeChecksum(original),
          corruptedChecksum: computeChecksum(damaged),
        });
      } catch (err) {
        if (err instanceof ChunkNotFoundError) return sendJson(res, 404, { error: err.message });
        throw err;
      }
    }

    if (pathname.startsWith("/chunks/")) {
      const key = pathname.slice("/chunks/".length);
      if (!key) return sendJson(res, 400, { error: "missing chunk key" });

      if (method === "PUT") {
        const body = await readBody(req);
        await storage.put(key, body);
        const checksum = computeChecksum(body);
        return sendJson(res, 200, { checksum, size: body.length });
      }

      if (method === "GET") {
        try {
          const data = await storage.get(key);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": data.length,
            "x-checksum": computeChecksum(data),
          });
          return res.end(data);
        } catch (err) {
          if (err instanceof ChunkNotFoundError) return sendJson(res, 404, { error: err.message });
          throw err;
        }
      }

      if (method === "HEAD") {
        const exists = await storage.exists(key);
        res.writeHead(exists ? 200 : 404, {});
        return res.end();
      }

      if (method === "DELETE") {
        await storage.delete(key);
        return sendJson(res, 200, { deleted: true });
      }
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error(`[${NODE_ID}] request error:`, err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

storage
  .init()
  .then(() => {
    server.listen(NODE_PORT, () => {
      console.log(`[${NODE_ID}] storage-node listening on :${NODE_PORT}, storage at ${STORAGE_PATH}`);
    });
  })
  .catch((err) => {
    console.error(`[${NODE_ID}] failed to init storage at ${STORAGE_PATH}:`, err);
    process.exit(1);
  });

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));