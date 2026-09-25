// src/lib/storage/backend.ts

// Generic contract every storage backend must implement.
// Nothing else in the app should talk to Vercel Blob (or any provider) directly —
// everything goes through this interface.

export interface StorageBackend {
  // Write raw bytes under a given key, return nothing on success, throw on failure
  put(key: string, data: Buffer): Promise<void>;

  // Read raw bytes for a given key, throw if not found
  get(key: string): Promise<Buffer>;

  // Delete the object at a given key
  delete(key: string): Promise<void>;

  // Check if a key exists without downloading its full content
  exists(key: string): Promise<boolean>;
}