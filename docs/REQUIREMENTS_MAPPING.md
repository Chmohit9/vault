# Requirements mapping

The demo is built to walk through one continuous pipeline:

```
UPLOAD → REPLICATION → NODE FAILURE → READ REMAINS AVAILABLE → DATA CORRUPTION →
CHECKSUM DETECTION → AUTOMATIC REPAIR → SCRUB VERIFICATION → NODE RECOVERY → REBALANCE
```

This document maps each stage to the code that implements it, the API/dashboard control that
triggers or observes it, and how to verify it actually happened. For the architecture behind each
piece, see [DESIGN.md](DESIGN.md); for diagrams, see [ARCHITECTURE.md](ARCHITECTURE.md).

| # | Stage | Implemented by | Triggered via | Verify it happened |
|---|-------|-----------------|----------------|----------------------|
| 1 | **Upload** | `putObject` — `src/lib/metadata/writeCoordinator.ts` | Dashboard upload form → `POST /api/objects` | Response includes `version`, `chunkCount`, `nodesUsed`; object appears in the dashboard's object table; live feed shows `object.written` |
| 2 | **Replication** | `selectWriteTargets` / `chooseWriteTargets` — `src/lib/replication/placement.ts`; per-chunk writes to all `N` targets — `writeCoordinator.ts` | Automatic, part of every upload | Expand the object's row ("Chunks") — each chunk shows `N` replica pills, one per node, `SYNCED` |
| 3 | **Node failure** | `killNode` — `src/lib/nodes/registry.ts` (`isCrashed = true`, `status = OFFLINE`) | Dashboard Chaos panel → **Kill node**, or `POST /api/chaos/kill { nodeId }` | Node's health tile flips to `OFFLINE`; live feed shows `node.killed`; `GET /api/nodes` reflects `available: false` |
| 4 | **Read remains available** | `getObject` — `src/lib/metadata/readCoordinator.ts`: ranks only *available* replicas, tries each until one checksums correctly | Download button, or `GET /api/objects/<key>` | Download succeeds; bytes match the original; response includes `X-Vault-Checksum` matching what was uploaded, served from a surviving node |
| 5 | **Data corruption** | `corruptReplica` — `src/lib/nodes/chaos.ts` (damages stored bytes directly; **DB status is deliberately left `SYNCED`**) | Dashboard Chaos panel → **Corrupt replica** (object key / chunk / optional node), or `POST /api/chaos/corrupt` | Live feed shows `replica.corrupted`; `GET /api/objects/<key>?meta=1` still shows that replica as `SYNCED` — proving detection hasn't happened yet |
| 6 | **Checksum detection** | `scrubCluster` — `src/lib/repair/scrub.ts` (background, runs inside the autopilot tick), and/or `getObject`'s read-repair check — `readCoordinator.ts` | Automatic, on the next scrub tick (`VAULT_REPAIR_INTERVAL_MS`-ish cadence) or a read that happens to hit the bad replica; manual: `POST /api/repair/scrub` | Live feed shows `replica.checksum_mismatch` / `Scrub found corruption: key#idx@node`; `?meta=1` now shows that replica as `CORRUPTED` |
| 7 | **Automatic repair** | `repairCluster` — `src/lib/repair/repairEngine.ts`: copy from a healthy `SYNCED` source, write to the broken replica, **read back and re-verify** before marking `SYNCED` | Automatic, same autopilot tick right after scrub; manual: `POST /api/repair/run` | Live feed shows `replica.repaired` / `Repaired key#idx@node from <source>`; `RepairLog` row with `type=REPLICA_REPAIR, success=true` |
| 8 | **Scrub verification** | `scrubCluster` re-scans the now-repaired replica on a later batch (it's no longer at the front of the least-recently-verified queue, but a manual `POST /api/repair/scrub` re-checks everything) | Automatic on a later cycle, or manual **Run scrub** button | Live feed shows a scrub summary with `0 corrupted` for that replica; `?meta=1` shows `SYNCED` with a fresh `lastVerifiedAt` |
| 9 | **Node recovery** | `reviveNode` — `src/lib/nodes/registry.ts` (`isCrashed = false`, `status = HEALTHY`, fresh heartbeat) | Dashboard Chaos panel → **Revive node**, or `POST /api/chaos/revive` | Node's health tile flips back to `HEALTHY`; live feed shows `node.revived` |
| 10 | **Rebalance** | `rebalanceCluster` — `src/lib/repair/rebalance.ts`: tops up any chunk whose available-`SYNCED`-replica count fell below its replication factor while the node was down | Automatic, same autopilot tick after repair; manual: `POST /api/repair/rebalance` | Live feed shows `replica.rebalanced` / `Placed new replica key#idx->node` if anything was under-replicated (with only 1 node down and `RF ≥ 2` surviving, this step may correctly report `0 added` — that's expected, not a bug, since a chunk with even one remaining healthy replica isn't necessarily under its target `N` if the down node's slot is still counted once it's `SYNCED` again) |

## Verifying end to end in one sitting

The `hello_after_*.txt` files at the project root are exactly this checklist, captured as actual
downloaded bytes at each stage during development (`hello_after_corrupt.txt` — still identical, since
corruption alone doesn't change what a healthy read returns; `hello_after_repair.txt`,
`hello_after_fix_verified.txt`, `hello_after_kill.txt`, `hello_after_rebalance.txt`). Reproduce them
yourself with:

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/objects/hello.txt" -OutFile hello_check.txt
Compare-Object (Get-Content hello_check.txt) (Get-Content hello_original.txt)
```
(empty output = identical).

## Supporting requirements (beyond the pipeline)

These aren't a separate demo step, but they're what makes the pipeline above trustworthy rather than
scripted:

| Requirement | Where it's enforced |
|---|---|
| Configurable replication factor / write quorum / read quorum (`N`/`W`/`R`), per-object override | `DEFAULT_POLICY` + `validatePolicy` — `src/config/policy.ts`; accepted per-upload via `policyOverride` in `putObject` |
| A write never reports success without durable quorum | `hasWriteQuorum` gate + rollback (`deleteBestEffort`) in `writeCoordinator.ts` phase 2 |
| A read never returns bytes that don't match their recorded checksum | Every candidate replica is checksum-verified in `readCoordinator.ts`; a mismatch is skipped, never returned |
| Corruption must be *discovered*, not pre-flagged | `corruptReplica` intentionally leaves `Replica.status` unchanged — see stage 5 above |
| A repair must be *verified*, not assumed | Post-write readback + re-checksum in `repairCluster` before marking `SYNCED` |
| Self-healing runs without operator action once enabled | Autopilot loop — `src/lib/autopilot/loop.ts`; `VAULT_AUTOPILOT=on` starts it at server boot (`src/instrumentation.ts`) |
| Every self-healing / chaos action is audited | `RepairLog` (`src/lib/repair/log.ts`) and `ChaosEvent` (`src/lib/nodes/registry.ts: logChaos`) tables, independent of the ephemeral live feed |
| The system behaves correctly under a real, low connection-limit database (no architecture change to work around it) | Single reentrancy-guarded autopilot tick + sequential dashboard polling — see [DESIGN.md § Autopilot loop](DESIGN.md#autopilot-loop) |
