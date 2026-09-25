# Design

This documents *how* Vault works and *why* it's built the way it is. For diagrams see
[ARCHITECTURE.md](ARCHITECTURE.md); for a requirement-by-requirement checklist see
[REQUIREMENTS_MAPPING.md](REQUIREMENTS_MAPPING.md).

## Goals

Vault exists to demonstrate — with code you can actually read end to end in an afternoon — the parts
of a distributed object store that are usually hidden behind a managed service:

1. Splitting an object into chunks and replicating each chunk across multiple storage nodes.
2. Quorum-based writes and reads (Dynamo-style `N`/`W`/`R`), including what happens when they can't
   be satisfied.
3. Detecting corruption via checksums — both reactively (on read) and proactively (background scrub).
4. Automatically repairing what scrub/read-repair finds, with a verified write-then-readback, not a
   "wrote it, assume it's fine."
5. Rebalancing so a chunk that fell under its replication factor (node down, or newly joined) gets
   back up to full health without operator intervention.
6. Doing all of the above visibly — every state change is an event, which is what the dashboard's
   live feed is showing.

Non-goals: this is not trying to be fast, horizontally scale to real node counts, or handle network
partitions with anything more sophisticated than "can the coordinator reach this node right now" — see
[Limitations](#limitations).

## Data model

See the ER diagram in [ARCHITECTURE.md](ARCHITECTURE.md#2-data-model). In short:

- **Node** — a storage node's health/chaos state (`status`, `isCrashed`, `isPartitioned`,
  `isCorrupting`) plus `backendPrefix`, its namespace inside the shared storage backend.
- **StoredObject** — one logical object (`key`, version, whole-object checksum, and its `N`/`W`/`R`
  policy). A new `PUT` to an existing key creates a new version and replaces its chunk set.
- **Chunk** — one fixed-size slice of an object's bytes, with its own checksum.
- **Replica** — one copy of one chunk on one node: `storageKey` (where the bytes live), its own
  `checksum`, and a `status` (`SYNCED | STALE | CORRUPTED | MISSING | REPAIRING`).
- **RepairLog / ChaosEvent** — an audit trail. `RepairLog` records every scrub/repair/rebalance/
  failover action (success or failure); `ChaosEvent` records every chaos action a user triggered. The
  live feed (`src/lib/events/bus.ts`) is a separate, in-memory, ephemeral stream for the dashboard —
  these DB tables are the durable record.

A node's storage location is `<StorageBackend root>/<node.backendPrefix>/<replica.storageKey>`, e.g.
`.vault-data/main/node-2/<objectId>/v1/c0` for the local backend — genuinely a folder you can open and
inspect while the demo runs.

## Write path (`src/lib/metadata/writeCoordinator.ts`)

1. Validate the key and size; resolve the effective `{N, W, R}` policy (per-request override, falling
   back to `.env` defaults); validate it (`W`, `R` ≤ `N`, etc).
2. Look up the existing object (if any) for optimistic-concurrency (`ifVersion`) and version bumping.
3. `selectWriteTargets(N)` — pick `N` nodes via placement (see below); if fewer than `W` of them are
   currently available, fail fast with a `QuorumError` before writing any bytes.
4. Split the payload into fixed-size chunks (`VAULT_CHUNK_SIZE_BYTES`), compute each chunk's checksum
   and the whole-object checksum.
5. **Phase 1 — write bytes.** For every (chunk, target node) pair, attempt the write independently; one
   unreachable node must not block the others.
6. **Phase 2 — enforce quorum per chunk.** If any chunk didn't reach `W` successful writes, the whole
   object write is rejected and every byte written in phase 1 is best-effort deleted (`deleteBestEffort`)
   — no partial object is ever left looking committed.
7. **Phase 3 — commit metadata transactionally.** `StoredObject`/`Chunk`/`Replica` rows are written in
   one Prisma transaction. Nodes that actually got the write are `SYNCED`; nodes that failed are
   recorded as `MISSING` replicas immediately, so repair already knows about them on the very next
   cycle rather than waiting to discover it later.
8. The previous version's bytes are garbage-collected only after the new version's metadata is
   durably committed.

## Read path (`src/lib/metadata/readCoordinator.ts`)

For each chunk, replicas are ranked (available nodes only, `SYNCED` before `STALE` before others, most
recently verified first) and tried **in order, but not stopping at the first success** — every
available replica is checked, because a read is also this chunk's opportunistic integrity check:

- A replica whose bytes checksum-match is a candidate for serving the read; the first match found is
  what's returned.
- A replica whose bytes checksum-mismatch is immediately flagged `CORRUPTED` in the DB and emitted as
  an event — this is "read-repair discovery," independent of the scrub sweep.
- If fewer replicas are reachable than the object's read quorum, that's logged as a degraded-quorum
  warning but the read still proceeds if at least one valid replica was found — read quorum here is a
  health signal, not a hard gate on availability (a hard gate would make "read still works with one
  node down" impossible to demo cleanly with small `N`/`R`).
- If no chunk replica checksums correctly, the read fails with a `QuorumError` rather than ever
  returning bytes that don't match their recorded checksum.

## Replication: placement and quorum

**Placement** (`src/lib/replication/placement.ts`) is deliberately simple and deterministic: among
available nodes, pick the `N` (or fewer, for a rebalance top-up) with the fewest existing replicas,
ties broken by name — a basic least-loaded strategy, no consistent hashing or rack/zone awareness. If
not enough nodes are available, the remaining slots are filled with unavailable nodes so the write
coordinator can still enforce `W` correctly and record the rest as `MISSING` for repair to pick up
later.

**Quorum** (`src/lib/replication/quorum.ts`) is intentionally pure/stateless functions:

- `hasWriteQuorum(attempts, W)` — at least `W` of the attempted writes must have succeeded.
- `resolveReadQuorum(attempts, R)` — among successful reads, the checksum value that at least `R`
  replicas agree on wins; this is how the system would resolve *disagreement* between replicas if it
  ever had to (in practice, checksum verification against the chunk's recorded checksum means
  disagreement almost never reaches this function — a mismatching replica is rejected before it gets
  here — but the function exists as the formal quorum-resolution step Dynamo-style systems document).

## Failure detection (`src/lib/nodes/failureDetector.ts`)

Two steps, both part of every heartbeat tick:

- `simulateHeartbeats()` — every node that is *not* crashed and *not* partitioned "checks in":
  `lastHeartbeat = now`, `status = HEALTHY`. This models what a real node agent would be doing on its
  own cadence; here it's driven by the same tick for determinism.
- `detectFailures()` — for every node, if its heartbeat is older than `HEARTBEAT_TIMEOUT_MS`, mark it
  `OFFLINE` (and log a `NODE_FAILOVER` repair-log entry); if it's older than half that, mark it
  `DEGRADED`. Updates are conditional (`where: { status: node.status, lastHeartbeat: ... }`) so a
  heartbeat that lands concurrently isn't clobbered.

`isNodeAvailable()` (`src/lib/nodes/availability.ts`) is the single source of truth for "can the
coordinator talk to this node right now": not `OFFLINE`, not partitioned, not crashed. Every read,
write, scrub, repair, and rebalance path calls this — there is exactly one definition of availability
in the whole system.

## Self-healing: scrub, repair, rebalance

- **Scrub** (`src/lib/repair/scrub.ts`) — takes a bounded batch of replicas, oldest-`lastVerifiedAt`
  first (so repeated runs make steady progress across the whole cluster rather than re-checking the
  same replicas), reads each one's actual stored bytes from its node, and compares the checksum to
  what's recorded on the chunk. A match refreshes `lastVerifiedAt`/`SYNCED`; a mismatch flags
  `CORRUPTED` and logs it. This is how bit rot on an object nobody has read gets found.
- **Repair** (`src/lib/repair/repairEngine.ts`) — for every `CORRUPTED`/`MISSING` replica on an
  available node, finds a `SYNCED` replica of the same chunk on a different available node, copies its
  bytes, **then reads the newly-written bytes back and re-checksums them** before marking the target
  `SYNCED` — a write that silently landed wrong (e.g. the target has "flaky disk" chaos on) is caught
  here rather than being reported as a successful repair.
- **Rebalance** (`src/lib/repair/rebalance.ts`) — for every chunk whose count of `SYNCED` replicas on
  available nodes is below its object's replication factor, places additional replicas on available
  nodes that don't already hold a copy (least-loaded first), copying from any currently-healthy
  replica. This is what brings a chunk back up to full redundancy after a node comes back from a long
  outage, or after a new node joins.

All three write to a shared `RepairLog` (`src/lib/repair/log.ts`) and emit live-feed events, so both
the durable audit trail and the dashboard reflect the same actions.

## Autopilot loop

`src/lib/autopilot/loop.ts` runs all of the above automatically. This module went through two rounds
of hardening worth documenting, because the reasoning generalizes to any background job sharing a
connection-pool-limited database:

**Round 1 — one automatic scrub source, not two.** An earlier version had the repair tick call a
bounded `scrubCluster(100)` *and* a separate standalone `setInterval` calling the full
`scrubCluster()` on its own slower cadence — two independent automatic scrub passes that could run
concurrently. Fixed by removing the standalone timer entirely: scrub now runs only from inside the
repair tick, bounded by `VAULT_SCRUB_BATCH_SIZE` so one batch can't hold the connection too long.
Coverage of the whole cluster still completes over a few ticks, since scrub always scans
least-recently-verified replicas first.

**Round 2 — one timer, not two, with a reentrancy guard.** Even after (1), heartbeat and
repair/scrub/rebalance were still two independently-scheduled timers (5s and 15s by default). Against
a database reached through a pooler with `connection_limit=1`, that's still a problem two ways:

- The two timers can fire at the same wall-clock moment as each other.
- `setInterval` does not wait for its callback to finish. If a tick's chain of sequential queries ever
  takes longer than its own interval (a slow round trip to a remote database, several nodes changing
  state around the same time), the *same* timer's next tick fires anyway — so a single loop can end up
  overlapping itself, and once that starts happening it tends to compound (each new overlapping tick
  adds more queued work rather than less).

Both were observed in practice as intermittent Prisma `"Timed out fetching a new connection from the
connection pool"` errors surfacing from heartbeat, scrub, *and* repair — even after round 1's fix,
because round 1 only removed the *redundant* scrub source, not the *structural* possibility of overlap
between any of the automatic loops.

The fix: **exactly one `setInterval`**, ticking at `HEARTBEAT_INTERVAL_MS`. Every tick:

1. If the previous tick's async work hasn't finished, skip this tick entirely (reentrancy guard —
   overlap becomes structurally impossible, not just unlikely).
2. Otherwise run heartbeat + failure detection.
3. If `REPAIR_INTERVAL_MS` has elapsed since the chain last ran, run `scrub → repair → rebalance`, in
   that order, still inside the same tick.

See the diagram in [ARCHITECTURE.md](ARCHITECTURE.md#4-autopilot-tick-internally). State (the timer
handle, the reentrancy flag, cadence bookkeeping, last-run timestamps for the dashboard) is stored on
`globalThis` so it survives Next.js dev-mode module reloads instead of leaking a duplicate timer on
every file save.

**Dashboard polling follows the same principle.** `src/app/page.tsx` fetches its panels (health, nodes,
objects, autopilot status, and — if a row is expanded — that object's chunk detail) sequentially, on
one coordinated interval, instead of firing several concurrent `fetch()` calls on independent timers.
Same underlying constraint, same fix shape: don't ask a single-connection database to serve several
things "at once" when it can only actually do one at a time anyway.

## Chaos engineering surface

All chaos actions operate on real state, not a mock:

| Action | What it actually does | Where |
| --- | --- | --- |
| Kill node | `isCrashed = true`, `status = OFFLINE`. Data is untouched — a crash is not data loss. | `nodes/registry.ts: killNode` |
| Revive node | `isCrashed = false`, `status = HEALTHY`, fresh heartbeat. | `nodes/registry.ts: reviveNode` |
| Partition | `isPartitioned = true` — process "alive" but unreachable; can't heartbeat or serve reads/writes. | `nodes/registry.ts: setPartitioned` |
| Flaky disk | `isCorrupting = true` — every *new* write to this node is silently damaged (XORs the middle byte) before being stored. | `nodes/registry.ts: setFlakyDisk`, `storage/simulatedNode.ts` |
| Corrupt replica | Damages the bytes of an **existing** stored replica directly on disk/blob, and deliberately leaves the DB `status` unchanged — the whole point is that this must be *discovered*, not pre-flagged. | `nodes/chaos.ts: corruptReplica` |

`isNodeAvailable()` gates every data-path operation on `isCrashed`/`isPartitioned`/`status`, so kill and
partition both make a node's replicas unreachable for reads/writes/repair without touching a single
byte of its stored data — reviving it (or healing the partition) makes that same data reachable again
immediately, no re-sync needed unless it fell behind on writes while it was down (that's rebalance's
job).

## Storage backends

One interface (`src/lib/storage/backend.ts`: `put`/`get`/`delete`/`exists`), two implementations,
chosen once per process by `STORAGE_BACKEND`:

- **LocalBackend** — files under `VAULT_DATA_DIR/<node backendPrefix>/<storageKey>`, written via a
  temp-file-then-atomic-rename so a crash mid-write can't leave a half-written file where an object
  should be.
- **BlobBackend** — Vercel Blob, for a deployed/serverless demo where there's no shared local disk.

`SimulatedNode` sits on top of this: it's "a node" from the data path's point of view — every
`put`/`get` first checks `isNodeAvailable()` and throws `NodeUnavailableError` if not, and `put`
applies the "flaky disk" corruption if that chaos flag is set. `corruptExisting()` is the one method
that deliberately bypasses the availability check, because a disk can rot whether or not the node
happens to be reachable right now.

## Events and the dashboard

`src/lib/events/bus.ts` is a tiny in-process pub/sub with a ring buffer (last 500 events). Every
meaningful state change (`emit(...)`) — writes, reads, corruption found, repairs, rebalances, node
kills/revives, autopilot start/stop/errors — goes through it. `/api/events` serves it as
Server-Sent-Events: backlog first (everything after `?after=<seq>`, or the last 100), then a live
stream, with a periodic keep-alive comment so proxies don't drop an idle connection. The dashboard
holds exactly one `EventSource` for this; it's the one part of the UI that isn't polled.

## API surface

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/objects` | GET / POST | List objects / upload (multipart) |
| `/api/objects/[...key]` | GET | Raw bytes, or `?meta=1` for chunk/replica detail |
| `/api/nodes` | GET / POST | List nodes with per-node replica stats / register a node |
| `/api/nodes/[id]` | GET | One node's detail |
| `/api/nodes/[id]/heartbeat` | POST | Manually deliver a heartbeat |
| `/api/health` | GET | Cluster-wide counts (nodes, objects, corrupted replicas) |
| `/api/autopilot/start` \| `/stop` \| `/status` | POST / POST / GET | Control and observe the autopilot loop |
| `/api/repair/run` \| `/scrub` \| `/rebalance` | POST | Manually trigger one cycle of each (independent of autopilot) |
| `/api/maintenance/tick` | POST | Manually run one heartbeat + failure-detection cycle |
| `/api/chaos/kill` \| `/revive` \| `/partition` \| `/flaky` \| `/corrupt` | POST | Chaos actions (see table above) |
| `/api/events` | GET | Server-Sent-Events live feed |

Every JSON route responds `{ success: true, ...data }` or `{ success: false, error, code, details? }`
(`src/lib/http.ts`); errors are typed (`src/lib/errors.ts`) and mapped to HTTP status codes
(400 validation, 404 not found, 409 conflict/version race, 503 quorum/node-unavailable).

## Limitations

Worth being upfront about, since this is a teaching/demo system rather than a production one:

- **Single-process, single-cluster-at-a-time semantics.** "Nodes" share one Postgres and one storage
  backend; there's no real network partition, just a flag that makes a node's data unreachable through
  this one coordinator.
- **No consistent hashing / rebalancing on membership changes beyond under-replication.** Placement is
  least-loaded, not a ring; adding a node doesn't reshuffle existing well-replicated chunks toward it.
- **Read quorum is advisory, not enforced as a hard minimum.** See the read-path note above — this is
  a deliberate choice for demo clarity with small `N`/`R`, not an oversight, but it's a deviation from
  a strict Dynamo-style read path.
- **The connection-pool constraint is real and intentional**, not simulated — this project targets a
  free-tier-style pooled Postgres connection on purpose, because working within that constraint (see
  [Autopilot loop](#autopilot-loop) above) is itself part of what's being demonstrated.
