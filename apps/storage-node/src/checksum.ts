// apps/storage-node/src/checksum.ts
import { createHash } from "crypto";

export function computeChecksum(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}