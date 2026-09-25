# Vault

A self-healing, replicated object store built to demonstrate the core mechanics of a distributed
storage system — chunking, quorum-based replication, checksum-verified reads, background scrubbing,
automatic repair, and rebalancing — on top of Next.js, Prisma/Postgres (Supabase), and a small set of
simulated storage "nodes" (local disk folders or Vercel Blob).

There is no real network of machines here: nodes are rows in Postgres plus a folder/prefix in the
storage backend, and "chaos" (kill, partition, corrupt, flaky disk) is applied by flipping flags on
those rows. That's deliberate — it makes every failure mode reproducible on one laptop while keeping
the write/read/repair logic identical to what a real multi-node system would run.

See **[docs/DESIGN.md](docs/DESIGN.md)** for the full architecture, **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
for diagrams, and **[docs/REQUIREMENTS_MAPPING.md](docs/REQUIREMENTS_MAPPING.md)** for how each piece
of the demo pipeline maps to code.
## Live Deployment

**Live demo:** http://34.131.17.40

The current production deployment runs on Google Cloud Compute Engine with:
- Next.js coordinator behind Nginx
- 6 independent Docker storage nodes
- Supabase PostgreSQL for metadata
- Replication factor `N=3`
- Write quorum `W=2`
- Read quorum `R=2`

## What it does

- **Chunked, replicated writes.** Objects are split into fixed-size chunks; each chunk is written to
  `N` nodes (replication factor) and the write only succeeds once `W` of them durably ack it (write
  quorum).
- **Checksum-verified reads.** Every read recomputes a SHA-256 over the bytes it gets back and
  compares it to the checksum recorded at write time. A mismatch is never returned to the caller —
  the read falls through to the next replica and the bad one is flagged `CORRUPTED` on the spot.
- **Background scrub.** Independent of any read, a sweep periodically re-verifies stored bytes against
  their checksum, so silent bit rot on an object nobody has touched still gets found.
- **Automatic repair.** Any `CORRUPTED` or `MISSING` replica is healed by copying verified bytes from
  a healthy replica of the same chunk, with a post-write readback check before it's marked `SYNCED`.
- **Rebalance.** Under-replicated chunks (e.g. after a node join, or a long-dead node coming back) get
  fresh replicas placed on available nodes that don't already hold a copy.
- **Chaos controls.** Kill/revive a node, partition it (alive but unreachable), turn on a "flaky disk"
  (silently corrupts new writes), or directly corrupt an existing replica's stored bytes — all from the
  dashboard, to drive the self-healing loop on demand.
- **Live dashboard.** Node health, per-object replica state (down to the individual chunk/replica),
  autopilot status, chaos controls, and a live Server-Sent-Events feed of everything the system does.

## Tech stack

