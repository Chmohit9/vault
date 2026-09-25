// src/lib/storage/index.ts
// Chooses the storage backend once per process. Everything else goes through this.

import type { StorageBackend } from "./backend";
import { LocalBackend } from "./localBackend";
import { BlobBackend } from "./blobBackend";

const g = globalThis as unknown as { __vaultBackend?: StorageBackend };

export function getBackend(): StorageBackend {
  if (!g.__vaultBackend) {
    const kind = (process.env.STORAGE_BACKEND ?? "local").toLowerCase();
    g.__vaultBackend = kind === "blob" ? new BlobBackend() : new LocalBackend();
  }
  return g.__vaultBackend;
}