# memory/ — memory capability family

English | [中文](README.zh.md)

First-party, default-off memory capability: two Obsidian-compatible markdown vaults (one global, one per project) with a derived SQLite full-text/link index, automatic-scope resolution, and four model-facing tools. The family implements the shape the [extension cookbook](../../docs/cookbook/extension-cookbook.md) reserves for memory — a service seam plus model tools — and ships in no default composition.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) (`@deepseek-ai/dsh-memory`) | Service Definition: sole-provider registration, session scope resolution, and the write/read/search/traverse service surface | `ctx.memory` |
| `memory-local` (`@deepseek-ai/dsh-memory-local`) | File-first provider: markdown vaults under `$DSH_HOME/memory/` and `<project>/.dsh/memory/`, derived SQLite FTS/link index, chokidar reconciliation | registers on `ctx.memory` |
| `tool-memory` (`@deepseek-ai/dsh-tool-memory`) | Four model tools: `memory_write`, `memory_read`, `memory_search`, `memory_traverse` | registers on `ctx.tools` |

The subsystem reference — scopes, vault layout, note format, and the service contract — is [docs/subsystems/memory.md](../../docs/subsystems/memory.md); the design, phasing, and rejected alternatives live in the [first-party memory Agent Note](../../.agents/notes/proposed/feature/2026-08-18-first-party-pluggable-memory.md).
