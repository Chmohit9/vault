# @vault/storage-node

An independently addressable storage-node HTTP service. Each instance owns its own disk and knows
nothing about replication, quorum, or any other node — it only stores/serves chunks by key.

This is a simulation of an independent storage node for a hackathon demo, run as its own Docker
container with its own volume. It is not claimed to be a physically separate machine.

## Config

| Env var | Required | Example |
|---|---|---|
| `NODE_ID` | yes | `node-1` |
| `NODE_PORT` | yes | `4100` |
| `STORAGE_PATH` | no (default `./data`) | `/data` |

## Run standalone (no Docker)