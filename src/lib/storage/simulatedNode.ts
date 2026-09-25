// src/lib/storage/simulatedNode.ts
// A "storage node" = a DB row (health state) + a prefix in the shared storage backend.
// Every read/write is gated on the node's *current* state, which is what makes chaos real.

import { db } from "@/lib/db";
import { NodeUnavailableError, NotFoundError } from "@/lib/errors";
import { isNodeAvailable, unavailableReason, type NodeLike } from "@/lib/nodes/availability";
import { computeChecksum } from "@/lib/integrity/checksum";
import { getBackend } from "./index";

export class SimulatedNode {
  constructor(private readonly node: NodeLike) {}

  // Fetch fresh state from the DB.
  static async load(nodeId: string): Promise<SimulatedNode> {
    const node = await db.node.findUnique({ where: { id: nodeId } });
    if (!node) throw new NotFoundError(`Node ${nodeId} not found`);
    return new SimulatedNode(node);
  }

  get id(): string {
    return this.node.id;
  }

  get name(): string {
    return this.node.name;
  }

  get available(): boolean {
    return isNodeAvailable(this.node);
  }

  private path(key: string): string {
    return `${this.node.backendPrefix}/${key}`;
  }

  private requireAvailable(): void {
    if (!isNodeAvailable(this.node)) {
      throw new NodeUnavailableError(this.node.name, unavailableReason(this.node));
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    this.requireAvailable();
    // "Flaky disk" mode: this node silently stores damaged bytes.
    const payload = this.node.isCorrupting ? corruptBuffer(data) : data;
    await getBackend().put(this.path(key), payload);
  }

  async get(key: string): Promise<Buffer> {
    this.requireAvailable();
    return getBackend().get(this.path(key));
  }

  async delete(key: string): Promise<void> {
    this.requireAvailable();
    await getBackend().delete(this.path(key));
  }

  async exists(key: string): Promise<boolean> {
    if (!this.available) return false;
    return getBackend().exists(this.path(key));
  }

  // CHAOS: damage bytes that are ALREADY stored (silent bit rot). This deliberately bypasses the
  // availability check — a disk can rot whether or not the node is reachable — and never touches
  // metadata, so only a checksum verification can discover it.
  async corruptExisting(
    key: string
  ): Promise<{ byteOffset: number; originalChecksum: string; corruptedChecksum: string }> {
    const backend = getBackend();
    const original = await backend.get(this.path(key)); // throws StorageNotFoundError if absent
    const damaged = corruptBuffer(original);
    await backend.put(this.path(key), damaged);
    return {
      byteOffset: original.length === 0 ? 0 : Math.floor(original.length / 2),
      originalChecksum: computeChecksum(original),
      corruptedChecksum: computeChecksum(damaged),
    };
  }
}

// Flips every bit of the middle byte. Empty payloads get a stray byte so they change too.
export function corruptBuffer(data: Buffer): Buffer {
  if (data.length === 0) return Buffer.from([0xff]);
  const damaged = Buffer.from(data);
  const mid = Math.floor(damaged.length / 2);
  damaged[mid] = damaged[mid] ^ 0xff;
  return damaged;
}