// src/lib/events/bus.ts

export type EventLevel = "info" | "success" | "warn" | "error";

export interface VaultEvent {
  seq: number;
  ts: string;
  type: string; // e.g. "node.killed", "replica.corrupted", "repair.completed"
  level: EventLevel;
  message: string;
  data?: Record<string, unknown>;
}

type Listener = (event: VaultEvent) => void;

interface BusState {
  seq: number;
  buffer: VaultEvent[];
  listeners: Set<Listener>;
}

const MAX_EVENTS = 500;
const g = globalThis as unknown as { __vaultBus?: BusState };

function state(): BusState {
  if (!g.__vaultBus) g.__vaultBus = { seq: 0, buffer: [], listeners: new Set() };
  return g.__vaultBus;
}

export function emit(
  type: string,
  message: string,
  opts: { level?: EventLevel; data?: Record<string, unknown> } = {}
): VaultEvent {
  const s = state();
  const event: VaultEvent = {
    seq: ++s.seq,
    ts: new Date().toISOString(),
    type,
    level: opts.level ?? "info",
    message,
    data: opts.data,
  };
  s.buffer.push(event);
  if (s.buffer.length > MAX_EVENTS) s.buffer.splice(0, s.buffer.length - MAX_EVENTS);
  for (const listener of s.listeners) {
    try {
      listener(event);
    } catch {
      // a broken subscriber must never break the system
    }
  }
  return event;
}

// Newest last. `afterSeq` lets pollers ask only for what they have not seen yet.
export function recentEvents(limit = 100, afterSeq = 0): VaultEvent[] {
  const filtered = state().buffer.filter((e) => e.seq > afterSeq);
  return filtered.slice(-limit);
}

export function subscribe(listener: Listener): () => void {
  const s = state();
  s.listeners.add(listener);
  return () => {
    s.listeners.delete(listener);
  };
}

export function latestSeq(): number {
  return state().seq;
}