- **Next.js 16** (App Router, API routes) + React 19, TypeScript
- **Prisma 6** over **Postgres** (built and tested against Supabase's pooled connections)
- **Storage backend:** local disk (default) or Vercel Blob, behind one `StorageBackend` interface
- **Zod** for request validation

## Prerequisites

- Node.js 20+
- A Postgres database. This project was built against **Supabase**, specifically its **transaction
  pooler** (port 6543) for the app's own queries and the **session pooler** (port 5432) for
  migrations — see the connection-pool note below before you touch anything related to `DATABASE_URL`.

## Setup

```powershell
npm install
Copy-Item .env.example .env
# then edit .env: DATABASE_URL, DIRECT_URL, and anything else you want to change
npx prisma migrate deploy
npm run seed              # creates node-1..node-3 (idempotent)
```

`.env` is git-ignored; `.env.example` documents every variable (see the [Configuration](#configuration)
table below).

## Running it

```powershell
npm run dev
```

Open http://localhost:3000 — that's the dashboard. Autopilot starts automatically if
`VAULT_AUTOPILOT=on` is set (see [instrumentation.ts](src/instrumentation.ts)); otherwise start it
from the dashboard's header button.

Other scripts:

```powershell
npm run typecheck       # tsc --noEmit
npm run lint
npm run smoke           # scripted end-to-end check against a running dev server
npm run smoke:objects   # same, focused on the object read/write/quorum paths
npm run seed -- --reset --nodes=3   # wipe this cluster's data and start over with N fresh nodes
```

## Demo script

The dashboard's Chaos panel and "Run ___" buttons are built to walk through this sequence live:

1. **Upload** a file from the dashboard's upload form. It's chunked, replicated to `N` nodes, and
   only reported as written once `W` of them ack it.
2. **Replication** — expand the object's row ("Chunks") to see each chunk's per-node replica status.
3. **Node failure** — Chaos → kill a node. Its health tile flips to OFFLINE; the object is still
   fully readable from the remaining replicas (read quorum permitting).
4. **Read remains available** — download the object; bytes match, served from a surviving replica.
5. **Data corruption** — Chaos → "Corrupt replica" on a specific object/chunk/node. This damages the
   stored bytes directly; the DB metadata is deliberately left alone, so nothing shows a problem yet.
6. **Checksum detection** — the next scrub pass (or a read that happens to hit that replica) recomputes
   the checksum, finds the mismatch, and flags the replica `CORRUPTED`. Watch the live feed.
7. **Automatic repair** — the repair engine copies verified bytes from a healthy replica, does a
   post-write readback check, and flips the replica back to `SYNCED`.
8. **Scrub verification** — a follow-up scrub of that replica now reports it clean.
9. **Node recovery** — Chaos → revive the killed node. Its health tile flips back to HEALTHY.
10. **Rebalance** — the revived (or a newly-added) node picks up fresh replicas for any chunk that
    fell under its configured replication factor while it was down.

Every step above emits an event onto the live feed panel, so the whole pipeline is visible without
needing to look at logs.

## Configuration

All of these have defaults; only set what you want to change. See `.env.example` for the canonical list.

| Variable                       | Default             | Meaning                                                             |
| ------------------------------ | -------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`                 | —                     | Pooled connection string (app queries)                               |
| `DIRECT_URL`                   | —                     | Direct/session connection string (migrations)                        |
| `STORAGE_BACKEND`               | `local`               | `local` (disk under `VAULT_DATA_DIR`) or `blob` (Vercel Blob)         |
| `VAULT_DATA_DIR`                | `.vault-data`         | Root folder for the local storage backend                             |
| `BLOB_READ_WRITE_TOKEN`        | —                     | Required only when `STORAGE_BACKEND=blob`                             |
| `VAULT_CLUSTER`                 | `main`                | Logical cluster name; every query is scoped to it                     |
| `VAULT_N`                       | `3`                   | Default replication factor                                            |
| `VAULT_W`                       | `2`                   | Default write quorum                                                  |
| `VAULT_R`                       | `2`                   | Default read quorum                                                   |
| `VAULT_CHUNK_SIZE_BYTES`        | `4194304` (4 MiB)     | Chunk size                                                             |
| `VAULT_MAX_OBJECT_BYTES`        | `26214400` (25 MiB)   | Max object size accepted on write                                     |
| `VAULT_HEARTBEAT_INTERVAL_MS`   | `5000`                | Autopilot tick cadence (heartbeat runs every tick)                     |
| `VAULT_HEARTBEAT_TIMEOUT_MS`    | `15000`               | Silence before a node is marked DEGRADED / OFFLINE                    |
| `VAULT_REPAIR_INTERVAL_MS`      | `15000`               | Cadence of the scrub → repair → rebalance chain (runs on some ticks)  |
| `VAULT_SCRUB_BATCH_SIZE`        | `40`                  | Replicas verified per automatic scrub pass (see design notes below)   |
| `VAULT_AUTOPILOT`               | `off`                 | `on` to start the autopilot loop automatically at server boot         |

### A note on the connection pool

If your Postgres is reached through a transaction-mode pooler (Supabase's included one, PgBouncer in
transaction mode generally) with a low `connection_limit` (this project targets `connection_limit=1`
in `DATABASE_URL`), **every** automatic and user-triggered query in the whole process shares that one
connection. The autopilot loop is written around that constraint on purpose:

- It is a **single** ticking timer, not one timer per maintenance task — see
  [`src/lib/autopilot/loop.ts`](src/lib/autopilot/loop.ts) for why, and
  [docs/DESIGN.md](docs/DESIGN.md#autopilot-loop) for the full writeup.
- A tick that's still running skips the next one rather than overlapping it.
- The dashboard polls its panels sequentially, not concurrently, on one coordinated interval.

If you raise `VAULT_N`/node count a lot, or point this at a much higher-latency database, keep an eye
on `VAULT_SCRUB_BATCH_SIZE` and `VAULT_REPAIR_INTERVAL_MS` — see the design doc before just raising the
connection limit.

## Project layout

```
src/
  app/
    api/            REST + SSE routes (thin — validate input, call into src/lib, map errors)
    page.tsx         Dashboard (single-page React client)
  config/policy.ts   Replication policy + all tunable intervals/limits, env-driven
  lib/
    autopilot/       Background self-healing loop
    events/          In-process pub/sub -> SSE live feed
    integrity/       SHA-256 checksum helpers
    metadata/        Write/read coordinators (chunking, quorum enforcement, checksum verification)
    nodes/           Node registry, availability rules, heartbeat/failure detection, chaos actions
    repair/          Scrub, repair, rebalance, and the shared repair-log writer
    replication/     Placement (which nodes get a chunk) and quorum math
    storage/         StorageBackend interface + local/blob implementations + SimulatedNode
  types/             Shared TS types
prisma/              Schema + migrations
scripts/             seed / smoke test scripts
docs/                DESIGN.md, ARCHITECTURE.md, REQUIREMENTS_MAPPING.md
```
