// src/lib/integrity/checksum.ts

import { createHash } from "crypto";

// Compute SHA-256 checksum of a buffer, returned as a hex string
export function computeChecksum(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// Verify a buffer matches an expected checksum
export function verifyChecksum(data: Buffer, expectedChecksum: string): boolean {
  return computeChecksum(data) === expectedChecksum;
}