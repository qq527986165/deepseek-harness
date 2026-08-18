# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

Memory capability seam: the sole-provider registry, session scope resolution, and the write/read/search/traverse service surface. The service owns the product rules — which vaults a session may reach — while the registered provider owns file layout and indexing inside each vault. Storage is file-first markdown, editable in Obsidian and diffable in git.

## Config

| Field | Meaning | Default |
|---|---|---|
| `dir` | Global vault directory | `memory/` under the harness home |
| `dshHome` | Harness home used when `dir` is omitted | `$DSH_HOME` or `~/.dsh` |

## Behavior

- **Sole provider.** `register(provider)` accepts exactly one provider; a second registration fails. Disposal closes the registration and waits for every tracked in-flight operation before a later provider may register.
- **Scope resolution.** `resolveScopes(cwd)` returns `['project', 'global']` when the cwd matches a registered workspace and `['global']` otherwise; a missing workspace registry, an unregistered path, or a registry fault all degrade to global-only.
- **Write routing.** `scope: 'project'` writes resolve the project vault at `<cwd>/.dsh/memory/` and fail with `NO_PROJECT_SCOPE` outside a registered workspace; `scope: 'global'` writes always target the configured directory.
- **Failure vocabulary.** Operations fail loudly with `MemoryError` codes `DUPLICATE_PROVIDER`, `NO_PROVIDER`, `NO_PROJECT_SCOPE`, and `NOT_FOUND`.
- **Pluggable by construction.** The service mounts only through an explicit `cordis.yml` row; consumers read it through `ctx.get('memory')`.

## Model Experience

Indirectly, through the `tool-memory` consumer: this service registers no tools and injects no prompt text; it only routes model tool calls to the provider.

#### KV Cache effect

No direct invalidation; the tool consumer owns any model-visible schema cost.

## Known Limitations and Deferred Work

- **One provider per host** — the sole-provider rule prevents composing two memory systems in one host; deployments needing several stores mount several plugin instances with different `dir` values instead.
- **Scope resolution is workspace-gated** — sessions outside a registered workspace get global memory only; automatic per-directory project vaults without workspace registration are deferred.
- **No session events yet** — Phase 2 adds `memory/*` session events so every distilled write and injected context is reconstructable from the log; Phase 1 relies on tool call/result logging alone.
