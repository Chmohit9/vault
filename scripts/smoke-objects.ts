// scripts/smoke-objects.ts — object read/write path smoke test (isolated "smoke-objects" cluster)
import "dotenv/config";
import { rm } from "fs/promises";
import path from "path";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✘ ${name}\n      → ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main() {
  process.env.VAULT_CLUSTER = "smoke-objects";
  process.env.VAULT_DATA_DIR = ".vault-data-smoke-objects";
  process.env.STORAGE_BACKEND = "local";
  process.env.VAULT_N = "3";
  process.env.VAULT_W = "2";
  process.env.VAULT_R = "2";

  const { db } = await import("../src/lib/db");
  const registry = await import("../src/lib/nodes/registry");
  const { putObject } = await import("../src/lib/metadata/writeCoordinator");
  const { getObject, getObjectMeta, listObjects } = await import("../src/lib/metadata/readCoordinator");
  const { SimulatedNode } = await import("../src/lib/storage/simulatedNode");
  const { computeChecksum } = await import("../src/lib/integrity/checksum");
  const { ConflictError, QuorumError, ValidationError } = await import("../src/lib/errors");

  const dataDir = path.resolve(process.cwd(), process.env.VAULT_DATA_DIR);
  const cleanup = async () => {
    await db.chaosEvent.deleteMany({ where: { cluster: "smoke-objects" } });
    await db.repairLog.deleteMany({ where: { cluster: "smoke-objects" } });
    await db.storedObject.deleteMany({ where: { cluster: "smoke-objects" } }); // cascades chunks+replicas
    await db.node.deleteMany({ where: { cluster: "smoke-objects" } });
    await rm(dataDir, { recursive: true, force: true });
  };

  try {
    await cleanup();
    console.log('Vault object read/write smoke test (cluster "smoke-objects")\n');

    for (const name of ["o-1", "o-2", "o-3"]) await registry.createNode(name);
    const node = (name: string) => registry.getNode(name);

    const payloadV1 = Buffer.from("vault object smoke payload / ".repeat(500));
    const payloadV1Checksum = computeChecksum(payloadV1);
    const payloadV2 = Buffer.from("vault object smoke payload v2 / ".repeat(400));

    await check("upload: writes object, replicates to all 3 nodes, W/R quorum satisfied", async () => {
      const result = await putObject({ key: "docs/report.txt", data: payloadV1, contentType: "text/plain" });
      assert(result.version === 1, "expected version 1");
      assert(result.replicationFactor === 3, "expected RF 3");
      assert(result.writeQuorum === 2, "expected W 2");
      assert(result.checksum === payloadV1Checksum, "checksum mismatch on write result");
      assert(result.nodesUsed.length === 3, "expected all 3 nodes used");
    });

    await check("metadata: object + chunk + 3 SYNCED replicas persisted correctly", async () => {
      const meta = await getObjectMeta("docs/report.txt");
      assert(meta.version === 1, "expected version 1");
      assert(meta.checksum === payloadV1Checksum, "stored checksum mismatch");
      assert(meta.chunks.length === 1, "expected 1 chunk for this payload size");
      assert(meta.chunks[0].replicas.length === 3, "expected 3 replicas");
      assert(meta.chunks[0].replicas.every((r) => r.status === "SYNCED"), "expected all replicas SYNCED");
    });

    await check("list: object appears in listObjects()", async () => {
      const objs = await listObjects();
      assert(objs.some((o) => o.key === "docs/report.txt"), "object missing from list");
    });

    await check("read: round-trips exact bytes and checksum", async () => {
      const result = await getObject("docs/report.txt");
      assert(result.data.equals(payloadV1), "read bytes do not match written bytes");
      assert(result.checksum === payloadV1Checksum, "read checksum mismatch");
    });

    await check("survives node kill: read still succeeds from remaining replicas", async () => {
      await registry.killNode((await node("o-1")).id);
      const result = await getObject("docs/report.txt");
      assert(result.data.equals(payloadV1), "read after kill returned wrong bytes");
      await registry.reviveNode((await node("o-1")).id);
    });

    await check("corruption: read detects mismatch, marks CORRUPTED, still serves valid data", async () => {
      const meta = await getObjectMeta("docs/report.txt");
      const target = meta.chunks[0].replicas.find((r) => r.node.name === "o-2")!;
      await new SimulatedNode(await node("o-2")).corruptExisting(target.storageKey);

      const result = await getObject("docs/report.txt");
      assert(result.data.equals(payloadV1), "read after corruption returned wrong bytes");

      const after = await getObjectMeta("docs/report.txt");
      const corrupted = after.chunks[0].replicas.find((r) => r.node.name === "o-2")!;
      assert(corrupted.status === "CORRUPTED", "corrupted replica should be marked CORRUPTED");
      const others = after.chunks[0].replicas.filter((r) => r.node.name !== "o-2");
      assert(others.every((r) => r.status === "SYNCED"), "untouched replicas should stay SYNCED");
    });

    await check("repair-readiness: corrupted replica's stored bytes differ from canonical checksum", async () => {
      const meta = await getObjectMeta("docs/report.txt");
      const corrupted = meta.chunks[0].replicas.find((r) => r.node.name === "o-2")!;
      const bytes = await new SimulatedNode(await node("o-2")).get(corrupted.storageKey);
      assert(
        computeChecksum(bytes) !== meta.chunks[0].checksum,
        "corrupted replica bytes should not match canonical checksum"
      );
    });

    await check("versioning: second write to same key bumps version and replaces chunks", async () => {
      const result = await putObject({ key: "docs/report.txt", data: payloadV2, ifVersion: 1 });
      assert(result.version === 2, "expected version 2");
      const meta = await getObjectMeta("docs/report.txt");
      assert(meta.version === 2, "stored version should be 2");
      assert(meta.chunks[0].replicas.every((r) => r.status === "SYNCED"), "v2 replicas should be fresh SYNCED");
      const read = await getObject("docs/report.txt");
      assert(read.data.equals(payloadV2), "read after update returned stale bytes");
    });

    await check("optimistic concurrency: stale ifVersion is rejected with ConflictError", async () => {
      let threw = false;
      try {
        await putObject({ key: "docs/report.txt", data: Buffer.from("stale writer"), ifVersion: 1 });
      } catch (e) {
        threw = e instanceof ConflictError;
      }
      assert(threw, "expected ConflictError for stale ifVersion");
      const meta = await getObjectMeta("docs/report.txt");
      assert(meta.version === 2, "version must not change on a rejected write");
    });

    await check("duplicate/create-only: ifVersion=0 against an existing key is rejected", async () => {
      let threw = false;
      try {
        await putObject({ key: "docs/report.txt", data: Buffer.from("should not be created"), ifVersion: 0 });
      } catch (e) {
        threw = e instanceof ConflictError;
      }
      assert(threw, "expected ConflictError: object already exists");
    });

    await check("write quorum failure: too few available nodes aborts the write, leaves no trace", async () => {
      await registry.killNode((await node("o-1")).id);
      await registry.killNode((await node("o-2")).id);
      let threw = false;
      try {
        await putObject({ key: "docs/should-not-exist.txt", data: Buffer.from("nope") });
      } catch (e) {
        threw = e instanceof QuorumError;
      }
      assert(threw, "expected QuorumError when available nodes < write quorum");
      const found = await db.storedObject.findUnique({
        where: { cluster_key: { cluster: "smoke-objects", key: "docs/should-not-exist.txt" } },
      });
      assert(found === null, "rejected write must not leave metadata behind");
      await registry.reviveNode((await node("o-1")).id);
      await registry.reviveNode((await node("o-2")).id);
    });

    await check("read quorum degraded: read still succeeds with only 1 of 3 replicas reachable", async () => {
      await registry.killNode((await node("o-1")).id);
      await registry.killNode((await node("o-3")).id);
      const result = await getObject("docs/report.txt");
      assert(result.data.equals(payloadV2), "degraded read returned wrong bytes");
      await registry.reviveNode((await node("o-1")).id);
      await registry.reviveNode((await node("o-3")).id);
    });

    await check("total outage: read fails with QuorumError when no replica is reachable", async () => {
      await registry.killNode((await node("o-1")).id);
      await registry.killNode((await node("o-2")).id);
      await registry.killNode((await node("o-3")).id);
      let threw = false;
      try {
        await getObject("docs/report.txt");
      } catch (e) {
        threw = e instanceof QuorumError;
      }
      assert(threw, "expected QuorumError when every replica is unreachable");
      await registry.reviveNode((await node("o-1")).id);
      await registry.reviveNode((await node("o-2")).id);
      await registry.reviveNode((await node("o-3")).id);
    });

    await check("all-replicas-corrupted: read fails with QuorumError, no valid data to return", async () => {
      const meta = await getObjectMeta("docs/report.txt");
      for (const replica of meta.chunks[0].replicas) {
        await new SimulatedNode(await node(replica.node.name)).corruptExisting(replica.storageKey);
      }
      let threw = false;
      try {
        await getObject("docs/report.txt");
      } catch (e) {
        threw = e instanceof QuorumError;
      }
      assert(threw, "expected QuorumError when every replica is corrupted");
    });

    await check("invalid key rejected with ValidationError", async () => {
      let threw = false;
      try {
        await putObject({ key: "../etc/passwd", data: Buffer.from("x") });
      } catch (e) {
        threw = e instanceof ValidationError;
      }
      assert(threw, "expected ValidationError for a key starting with '.'");
    });

    console.log(`\n${failed === 0 ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED"} (${passed} passed, ${failed} failed)`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});