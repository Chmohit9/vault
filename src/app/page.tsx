"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types (mirror the API response shapes in src/app/api/** and src/lib/**)
// ---------------------------------------------------------------------------

type NodeStatus = "HEALTHY" | "OFFLINE" | "DEGRADED";
type ReplicaStatus = "SYNCED" | "STALE" | "CORRUPTED" | "MISSING" | "REPAIRING";

interface NodeView {
  id: string;
  name: string;
  status: NodeStatus;
  available: boolean;
  isCrashed: boolean;
  isPartitioned: boolean;
  flakyDisk: boolean;
  lastHeartbeat: string;
  heartbeatAgeMs: number;
  replicas: { total: number; synced: number; corrupted: number; missing: number; stale: number; repairing: number };
}

interface ObjectSummary {
  key: string;
  size: number;
  version: number;
  contentType: string | null;
  checksum: string;
  replicationFactor: number;
  writeQuorum: number;
  readQuorum: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ObjectMeta {
  key: string;
  size: number;
  version: number;
  contentType: string | null;
  checksum: string;
  replicationFactor: number;
  writeQuorum: number;
  readQuorum: number;
  createdAt: string;
  updatedAt: string;
  chunks: {
    index: number;
    size: number;
    checksum: string;
    replicas: { node: string; status: ReplicaStatus; version: number; lastVerifiedAt: string | null }[];
  }[];
}

interface AutopilotStatus {
  running: boolean;
  startedAt: string | null;
  lastCycle: { heartbeat: string | null; repair: string | null; scrub: string | null };
  intervals: { heartbeatIntervalMs: number; repairIntervalMs: number; scrubIntervalMs: number };
}

interface Health {
  status: string;
  totalNodes: number;
  healthyNodes: number;
  totalObjects: number;
  corruptedReplicas: number;
}

interface VaultEvent {
  seq: number;
  ts: string;
  type: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fetch helper — every route replies { success, ...data } or { success:false, error, code }
// (except /api/health, which is a plain object).
// ---------------------------------------------------------------------------

async function api<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.success === false)) {
    const message = (json && (json.error as string)) || `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return json as T;
}

function objectPath(key: string, suffix = ""): string {
  return `/api/objects/${key.split("/").map(encodeURIComponent).join("/")}${suffix}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

const REPLICA_TONE: Record<ReplicaStatus, string> = {
  SYNCED: "text-[#34D399] border-[#34D399]/35 bg-[#34D399]/10",
  STALE: "text-[#F5A623] border-[#F5A623]/35 bg-[#F5A623]/10",
  CORRUPTED: "text-[#F0554C] border-[#F0554C]/35 bg-[#F0554C]/10",
  MISSING: "text-[#7C8698] border-[#7C8698]/35 bg-[#7C8698]/10",
  REPAIRING: "text-[#5B8DEF] border-[#5B8DEF]/35 bg-[#5B8DEF]/10",
};

const NODE_TONE: Record<NodeStatus, string> = {
  HEALTHY: "text-[#34D399] border-[#34D399]/35 bg-[#34D399]/10",
  DEGRADED: "text-[#F5A623] border-[#F5A623]/35 bg-[#F5A623]/10",
  OFFLINE: "text-[#F0554C] border-[#F0554C]/35 bg-[#F0554C]/10",
};

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-mono leading-none ${tone}`}>
      {children}
    </span>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[#262E3D] bg-[#12161F]">
      <div className="flex items-center justify-between border-b border-[#262E3D] px-4 py-2.5">
        <h2 className="text-[13px] font-medium text-[#EAECEF]">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Button({
  children,
  onClick,
  busy,
  tone = "default",
  disabled,
  small,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  tone?: "default" | "danger" | "primary";
  disabled?: boolean;
  small?: boolean;
}) {
  const toneClass =
    tone === "danger"
      ? "border-[#F0554C]/40 text-[#F0554C] hover:bg-[#F0554C]/10"
      : tone === "primary"
        ? "border-[#5B8DEF]/50 text-[#5B8DEF] hover:bg-[#5B8DEF]/10"
        : "border-[#2E3646] text-[#C4CBD8] hover:bg-[#1A202C]";
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`rounded-md border ${small ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-xs"} font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClass}`}
    >
      {busy ? "…" : children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [objects, setObjects] = useState<ObjectSummary[]>([]);
  const [autopilot, setAutopilot] = useState<AutopilotStatus | null>(null);
  const [events, setEvents] = useState<VaultEvent[]>([]);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [objectMeta, setObjectMeta] = useState<Record<string, ObjectMeta>>({});

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const [addNodeName, setAddNodeName] = useState("");
  const [uploadKey, setUploadKey] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadRF, setUploadRF] = useState("");

  const [corruptObjectKey, setCorruptObjectKey] = useState("");
  const [corruptChunkIndex, setCorruptChunkIndex] = useState("0");
  const [corruptNodeId, setCorruptNodeId] = useState("");

  const feedRef = useRef<HTMLDivElement | null>(null);

  const notify = useCallback((tone: "error" | "success", text: string) => {
    setBanner({ tone, text });
    window.setTimeout(() => setBanner((b) => (b?.text === text ? null : b)), 4000);
  }, []);

  // Sequential, not Promise.all/allSettled: the DB sits behind a single pooled connection
  // (Supabase transaction pooler, connection_limit=1), so firing these concurrently just queues
  // them all on that one connection instead of actually running them in parallel — and under any
  // load (autopilot's own scrub/repair/rebalance tick, chaos actions, etc.) that queueing can run
  // long enough to trip the pool's connection-checkout timeout. Awaiting one at a time keeps at
  // most one dashboard-driven query in flight. Each call is independently try/caught so one slow
  // or failing endpoint doesn't block the rest of the cycle or blank out state that's still good.
  const refreshAll = useCallback(async () => {
    try {
      setHealth(await api<Health>("/api/health"));
    } catch {
      // keep last known-good value
    }
    try {
      setNodes((await api<{ nodes: NodeView[] }>("/api/nodes")).nodes);
    } catch {
      // keep last known-good value
    }
    try {
      setObjects((await api<{ objects: ObjectSummary[] }>("/api/objects")).objects);
    } catch {
      // keep last known-good value
    }
    try {
      setAutopilot(await api<AutopilotStatus & { success: true }>("/api/autopilot/status"));
    } catch {
      // keep last known-good value
    }
  }, []);

  const refreshExpandedMeta = useCallback(async (key: string) => {
    const json = await api<{ object: ObjectMeta }>(objectPath(key, "?meta=1"));
    setObjectMeta((m) => ({ ...m, [key]: json.object }));
  }, []);

  // Single coordinated refresh cycle, every 4s: the core panels first, then (only if a row is
  // expanded) that object's chunk/replica detail — all sequential, all on one interval, instead of
  // two independent intervals that could each fire their own burst of requests at the same time.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      await refreshAll();
      if (expandedKey && !cancelled) {
        try {
          await refreshExpandedMeta(expandedKey);
        } catch {
          // keep last known-good value
        }
      }
    };
    void tick();
    const t = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [expandedKey, refreshAll, refreshExpandedMeta]);

  // Live event feed via SSE.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as VaultEvent;
        setEvents((prev) => {
          if (prev.some((e) => e.seq === event.seq)) return prev;
          const next = [...prev, event];
          return next.length > 300 ? next.slice(next.length - 300) : next;
        });
      } catch {
        // ignore malformed frame
      }
    };
    return () => es.close();
  }, []);

  // Auto-scroll the feed to the newest event.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events]);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, successText?: string) => {
      setBusyKey(key);
      try {
        await fn();
        if (successText) notify("success", successText);
        await refreshAll();
        if (expandedKey) await refreshExpandedMeta(expandedKey);
      } catch (err) {
        notify("error", err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [refreshAll, refreshExpandedMeta, expandedKey, notify]
  );

  const nodeOptions = useMemo(() => nodes.map((n) => n.name), [nodes]);

  return (
    <div className="min-h-screen bg-[#0A0D12] text-[#C4CBD8]">
      <div className="mx-auto max-w-[1180px] px-5 py-6">
        {/* Header / status strip */}
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#262E3D] bg-[#12161F] px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-[15px] font-semibold tracking-tight text-[#EAECEF]">Vault</span>
            <span className="font-mono text-[11px] text-[#7C8698]">cluster: main</span>
          </div>
          <div className="flex flex-wrap items-center gap-4 font-mono text-[12px]">
            <span>
              nodes <span className="text-[#EAECEF]">{health?.healthyNodes ?? "–"}/{health?.totalNodes ?? "–"}</span>
            </span>
            <span>
              objects <span className="text-[#EAECEF]">{health?.totalObjects ?? "–"}</span>
            </span>
            <span className={health?.corruptedReplicas ? "text-[#F0554C]" : ""}>
              corrupted <span>{health?.corruptedReplicas ?? "–"}</span>
            </span>
            <Pill tone={autopilot?.running ? "text-[#34D399] border-[#34D399]/35 bg-[#34D399]/10" : "text-[#7C8698] border-[#7C8698]/35 bg-[#7C8698]/10"}>
              autopilot {autopilot?.running ? "on" : "off"}
            </Pill>
            {autopilot?.running ? (
              <Button small tone="danger" busy={busyKey === "autopilot"} onClick={() => run("autopilot", () => api("/api/autopilot/stop", { method: "POST" }))}>
                Stop autopilot
              </Button>
            ) : (
              <Button small tone="primary" busy={busyKey === "autopilot"} onClick={() => run("autopilot", () => api("/api/autopilot/start", { method: "POST" }))}>
                Start autopilot
              </Button>
            )}
          </div>
        </header>

        {banner && (
          <div
            className={`mb-4 rounded-md border px-3 py-2 text-[12px] ${
              banner.tone === "error" ? "border-[#F0554C]/40 bg-[#F0554C]/10 text-[#F0554C]" : "border-[#34D399]/40 bg-[#34D399]/10 text-[#34D399]"
            }`}
          >
            {banner.text}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          {/* Left column */}
          <div className="flex flex-col gap-4">
            {/* Rack */}
            <Panel
              title="Rack"
              action={
                <div className="flex items-center gap-1.5">
                  <input
                    value={addNodeName}
                    onChange={(e) => setAddNodeName(e.target.value)}
                    placeholder="node-5"
                    className="w-24 rounded-md border border-[#2E3646] bg-[#0A0D12] px-2 py-1 font-mono text-[11px] text-[#C4CBD8] placeholder:text-[#4A5468] focus:border-[#5B8DEF]/60 focus:outline-none"
                  />
                  <Button
                    small
                    busy={busyKey === "add-node"}
                    disabled={!addNodeName.trim()}
                    onClick={() =>
                      run(
                        "add-node",
                        () => api("/api/nodes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: addNodeName.trim() }) }),
                        `Node ${addNodeName.trim()} joined`
                      ).then(() => setAddNodeName(""))
                    }
                  >
                    Add node
                  </Button>
                </div>
              }
            >
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                {nodes.map((n) => (
                  <div key={n.id} className="rounded-md border border-[#262E3D] bg-[#0E1219] p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[12px] text-[#EAECEF]">{n.name}</span>
                      <Pill tone={NODE_TONE[n.status]}>{n.status.toLowerCase()}</Pill>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-[10px] text-[#7C8698]">
                      <span>hb {formatAge(n.heartbeatAgeMs)} ago</span>
                      {n.isPartitioned && <span className="text-[#F5A623]">partitioned</span>}
                      {n.flakyDisk && <span className="text-[#F5A623]">flaky disk</span>}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {n.replicas.synced > 0 && <Pill tone={REPLICA_TONE.SYNCED}>{n.replicas.synced} synced</Pill>}
                      {n.replicas.corrupted > 0 && <Pill tone={REPLICA_TONE.CORRUPTED}>{n.replicas.corrupted} corrupted</Pill>}
                      {n.replicas.missing > 0 && <Pill tone={REPLICA_TONE.MISSING}>{n.replicas.missing} missing</Pill>}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {n.isCrashed ? (
                        <Button
                          small
                          tone="primary"
                          busy={busyKey === `revive-${n.id}`}
                          onClick={() =>
                            run(`revive-${n.id}`, () => api("/api/chaos/revive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId: n.id }) }), `${n.name} revived`)
                          }
                        >
                          Revive
                        </Button>
                      ) : (
                        <Button
                          small
                          tone="danger"
                          busy={busyKey === `kill-${n.id}`}
                          onClick={() =>
                            run(`kill-${n.id}`, () => api("/api/chaos/kill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId: n.id }) }), `${n.name} crashed`)
                          }
                        >
                          Kill
                        </Button>
                      )}
                      <Button
                        small
                        busy={busyKey === `partition-${n.id}`}
                        onClick={() =>
                          run(
                            `partition-${n.id}`,
                            () => api("/api/chaos/partition", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId: n.id, value: !n.isPartitioned }) }),
                            n.isPartitioned ? `Partition around ${n.name} healed` : `${n.name} partitioned`
                          )
                        }
                      >
                        {n.isPartitioned ? "Heal" : "Partition"}
                      </Button>
                      <Button
                        small
                        busy={busyKey === `flaky-${n.id}`}
                        onClick={() =>
                          run(
                            `flaky-${n.id}`,
                            () => api("/api/chaos/flaky", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId: n.id, value: !n.flakyDisk }) }),
                            `Flaky disk on ${n.name}: ${!n.flakyDisk ? "on" : "off"}`
                          )
                        }
                      >
                        {n.flakyDisk ? "Fix disk" : "Flaky disk"}
                      </Button>
                    </div>
                  </div>
                ))}
                {nodes.length === 0 && <p className="col-span-full text-[12px] text-[#7C8698]">No nodes yet — add one above, or run the seed script.</p>}
              </div>
            </Panel>

            {/* Objects */}
            <Panel
              title="Objects"
              action={
                <div className="flex items-center gap-1.5">
                  <input
                    value={uploadKey}
                    onChange={(e) => setUploadKey(e.target.value)}
                    placeholder="key (optional)"
                    className="w-28 rounded-md border border-[#2E3646] bg-[#0A0D12] px-2 py-1 font-mono text-[11px] placeholder:text-[#4A5468] focus:border-[#5B8DEF]/60 focus:outline-none"
                  />
                  <input
                    value={uploadRF}
                    onChange={(e) => setUploadRF(e.target.value)}
                    placeholder="RF"
                    className="w-12 rounded-md border border-[#2E3646] bg-[#0A0D12] px-2 py-1 font-mono text-[11px] placeholder:text-[#4A5468] focus:border-[#5B8DEF]/60 focus:outline-none"
                  />
                  <input
                    type="file"
                    onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                    className="max-w-[140px] text-[11px] text-[#7C8698] file:mr-2 file:rounded-md file:border file:border-[#2E3646] file:bg-[#1A202C] file:px-2 file:py-1 file:text-[11px] file:text-[#C4CBD8]"
                  />
                  <Button
                    small
                    tone="primary"
                    busy={busyKey === "upload"}
                    disabled={!uploadFile}
                    onClick={() =>
                      run(
                        "upload",
                        async () => {
                          if (!uploadFile) return;
                          const form = new FormData();
                          form.set("file", uploadFile);
                          if (uploadKey.trim()) form.set("key", uploadKey.trim());
                          if (uploadRF.trim()) form.set("replicationFactor", uploadRF.trim());
                          await api("/api/objects", { method: "POST", body: form });
                        },
                        `Uploaded ${uploadKey.trim() || uploadFile?.name}`
                      ).then(() => {
                        setUploadFile(null);
                        setUploadKey("");
                        setUploadRF("");
                      })
                    }
                  >
                    Upload
                  </Button>
                </div>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-[#262E3D] text-[11px] text-[#7C8698]">
                      <th className="py-1.5 pr-3 font-normal">Key</th>
                      <th className="py-1.5 pr-3 font-normal">Size</th>
                      <th className="py-1.5 pr-3 font-normal">RF / W / R</th>
                      <th className="py-1.5 pr-3 font-normal">Version</th>
                      <th className="py-1.5 pr-3 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {objects.map((o) => {
                      const isOpen = expandedKey === o.key;
                      const meta = objectMeta[o.key];
                      return (
                        <Fragment key={o.key}>
                          <tr className="border-b border-[#1B212C] font-mono">
                            <td className="py-1.5 pr-3 text-[#EAECEF]">{o.key}</td>
                            <td className="py-1.5 pr-3 text-[#7C8698]">{formatBytes(o.size)}</td>
                            <td className="py-1.5 pr-3 text-[#7C8698]">
                              {o.replicationFactor}/{o.writeQuorum}/{o.readQuorum}
                            </td>
                            <td className="py-1.5 pr-3 text-[#7C8698]">v{o.version}</td>
                            <td className="py-1.5 pr-3">
                              <div className="flex gap-1">
                                <Button small onClick={() => setExpandedKey(isOpen ? null : o.key)}>
                                  {isOpen ? "Hide" : "Chunks"}
                                </Button>
                                <a href={objectPath(o.key)} className="rounded-md border border-[#2E3646] px-2 py-1 text-[11px] text-[#C4CBD8] hover:bg-[#1A202C]">
                                  Download
                                </a>
                                <Button
                                  small
                                  onClick={() => {
                                    setCorruptObjectKey(o.key);
                                    setCorruptChunkIndex("0");
                                  }}
                                >
                                  Target for corrupt
                                </Button>
                              </div>
                            </td>
                          </tr>
                          {isOpen && meta && (
                            <tr className="border-b border-[#1B212C] bg-[#0E1219]">
                              <td colSpan={5} className="p-3">
                                <div className="flex flex-col gap-2">
                                  {meta.chunks.map((c) => (
                                    <div key={c.index} className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                                      <span className="text-[#7C8698]">chunk {c.index}</span>
                                      {c.replicas.map((r) => (
                                        <Pill key={r.node} tone={REPLICA_TONE[r.status]}>
                                          {r.node} {r.status.toLowerCase()}
                                        </Pill>
                                      ))}
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {objects.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-3 text-[12px] text-[#7C8698]">
                          Nothing stored yet — upload a file above.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            {/* Chaos */}
            <Panel title="Chaos — corrupt an existing replica">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-[#7C8698]">object key</span>
                  <input
                    value={corruptObjectKey}
                    onChange={(e) => setCorruptObjectKey(e.target.value)}
                    placeholder="hello.txt"
                    className="w-40 rounded-md border border-[#2E3646] bg-[#0A0D12] px-2 py-1 font-mono text-[11px] placeholder:text-[#4A5468] focus:border-[#5B8DEF]/60 focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-[#7C8698]">chunk</span>
                  <input
                    value={corruptChunkIndex}
                    onChange={(e) => setCorruptChunkIndex(e.target.value)}
                    className="w-16 rounded-md border border-[#2E3646] bg-[#0A0D12] px-2 py-1 font-mono text-[11px] focus:border-[#5B8DEF]/60 focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-[#7C8698]">node (optional)</span>
                  <select
                    value={corruptNodeId}
                    onChange={(e) => setCorruptNodeId(e.target.value)}
                    className="w-32 rounded-md border border-[#2E3646] bg-[#0A0D12] px-2 py-1 font-mono text-[11px] focus:border-[#5B8DEF]/60 focus:outline-none"
                  >
                    <option value="">auto</option>
                    {nodeOptions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  tone="danger"
                  busy={busyKey === "corrupt"}
                  disabled={!corruptObjectKey.trim()}
                  onClick={() =>
                    run("corrupt", () =>
                      api("/api/chaos/corrupt", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          objectKey: corruptObjectKey.trim(),
                          chunkIndex: Number.parseInt(corruptChunkIndex, 10) || 0,
                          ...(corruptNodeId ? { nodeId: corruptNodeId } : {}),
                        }),
                      })
                    )
                  }
                >
                  Corrupt replica
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-[#7C8698]">
                Damages stored bytes directly; the DB won&rsquo;t show it until a scrub or repair pass verifies the checksum. With autopilot
                running, watch the feed — it should be found and healed within one repair interval.
              </p>
            </Panel>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            {/* Autopilot detail */}
            <Panel title="Autopilot">
              {autopilot ? (
                <div className="flex flex-col gap-1.5 font-mono text-[11px] text-[#7C8698]">
                  <div>
                    status <span className={autopilot.running ? "text-[#34D399]" : "text-[#7C8698]"}>{autopilot.running ? "running" : "stopped"}</span>
                  </div>
                  <div>started {autopilot.startedAt ? formatClock(autopilot.startedAt) : "–"}</div>
                  <div className="mt-1 h-px bg-[#262E3D]" />
                  <div>
                    heartbeat every {autopilot.intervals.heartbeatIntervalMs / 1000}s · last {autopilot.lastCycle.heartbeat ? formatClock(autopilot.lastCycle.heartbeat) : "–"}
                  </div>
                  <div>
                    repair every {autopilot.intervals.repairIntervalMs / 1000}s · last {autopilot.lastCycle.repair ? formatClock(autopilot.lastCycle.repair) : "–"}
                  </div>
                  <div>
                    scrub every {autopilot.intervals.scrubIntervalMs / 1000}s · last {autopilot.lastCycle.scrub ? formatClock(autopilot.lastCycle.scrub) : "–"}
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-[#7C8698]">Loading…</p>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button small busy={busyKey === "run-repair"} onClick={() => run("run-repair", () => api("/api/repair/run", { method: "POST" }), "Repair cycle ran")}>
                  Run repair
                </Button>
                <Button small busy={busyKey === "run-scrub"} onClick={() => run("run-scrub", () => api("/api/repair/scrub", { method: "POST" }), "Scrub cycle ran")}>
                  Run scrub
                </Button>
                <Button small busy={busyKey === "run-rebalance"} onClick={() => run("run-rebalance", () => api("/api/repair/rebalance", { method: "POST" }), "Rebalance ran")}>
                  Run rebalance
                </Button>
                <Button small busy={busyKey === "run-heartbeat"} onClick={() => run("run-heartbeat", () => api("/api/maintenance/tick", { method: "POST" }), "Heartbeat cycle ran")}>
                  Run heartbeat
                </Button>
              </div>
            </Panel>

            {/* Live feed */}
            <Panel title="Live feed">
              <div ref={feedRef} className="max-h-[520px] min-h-[240px] overflow-y-auto pr-1">
                {events.length === 0 && <p className="text-[11px] text-[#7C8698]">Waiting for activity…</p>}
                {events.map((e) => (
                  <div key={e.seq} className="border-b border-[#1B212C] py-1.5 font-mono text-[11px] last:border-0">
                    <span className="text-[#4A5468]">{formatClock(e.ts)}</span>{" "}
                    <span
                      className={
                        e.level === "error"
                          ? "text-[#F0554C]"
                          : e.level === "warn"
                            ? "text-[#F5A623]"
                            : e.level === "success"
                              ? "text-[#34D399]"
                              : "text-[#7C8698]"
                      }
                    >
                      {e.message}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}