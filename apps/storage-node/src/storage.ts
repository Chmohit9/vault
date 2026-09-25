// apps/storage-node/src/storage.ts
// This node's own local disk. Same "safe path resolution + atomic write" pattern as the
// coordinator's LocalBackend (src/lib/storage/localBackend.ts), but standalone — this service has
// no dependency on the Next.js app.

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";

export class ChunkNotFoundError extends Error {
  constructor(key: string) {
    super(`chunk not found: ${key}`);
    this.name = "ChunkNotFoundError";
  }
}

export class Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  // Chunk keys look like "<objectId>/v2/c0" (the coordinator's storageKey convention) — treat the
  // whole thing as a relative path, same as LocalBackend does.
  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`invalid chunk key: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    try {
      await fs.rename(tmp, file);
    } catch {
      await fs.writeFile(file, data);
      await fs.rm(tmp, { force: true });
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ChunkNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  // Recursively counts files and total bytes under the root, for GET /stats.
  async stats(): Promise<{ chunkCount: number; totalBytes: number }> {
    let chunkCount = 0;
    let totalBytes = 0;
    async function walk(dir: string) {
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
          chunkCount++;
          const st = await fs.stat(full);
          totalBytes += st.size;
        }
      }
    }
    await walk(this.root);
    return { chunkCount, totalBytes };
  }

  // Wipes every stored chunk on this node. Used by POST /chaos/clear to reset a node for a fresh
  // demo run without restarting its container.
  async clear(): Promise<number> {
    const { chunkCount } = await this.stats();
    await fs.rm(this.root, { recursive: true, force: true });
    await fs.mkdir(this.root, { recursive: true });
    return chunkCount;
  }
}