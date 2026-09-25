// src/lib/storage/httpStorageNode.ts
// Same shape as SimulatedNode (id/name/available/put/get/delete/exists/corruptExisting), but backed
// by a real storage-node HTTP service (apps/storage-node) instead of the shared LocalBackend/Blob
// backend. This is what lets writeCoordinator/readCoordinator/chaos/repairEngine/scrub/rebalance stay
// unchanged apart from swapping `new SimulatedNode(x)` for the storageNode.ts factory.

import { NodeUnavailableError } from "@/lib/errors";
import { isNodeAvailable, unavailableReason, type NodeLike } from "@/lib/nodes/availability";
import { NodeClient, NodeClientError } from "@/lib/nodes/nodeClient";

export interface HttpNodeLike extends NodeLike {
  baseUrl: string;
}

export class HttpStorageNode {
  private readonly client: NodeClient;

  constructor(private readonly node: HttpNodeLike) {
    this.client = new NodeClient(node.name, node.baseUrl);
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

  private requireAvailable(): void {
    if (!isNodeAvailable(this.node)) {
      throw new NodeUnavailableError(this.node.name, unavailableReason(this.node));
    }
  }

  // Storage keys already look like "<objectId>/v2/c0" everywhere else in the system; the node's own
  // chunk route accepts that whole thing as the path after /chunks/ (see apps/storage-node), so no
  // per-node prefixing is needed here the way SimulatedNode needs backendPrefix.
  async put(key: string, data: Buffer): Promise<void> {
    this.requireAvailable();
    await this.client.putChunk(key, data);
  }

  async get(key: string): Promise<Buffer> {
    this.requireAvailable();
    return this.client.getChunk(key);
  }

  async delete(key: string): Promise<void> {
    this.requireAvailable();
    await this.client.deleteChunk(key);
  }

  async exists(key: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      return await this.client.headChunk(key);
    } catch (err) {
      if (err instanceof NodeClientError) return false;
      throw err;
    }
  }

  // CHAOS: ask the real node to damage bytes it already has on disk. Deliberately bypasses
  // requireAvailable(), matching SimulatedNode.corruptExisting — bit rot doesn't care whether the
  // coordinator currently considers the node reachable.
  async corruptExisting(
    key: string
  ): Promise<{ byteOffset: number; originalChecksum: string; corruptedChecksum: string }> {
    return this.client.corruptChunk(key);
  }
}