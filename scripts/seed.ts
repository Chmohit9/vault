// scripts/seed.ts
// Usage:  npm run seed                          -> ensure node-1..node-3 exist
//         npm run seed -- --reset --nodes=3     -> wipe this cluster's data, then create 3 fresh nodes
import "dotenv/config";
import { rm } from "fs/promises";
import path from "path";
import { PrismaClient } from "../src/generated/prisma/client";

const db = new PrismaClient();

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=")[1] : "true";
}

async function main() {
  const cluster = process.env.VAULT_CLUSTER || "main";
  const count = Math.max(1, Number.parseInt(arg("nodes") ?? "3", 10) || 3);
  const reset = arg("reset") !== undefined;

  if (reset) {
    console.log(`Resetting cluster "${cluster}" (objects, replicas, logs, nodes, local data)...`);
    await db.storedObject.deleteMany({ where: { cluster } }); // cascades to chunks + replicas
    await db.repairLog.deleteMany({ where: { cluster } });
    await db.chaosEvent.deleteMany({ where: { cluster } });
    await db.node.deleteMany({ where: { cluster } });

    if ((process.env.STORAGE_BACKEND ?? "local").toLowerCase() === "local") {
      const dir = path.resolve(process.cwd(), process.env.VAULT_DATA_DIR || ".vault-data");
      const cwd = process.cwd();
      if (dir === cwd || cwd.startsWith(dir + path.sep)) {
        console.warn(`  skipped deleting ${dir} (it contains the project folder)`);
      } else {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }

  for (let i = 1; i <= count; i++) {
    const name = `node-${i}`;
    await db.node.upsert({
      where: { cluster_name: { cluster, name } },
      update: {},
      create: {
        cluster,
        name,
        backendPrefix: `${cluster}/${name}`,
        status: "HEALTHY",
        lastHeartbeat: new Date(),
      },
    });
    console.log(`  ready: ${name}`);
  }

  const total = await db.node.count({ where: { cluster } });
  console.log(`Done. Nodes in cluster "${cluster}": ${total}`);
}

main()
  .catch((e) => {
    console.error("Seeding failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());