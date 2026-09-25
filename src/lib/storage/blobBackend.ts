// src/lib/storage/blobBackend.ts
// Vercel Blob implementation (STORAGE_BACKEND=blob). Requires BLOB_READ_WRITE_TOKEN.

import { put, head, del } from "@vercel/blob";
import { StorageNotFoundError } from "@/lib/errors";
import type { StorageBackend } from "./backend";

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return e?.name === "BlobNotFoundError" || /does not exist|not found/i.test(e?.message ?? "");
}

export class BlobBackend implements StorageBackend {
  constructor() {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error("STORAGE_BACKEND=blob requires BLOB_READ_WRITE_TOKEN to be set");
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    await put(key, data, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
  }

  async get(key: string): Promise<Buffer> {
    let url: string;
    try {
      url = (await head(key)).url;
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw err;
    }
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (res.status === 404) throw new StorageNotFoundError(key);
    if (!res.ok) throw new Error(`Failed to fetch blob ${key}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await del(key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await head(key);
      return true;
    } catch {
      return false;
    }
  }
}