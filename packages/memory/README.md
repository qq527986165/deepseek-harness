# memory/ — memory capability family

English | [中文](README.zh.md)

First-party, default-off memory capability: two Obsidian-compatible markdown vaults (one global, one per project) with a derived SQLite full-text/link index, automatic-scope resolution, four model-facing tools, and an automatic lifecycle that injects context at session start and distills every finished turn into topic notes and a linked journal. The family implements the shape the [extension cookbook](../../docs/cookbook/extension-cookbook.md) reserves for memory — a service seam plus model tools — and ships in no default composition.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) (`@deepseek-ai/dsh-memory`) | Service Definition: sole-provider registration, session scope resolution, and the write/read/search/traverse service surface plus the lifecycle primitives | `ctx.memory` |
| `memory-local` (`@deepseek-ai/dsh-memory-local`) | File-first provider: markdown vaults under `$DSH_HOME/memory/` and `<project>/.dsh/memory/`, derived SQLite FTS/link index, chokidar reconciliation, journal appends | registers on `ctx.memory` |
| `tool-memory` (`@deepseek-ai/dsh-tool-memory`) | Four model tools: `memory_write`, `memory_read`, `memory_search`, `memory_traverse` | registers on `ctx.tools` |
| `memory-lifecycle` (`@deepseek-ai/dsh-memory-lifecycle`) | Automatic lifecycle: session-start injection, watcher reloads, per-turn distillation with scope classification, journal appends, `memory/*` session events, guidance section | consumes `ctx.memory`/`ctx.llm`/`ctx.systemPrompt` |

The subsystem reference — scopes, vault layout, note format, and the service contract — is [docs/subsystems/memory.md](../../docs/subsystems/memory.md); the design, phasing, and rejected alternatives live in the [first-party memory Agent Note](../../.agents/notes/proposed/feature/2026-08-18-first-party-pluggable-memory.md).
