// src/lib/replication/quorum.ts

export interface WriteAttempt {
  nodeId: string;
  success: boolean;
}

export interface ReadAttempt {
  nodeId: string;
  data: Buffer | null;
  checksum: string | null;
  success: boolean;
}

// A write succeeds once at least W nodes acknowledged it
export function hasWriteQuorum(attempts: WriteAttempt[], writeQuorum: number): boolean {
  return attempts.filter((a) => a.success).length >= writeQuorum;
}

// Finds the checksum value that at least R replicas agree on, returns matching buffer.
// This is how the system decides which data is "correct" when replicas disagree.
export function resolveReadQuorum(
  attempts: ReadAttempt[],
  readQuorum: number
): { data: Buffer; checksum: string } | null {
  const successful = attempts.filter((a) => a.success && a.data && a.checksum);

  const counts = new Map<string, { count: number; data: Buffer }>();
  for (const a of successful) {
    const key = a.checksum!;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { count: 1, data: a.data! });
    }
  }

  for (const [checksum, { count, data }] of counts) {
    if (count >= readQuorum) {
      return { data, checksum };
    }
  }

  return null; // no agreement reached
}