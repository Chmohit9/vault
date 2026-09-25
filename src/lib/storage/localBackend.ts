// src/lib/storage/localBackend.ts
// Local-disk implementation of StorageBackend. Each simulated node's data lives under
// <VAULT_DATA_DIR>/<node backendPrefix>/..., so "a node's disk" is a real folder you can inspect.

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { StorageNotFoundError } from "@/lib/errors";
import type { StorageBackend } from "./backend";

export class LocalBackend implements StorageBackend {
  private readonly root: string;

  constructor(root: string = process.env.VAULT_DATA_DIR || ".vault-data") {
    this.root = path.resolve(process.cwd(), root);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    try {
      await fs.rename(tmp, file); // atomic replace
    } catch {
      // Windows can refuse to rename over a file that is briefly open — fall back to a direct write.
      await fs.writeFile(file, data);
      await fs.rm(tmp, { force: true });
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}