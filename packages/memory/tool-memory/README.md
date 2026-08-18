# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

Model-facing memory tools over the memory capability seam: `memory_write`, `memory_read`, `memory_search`, and `memory_traverse`. The caller's session cwd resolves the scope chain (project vault first, global second); the provider owns every storage detail. Memory tool calls and results are ordinary session-log events, so memory content is reconstructable from the log.

## Composition

One cordis.yml row per package, all default-off:

```yaml
- name: '@deepseek-ai/dsh-memory'
  config: { dir: !!js require('node:path').join(process.env.DSH_HOME ?? '~/.dsh', 'memory') }
- name: '@deepseek-ai/dsh-memory-local'
- name: '@deepseek-ai/dsh-tool-memory'
```

Mounting tools without the service keeps the entry waiting; tool calls then fail loudly with `NO_PROVIDER` when no provider is registered.

## Tools

| Tool | Purpose |
|---|---|
| `memory_write` | Create a topic note or replace one by id; explicit or defaulted `project`/`global` scope |
| `memory_read` | Read one note by id or exact title with both link directions |
| `memory_search` | Ranked full-text hits across the scope chain, project first |
| `memory_traverse` | One or two hops over `wikilink`/`related` links, both directions, with dangling marks |

## Model Experience

### Tool schemas

#### What the model sees

Four tool schemas with the descriptions above on every request while the plugin is mounted; the generated schemas live in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory). `memory_write` parameters: `id?`, `scope?`, `title`, `content`, `tags?`, `related?`. `memory_search` parameters: `query`, `limit?`.

#### Token effect

The four fixed schemas ride every request while visible; the package is opt-in and not mounted by default.

#### KV Cache effect

Prefix-stable while the plugin and schemas are unchanged.

### Tool results

#### What the model sees

Write results name the note, scope, and vault path. Read results render the note body plus `Related`/`Backlinks`/`Tags` lines. Search results render ranked `title (scope): snippet` lines, or an explicit empty message. Traverse results render per-edge lines with dangling marks and a truncation notice.

#### Token effect

One result block per call; sizes follow the note body, hit count, and node count, bounded by the provider's `maxSearchResults`/`maxTraverseNodes` caps.

#### KV Cache effect

Results are tool-call-local; no prefix impact beyond the logged turn.

## Known Limitations and Deferred Work

- **No `memory_delete` tool** — deletion is a Phase 3 lifecycle decision (review, TTL, link repair); users can still edit or remove vault files directly.
- **Explicit writes only** — the tools are the explicit recall surface; automatic recall injection, per-turn distillation, and the guidance section live in the separate `dsh-memory-lifecycle` consumer.
- **Exact-title lookups** — `memory_read`/`memory_traverse` resolve by id or exact title; fuzzy title matching is deferred to the Phase 4 retrieval provider.
