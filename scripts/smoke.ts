// scripts/smoke.ts — foundation smoke test (isolated "smoke" cluster, cleans up after itself)
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
  process.env.VAULT_CLUSTER = "smoke";
  process.env.VAULT_DATA_DIR = ".vault-data-smoke";
  process.env.STORAGE_BACKEND = "local";

  const { db } = await import("../src/lib/db");
  const registry = await import("../src/lib/nodes/registry");
  const { SimulatedNode } = await import("../src/lib/storage/simulatedNode");
  const { computeChecksum } = await import("../src/lib/integrity/checksum");
  const { detectFailures, simulateHeartbeats } = await import("../src/lib/nodes/failureDetector");
  const { chooseWriteTargets, loadClusterNodes, pickReplacementNodes } = await import(
    "../src/lib/replication/placement"
  );
  const { NodeUnavailableError, ConflictError } = await import("../src/lib/errors");

  const dataDir = path.resolve(process.cwd(), process.env.VAULT_DATA_DIR);
  const cleanup = async () => {
    await db.chaosEvent.deleteMany({ where: { cluster: "smoke" } });
    await db.repairLog.deleteMany({ where: { cluster: "smoke" } });
    await db.storedObject.deleteMany({ where: { cluster: "smoke" } });
    await db.node.deleteMany({ where: { cluster: "smoke" } });
    await rm(dataDir, { recursive: true, force: true });
  };

  try {
    await cleanup();
    console.log('Vault foundation smoke test (cluster "smoke")\n');

    const nodes: { id: string; name: string }[] = [];
    const sim = async (i: number) => new SimulatedNode(await registry.getNode(nodes[i].id));
    const original = Buffer.from("vault smoke payload / ".repeat(200));
    const sum = computeChecksum(original);

    await check("database reachable; create 3 nodes", async () => {
      for (const name of ["s-1", "s-2", "s-3"]) nodes.push(await registry.createNode(name));
      assert(nodes.length === 3, "expected 3 nodes");
    });

    await check("duplicate node name -> ConflictError", async () => {
      let threw = false;
      try {
        await registry.createNode("s-1");
      } catch (e) {
        threw = e instanceof ConflictError;
      }
      assert(threw, "expected ConflictError");
    });

    await check("local storage round-trip", async () => {
      const a = await sim(0);
      await a.put("obj/chunk-0", original);
      assert((await a.exists("obj/chunk-0")) === true, "exists() should be true");
      assert(computeChecksum(await a.get("obj/chunk-0")) === sum, "bytes changed on round-trip");
    });

    await check("REAL corruption: damages an EXISTING replica, others untouched", async () => {
      const a = await sim(0);
      const b = await sim(1);
      await b.put("obj/chunk-0", original);
      const info = await a.corruptExisting("obj/chunk-0");
      const readA = await a.get("obj/chunk-0");
      assert(computeChecksum(readA) !== sum, "replica on node A should now differ");
      assert(readA.length === original.length, "corruption should keep the length");
      assert(info.originalChecksum === sum && info.corruptedChecksum !== sum, "checksums in report wrong");
      assert(computeChecksum(await b.get("obj/chunk-0")) === sum, "replica on node B must be untouched");
    });

    await check("flaky disk damages new writes; turning it off restores normal writes", async () => {
      await registry.setFlakyDisk(nodes[0].id, true);
      const a = await sim(0);
      await a.put("flaky/chunk-0", original);
      assert(computeChecksum(await a.get("flaky/chunk-0")) !== sum, "flaky disk should store damaged bytes");
      await registry.setFlakyDisk(nodes[0].id, false);
      const a2 = await sim(0);
      await a2.put("flaky/chunk-0", original);
      assert(computeChecksum(await a2.get("flaky/chunk-0")) === sum, "healthy disk should store exact bytes");
    });

    await check("kill: node refuses I/O, data survives, revive restores access", async () => {
      await registry.killNode(nodes[1].id);
      const dead = await sim(1);
      let threw = false;
      try {
        await dead.get("obj/chunk-0");
      } catch (e) {
        threw = e instanceof NodeUnavailableError;
      }
      assert(threw, "crashed node must throw NodeUnavailableError");
      await registry.reviveNode(nodes[1].id);
      const alive = await sim(1);
      assert(computeChecksum(await alive.get("obj/chunk-0")) === sum, "data must survive a crash");
    });

    await check("partition: node unreachable while alive; heal restores access", async () => {
      await registry.setPartitioned(nodes[2].id, true);
      const cut = await sim(2);
      assert(cut.available === false, "partitioned node must be unavailable");
      let threw = false;
      try {
        await cut.put("p/chunk-0", original);
      } catch (e) {
        threw = e instanceof NodeUnavailableError;
      }
      assert(threw, "partitioned node must refuse writes");
      await registry.setPartitioned(nodes[2].id, false);
      const healed = await sim(2);
      assert(healed.available === true, "healed node must be available");
      await healed.put("p/chunk-0", original);
    });

    await check("failure detection: stale heartbeat -> OFFLINE; heartbeat -> HEALTHY; killed stays down", async () => {
      await db.node.update({
        where: { id: nodes[2].id },
        data: { lastHeartbeat: new Date(Date.now() - 60_000), isPartitioned: true },
      });
      const res = await detectFailures(new Date());
      assert(res.markedOffline.includes("s-3"), "s-3 should be declared OFFLINE");
      assert(!res.markedOffline.includes("s-1"), "s-1 (fresh heartbeat) must stay up");

      await registry.killNode(nodes[1].id);
      await simulateHeartbeats();
      assert((await registry.getNode(nodes[1].id)).status === "OFFLINE", "killed node must not be resurrected");
      assert((await registry.getNode(nodes[2].id)).status === "OFFLINE", "partitioned node cannot heartbeat");

      await registry.setPartitioned(nodes[2].id, false);
      assert((await registry.getNode(nodes[2].id)).status === "HEALTHY", "healed node should be HEALTHY");
      await registry.reviveNode(nodes[1].id);
    });

    await check("placement: least-loaded first; unavailable nodes only fill the gap", async () => {
      await registry.killNode(nodes[1].id);
      const cluster = await loadClusterNodes();
      const plan = chooseWriteTargets(cluster, 3);
      assert(plan.availableCount === 2, `expected 2 available, got ${plan.availableCount}`);
      assert(plan.targets.length === 3, "should still target 3 nodes");
      assert(plan.targets[2].name === "s-2", "the crashed node should be the filler target");
      const repl = pickReplacementNodes(cluster, new Set([nodes[0].id]), 1);
      assert(repl.length === 1 && repl[0].name === "s-3", "replacement must be an available node not excluded");
      await registry.reviveNode(nodes[1].id);
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