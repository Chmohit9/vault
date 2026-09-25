// scripts/register-http-nodes.ts
// Points node-1..node-N at the real Docker Compose storage-node cluster (apps/storage-node) by
// setting their baseUrl. Existing simulated nodes of the same name are converted in place — no data
// migration, since a node's replicas just start being served by getStorageNode() through the HTTP
// path from here on (see src/lib/storage/storageNode.ts).
//
// Usage:
//   npm run register:http-nodes                   -> node-1..node-6 at http://localhost:4101..4106
//   npm run register:http-nodes -- --nodes=3       -> only node-1..node-3
//   npm run register:http-nodes -- --unregister    -> set baseUrl back to null (revert to simulated)
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";

const db = new PrismaClient();

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=")[1] : "true";
}

async function main() {
  const cluster = process.env.VAULT_CLUSTER || "main";
  const count = Math.max(1, Number.parseInt(arg("nodes") ?? "6", 10) || 6);
  const unregister = arg("unregister") !== undefined;

  for (let i = 1; i <= count; i++) {
    const name = `node-${i}`;
    const baseUrl = unregister ? null : `http://localhost:410${i}`;
    await db.node.upsert({
      where: { cluster_name: { cluster, name } },
      update: { baseUrl },
      create: {
        cluster,
        name,
        backendPrefix: `${cluster}/${name}`,
        baseUrl,
        status: "HEALTHY",
        lastHeartbeat: new Date(),
      },
    });
    console.log(`  ${name}: baseUrl = ${baseUrl ?? "null (simulated)"}`);
  }

  console.log(
    unregister
      ? "Done. Nodes reverted to the simulated backend."
      : "Done. Make sure `docker compose up -d` is running so these URLs actually answer."
  );
}

main()
  .catch((e) => {
    console.error("register-http-nodes failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());