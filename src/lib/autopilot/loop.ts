// src/lib/autopilot/loop.ts
// Background self-healing loop.
//
// There is exactly ONE timer, ticking every HEARTBEAT_INTERVAL_MS. Each tick:
//   1. Always runs heartbeat + failure detection.
//   2. Runs scrub -> repair -> rebalance, in that order, but only once REPAIR_INTERVAL_MS has
//      elapsed since the last time that chain ran (so it keeps its own slower cadence).
// Both steps run strictly one after another inside the SAME tick, never in parallel, and a
// reentrancy guard skips a tick entirely if the previous tick's async work hasn't finished yet.
//
// Why one timer instead of two: the DB is reached through a single pooled connection (Supabase
// transaction pooler, connection_limit=1). Two independently-scheduled setIntervals — heartbeat on
// one cadence, repair/scrub/rebalance on another — can still fire concurrently with each other even
// though each is internally sequential. Worse, if either chain of queries ever takes longer than its
// own interval (a slow round trip to a remote Supabase instance, a burst of chaos actions, several
// nodes changing state at once), that timer's *own* next tick still fires on schedule, because
// setInterval never waits for the previous callback to finish — so a single loop can end up
// overlapping itself. Both failure modes showed up as intermittent "Timed out fetching a new
// connection from the connection pool" errors coming from heartbeat, scrub, and repair alike, even
// after scrub had already been consolidated into a single automatic source (checkpoint 4B). A single
// ticking timer with a reentrancy guard makes overlap structurally impossible: at most one automatic
// maintenance operation is ever touching the DB at a time, from any source.
//
// State is stored on globalThis so it survives Next.js dev-mode module reloads (HMR) instead of
// leaking a duplicate timer on every file save.

import { HEARTBEAT_INTERVAL_MS, REPAIR_INTERVAL_MS, SCRUB_BATCH_SIZE, autopilotDefault } from "@/config/policy";
import { runFailureDetectionCycle } from "@/lib/nodes/failureDetector";
import { repairCluster } from "@/lib/repair/repairEngine";
import { scrubCluster } from "@/lib/repair/scrub";
import { rebalanceCluster } from "@/lib/repair/rebalance";
import { emit } from "@/lib/events/bus";

interface AutopilotState {
  running: boolean;
  startedAt: string | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  // Reentrancy guard: true while a tick's async work (heartbeat, and — on the ticks where it runs —
  // scrub/repair/rebalance) is in flight. A new tick that finds this still true skips itself
  // entirely instead of starting a second, overlapping round of queries.
  tickInFlight: boolean;
  // Epoch ms of the last time the scrub/repair/rebalance chain ran; 0 forces it to run on the
  // very first tick after start.
  lastRepairRunAt: number;
  lastCycle: {
    heartbeat: string | null;
    repair: string | null;
    scrub: string | null;
  };
}

const g = globalThis as unknown as { __vaultAutopilot?: AutopilotState };

function state(): AutopilotState {
  if (!g.__vaultAutopilot) {
    g.__vaultAutopilot = {
      running: false,
      startedAt: null,
      tickTimer: null,
      tickInFlight: false,
      lastRepairRunAt: 0,
      lastCycle: { heartbeat: null, repair: null, scrub: null },
    };
  }
  return g.__vaultAutopilot;
}

// Runs one piece of the tick, tagging every error so one failing step never kills the timer itself.
async function safeRun(label: "heartbeat" | "repair", fn: () => Promise<unknown>) {
  try {
    await fn();
    state().lastCycle[label] = new Date().toISOString();
  } catch (err) {
    emit("autopilot.cycle_error", `Autopilot ${label} cycle failed: ${err instanceof Error ? err.message : String(err)}`, {
      level: "error",
      data: { cycle: label },
    });
  }
}

async function tick() {
  const s = state();
  if (s.tickInFlight) return; // previous tick is still using the one DB connection — skip, don't overlap
  s.tickInFlight = true;
  try {
    await safeRun("heartbeat", () => runFailureDetectionCycle());

    const now = Date.now();
    if (now - s.lastRepairRunAt >= REPAIR_INTERVAL_MS) {
      s.lastRepairRunAt = now;
      await safeRun("repair", async () => {
        // Detection (scrub) immediately before healing (repair), on this same chain — the only
        // place scrub runs automatically. Bounded batch so it can't hold the single pooled DB
        // connection long enough to starve heartbeat or anything else waiting on it.
        await scrubCluster(SCRUB_BATCH_SIZE);
        state().lastCycle.scrub = new Date().toISOString();
        await repairCluster();
        await rebalanceCluster();
      });
    }
  } finally {
    s.tickInFlight = false;
  }
}

export function startAutopilot(): AutopilotState {
  const s = state();
  if (s.running) return s;

  s.running = true;
  s.startedAt = new Date().toISOString();
  s.lastRepairRunAt = 0; // run the scrub/repair/rebalance chain on the first tick, then every REPAIR_INTERVAL_MS

  s.tickTimer = setInterval(() => {
    void tick();
  }, HEARTBEAT_INTERVAL_MS);

  emit(
    "autopilot.started",
    "Autopilot started: single tick loop — heartbeat every cycle, scrub/repair/rebalance every Nth cycle, never overlapping",
    {
      level: "success",
      data: {
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        repairIntervalMs: REPAIR_INTERVAL_MS,
        scrubBatchSize: SCRUB_BATCH_SIZE,
      },
    }
  );

  return s;
}

export function stopAutopilot(): AutopilotState {
  const s = state();
  if (!s.running) return s;

  if (s.tickTimer) {
    clearInterval(s.tickTimer);
    s.tickTimer = null;
  }
  s.running = false;
  emit("autopilot.stopped", "Autopilot stopped", { level: "info" });

  return s;
}

export function autopilotStatus() {
  const s = state();
  return {
    running: s.running,
    startedAt: s.startedAt,
    lastCycle: s.lastCycle,
    intervals: {
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      repairIntervalMs: REPAIR_INTERVAL_MS,
      // Scrub runs inside the tick's repair chain, on the repair cadence — report that real
      // cadence rather than the old (now-unused) standalone SCRUB_INTERVAL_MS so the dashboard's
      // "scrub every Ns" label stays accurate.
      scrubIntervalMs: REPAIR_INTERVAL_MS,
    },
  };
}

// Called once from instrumentation.ts at server startup.
export function initAutopilotFromEnv() {
  if (autopilotDefault() && !state().running) {
    startAutopilot();
  }
}
