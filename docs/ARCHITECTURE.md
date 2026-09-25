# Architecture diagrams

These are [Mermaid](https://mermaid.js.org) diagrams — they render natively on GitHub, GitLab, and
most editor Markdown previews (VS Code needs no extra setup for GitHub-flavored preview; other tools
can paste the block into https://mermaid.live).

## 1. Components

```mermaid
flowchart TB
    subgraph Client["Browser"]
        Dash["Dashboard (page.tsx)\nnode health · objects · autopilot · chaos · live feed"]
    end

    subgraph Server["Next.js server process"]
        API["API routes\n/api/objects, /api/nodes, /api/chaos/*,\n/api/autopilot/*, /api/repair/*, /api/events"]

        subgraph Metadata["Metadata layer"]
            WC["writeCoordinator\nchunk -> replicate -> enforce W -> commit"]
            RC["readCoordinator\nread -> verify checksum -> resolve R"]
        end

        subgraph Repl["Replication"]
            PL["placement\nchoose target nodes, least loaded first"]
            QU["quorum\nhasWriteQuorum / resolveReadQuorum"]
        end

        subgraph Auto["Autopilot loop (single ticking timer)"]
            HB["heartbeat + failure detection\nevery tick"]
            SC["scrub (bounded batch)"]
            RE["repair"]
            RB["rebalance"]
            HB --> SC --> RE --> RB
        end

        Bus["Event bus (in-process pub/sub)"]
        SSE["/api/events (SSE)"]
    end

    subgraph DB["Postgres (Supabase pooler, connection_limit=1)"]
        Meta["Node / StoredObject / Chunk / Replica\nRepairLog / ChaosEvent"]
    end

    subgraph Storage["Storage backend (one interface)"]
        Local["LocalBackend\n.vault-data/<cluster>/<node>/..."]
        Blob["BlobBackend\nVercel Blob"]
    end

    Dash <-->|fetch, sequential| API
    Dash <-->|EventSource| SSE
    API --> WC & RC
    WC --> PL --> QU
    RC --> QU
    WC & RC -->|SimulatedNode.put/get| Storage
    WC & RC --> Meta
    Auto --> Meta
    Auto -->|SimulatedNode.put/get| Storage
    WC & RC & Auto -->|emit| Bus --> SSE
```

## 2. Data model

```mermaid
erDiagram
    Node ||--o{ Replica : hosts
    StoredObject ||--o{ Chunk : "split into"
    Chunk ||--o{ Replica : "copies on N nodes"

    Node {
        string id PK
        string cluster
        string name
        enum status "HEALTHY | DEGRADED | OFFLINE"
        bool isCrashed
        bool isPartitioned
        bool isCorrupting "flaky disk"
        datetime lastHeartbeat
    }
    StoredObject {
        string id PK
        string cluster
        string key
        int version
        string checksum "whole-object SHA-256"
        int replicationFactor "N"
        int writeQuorum "W"
        int readQuorum "R"
    }
    Chunk {
        string id PK
        string objectId FK
        int index
        string checksum "per-chunk SHA-256"
    }
    Replica {
        string id PK
        string chunkId FK
        string nodeId FK
        string storageKey
        enum status "SYNCED | STALE | CORRUPTED | MISSING | REPAIRING"
        datetime lastVerifiedAt
    }
```

## 3. Corruption → repair sequence (the demo pipeline)

```mermaid
sequenceDiagram
    participant U as User (dashboard)
    participant Chaos as /api/chaos/corrupt
    participant Storage as Storage backend
    participant Auto as Autopilot tick
    participant Scrub as scrubCluster
    participant Repair as repairCluster
    participant DB as Postgres

    U->>Chaos: corrupt(objectKey, chunkIndex, node)
    Chaos->>Storage: damage stored bytes (metadata untouched)
    Note over DB: replica.status still SYNCED — nothing looks wrong yet

    loop every tick (heartbeat cadence)
        Auto->>DB: heartbeat + failure detection
    end

    Auto->>Scrub: on the Nth tick (repair cadence)
    Scrub->>Storage: read bytes for a batch of replicas
    Scrub->>Scrub: computeChecksum(bytes) vs chunk.checksum
    Scrub->>DB: mismatch -> replica.status = CORRUPTED
    Scrub-->>U: event: "Scrub found corruption: key#idx@node"

    Auto->>Repair: same tick, right after scrub
    Repair->>DB: find CORRUPTED/MISSING replicas
    Repair->>Storage: read bytes from a healthy SYNCED source
    Repair->>Storage: write bytes to the broken replica
    Repair->>Storage: read back and re-checksum (verify the write)
    Repair->>DB: replica.status = SYNCED, lastVerifiedAt = now
    Repair-->>U: event: "Repaired key#idx@node from <source>"

    U->>U: download object -> bytes match original
```

## 4. Autopilot tick, internally

Why this is one timer instead of three (heartbeat / repair / scrub each on their own `setInterval`) is
explained in [DESIGN.md](DESIGN.md#autopilot-loop); the short version is in the diagram below.

```mermaid
flowchart LR
    T["setInterval tick\nevery HEARTBEAT_INTERVAL_MS"] --> G{"tick already\nin flight?"}
    G -- yes --> Skip["skip this tick\n(no overlap, ever)"]
    G -- no --> HB["heartbeat +\nfailure detection"]
    HB --> R{"REPAIR_INTERVAL_MS\nelapsed since last\nrepair chain?"}
    R -- no --> Done["release lock"]
    R -- yes --> SC["scrub(batch)"] --> RE["repair()"] --> RB["rebalance()"] --> Done
```
