# Memory

English | [中文](memory.zh.md)

Memory is the first-party, default-off cross-session memory capability: two Obsidian-compatible markdown vaults (one global, one per project) with a derived SQLite full-text/link index, and four model-facing tools. The subsystem is three packages under `packages/memory/` — the `dsh-memory` service, the `dsh-memory-local` file-first provider, and the `dsh-tool-memory` model tools. Design, phasing, and rejected alternatives: [first-party memory Agent Note](../../.agents/notes/proposed/feature/2026-08-18-first-party-pluggable-memory.md). Package config lives in each package README.

Source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)

## Scopes and vaults

A session's scope chain resolves from its cwd: a cwd matching a registered workspace yields `['project', 'global']`, anything else `['global']`. The global vault lives at `$DSH_HOME/memory/` (overridable through the service `dir` config); the project vault at `<cwd>/.dsh/memory/`. Both are plain Obsidian-openable folders — `MEMORY.md`, `notes/` topic notes, and an adoptable `journal/` — and one provider implementation serves both. Reads and searches walk the chain project-first; links stay within one vault. The index (`.memory-index.sqlite`) is derived state: a schema-version mismatch or deletion rebuilds it from the files, and a chokidar watcher plus read-time mtime re-checks keep it current against external edits.

## Notes

A provider-written note is markdown with frontmatter (`id`, `scope`, `title`, `created`, `updated`, `tags`, `related`) plus a body; body `[[wikilinks]]` and frontmatter `related` titles become typed link rows (`wikilink`/`related`) queried in both directions. Files without that frontmatter are adopted under a deterministic `adopted:<path>` identity — any existing markdown folder becomes searchable memory. `memory_write` replaces by `id` in place, preserving `created`; the filename derives from the title at creation and is stable.

## The service surface

`ctx.memory` is the sole-provider seam: `register()` accepts exactly one provider, `resolveScopes(cwd)` owns scope resolution, and `write`/`read`/`search`/`traverse` route to the provider with explicit vault directories. Failures use `MemoryError` with codes `DUPLICATE_PROVIDER`, `NO_PROVIDER`, `NO_PROJECT_SCOPE`, and `NOT_FOUND`. Phase 1 adds no `SessionEventMap` members: memory tool calls and results are already logged, and nothing else reaches the model.

## Consumers

`dsh-tool-memory` registers the four model tools and is the only model-visible surface in Phase 1. Phase 2 adds session-start injection, per-turn distillation with scope classification, and `memory/*` session events.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice"></a>

### `ctx.memory` — `MemoryService`

Sole-provider memory service (`ctx.memory`). Without a registered provider every operation fails loudly; scope resolution degrades deliberately to global-only when no workspace registry is composed.

```ts cordis-catalog
/**
 * Register the sole storage provider. Disposal closes the registration and
 * waits for every tracked in-flight operation before a later provider may
 * register.
 * @param provider - provider implementing the write/read/search/traverse contract.
 * @returns exact Cordis effect disposer, which settles after in-flight calls quiesce.
 */
register(provider: MemoryProvider): () => Promise<void>

/**
 * Resolve the scope chain for one session cwd: `['project', 'global']` when
 * the cwd matches a registered workspace, `['global']` otherwise. A missing
 * workspace registry, an unregistered path, or a registry lookup failure all
 * fall back to global-only — scope resolution must never block memory access.
 * @param cwd - session working directory, or `undefined` for global-only sessions.
 * @returns the ordered scope chain, project first.
 */
async resolveScopes(cwd: string | undefined): Promise<MemoryScope[]>

/**
 * Create or replace one note. `scope: 'project'` requires the caller's cwd
 * to resolve to a registered workspace.
 * @param input - note content; `id` present means replace that note.
 * @param cwd - caller session working directory.
 * @param signal - caller cancellation.
 * @returns the committed note reference.
 */
async write(input: MemoryWriteInput, cwd: string | undefined, signal?: AbortSignal): Promise<MemoryWriteResult>

/**
 * Read one note by id or exact title across the caller's scope chain.
 * @param ref - note id or exact title.
 * @param cwd - caller session working directory.
 * @param signal - caller cancellation.
 * @returns the resolved note with both link directions.
 */
async read(ref: string, cwd: string | undefined, signal?: AbortSignal): Promise<MemoryNote>

/**
 * Ranked full-text search across the caller's scope chain, project hits first.
 * @param query - FTS query terms.
 * @param opts - optional limit, bounded above by provider config.
 * @param cwd - caller session working directory.
 * @param signal - caller cancellation.
 * @returns ranked hits with snippets and tags.
 */
async search( query: string, opts: MemorySearchOptions | undefined, cwd: string | undefined, signal?: AbortSignal, ): Promise<MemorySearchHit[]>

/**
 * Bounded link adjacency around one note, resolved across the caller's scope
 * chain and traversed within the note's own vault.
 * @param ref - start note id or exact title.
 * @param opts - optional depth (1-2) and link-kind filter.
 * @param cwd - caller session working directory.
 * @param signal - caller cancellation.
 * @returns the start note and its adjacency nodes.
 */
async traverse( ref: string, opts: MemoryTraverseOptions | undefined, cwd: string | undefined, signal?: AbortSignal, ): Promise<MemoryTraversal>
```

Source: [`packages/memory/memory/src/index.ts:96`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
