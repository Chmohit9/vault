// src/lib/storage/storageNode.ts
// Single entry point every coordinator/repair/chaos call site uses to talk to "a node's storage",
// instead of constructing SimulatedNode directly. Existing simulated nodes (baseUrl = null) are
// completely unaffected; a node only switches to the real HTTP path once it's given a baseUrl
// (see scripts/register-http-nodes.ts).

import type { NodeLike } from "@/lib/nodes/availability";
import { SimulatedNode } from "./simulatedNode";
import { HttpStorageNode, type HttpNodeLike } from "./httpStorageNode";

export interface StorageNode {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  corruptExisting(
    key: string
  ): Promise<{ byteOffset: number; originalChecksum: string; corruptedChecksum: string }>;
}

export function getStorageNode(node: NodeLike): StorageNode {
  if (node.baseUrl) {
    return new HttpStorageNode(node as HttpNodeLike);
  }
  return new SimulatedNode(node);
}