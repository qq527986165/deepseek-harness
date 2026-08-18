# Memory

English | [中文](memory.zh.md)

Memory is the first-party, default-off cross-session memory capability: two Obsidian-compatible markdown vaults (one global, one per project) with a derived SQLite full-text/link index, four model-facing tools, and an automatic lifecycle — session-start context injection plus every-turn distillation into topic notes and a linked journal. The subsystem is four packages under `packages/memory/` — the `dsh-memory` service, the `dsh-memory-local` file-first provider, the `dsh-tool-memory` model tools, and the `dsh-memory-lifecycle` automation consumer. Design, phasing, and rejected alternatives: [first-party memory Agent Note](../../.agents/notes/proposed/feature/2026-08-18-first-party-pluggable-memory.md). Package config lives in each package README.

Source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)

## Scopes and vaults

A session's scope chain resolves from its cwd: a cwd matching a registered workspace yields `['project', 'global']`, anything else `['global']`. The global vault lives at `$DSH_HOME/memory/` (overridable through the service `dir` config); the project vault at `<cwd>/.dsh/memory/`. Both are plain Obsidian-openable folders — `MEMORY.md`, `notes/` topic notes, and an adoptable `journal/` — and one provider implementation serves both. Reads and searches walk the chain project-first; links stay within one vault. The index (`.memory-index.sqlite`) is derived state: a schema-version mismatch or deletion rebuilds it from the files, and a chokidar watcher plus read-time mtime re-checks keep it current against external edits.

## Notes and journal

A provider-written note is markdown with frontmatter (`id`, `scope`, `title`, `created`, `updated`, `tags`, `related`) plus a body; body `[[wikilinks]]` and frontmatter `related` titles become typed link rows (`wikilink`/`related`) queried in both directions. Files without that frontmatter are adopted under a deterministic `adopted:<path>` identity — any existing markdown folder becomes searchable memory. `memory_write` replaces by `id` in place, preserving `created`; the filename derives from the title at creation and is stable. `appendJournal` adds one `## heading` entry to the day's `journal/YYYY-MM-DD.md` on the provider's exclusive chain, creating the file with a `type: journal` frontmatter when absent.

## The service surface

`ctx.memory` is the sole-provider seam: `register()` accepts exactly one provider, `resolveScopes(cwd)` owns scope resolution, and `write`/`read`/`search`/`traverse` route to the provider with explicit vault directories; `readInScope`, `readPersona`, `recent`, and `appendJournal` serve the lifecycle consumer. Failures use `MemoryError` with codes `DUPLICATE_PROVIDER`, `NO_PROVIDER`, `NO_PROJECT_SCOPE`, and `NOT_FOUND`. The provider emits `memory/change` after each watcher-driven vault reconciliation; the lifecycle consumer logs `memory/inject` for every injected context and `memory/distill` for every distillation write record, so model-visible injection and every silent mutation reconstruct from the session log.

## Consumers

`dsh-tool-memory` registers the four model tools. `dsh-memory-lifecycle` injects both persona notes plus a byte-capped recency window of project topic notes on `agent/session-start`, reloads them when a loaded file changes, distills each finished turn through one cache-reusing auxiliary call (classifying candidates `project`/`global` and merging instead of restating), appends the turn's journal entry, and registers a short guidance section telling the model when to consult and when to write memory explicitly.

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

/**
 * Read one note by id or exact title within one explicit scope, skipping the
 * chain. Used by consumers that must merge into or read from a specific
 * vault regardless of same-title notes elsewhere.
 * @param ref - note id or exact title.
 * @param scope - the single vault to resolve within.
 * @param cwd - caller session working directory.
 * @param signal - caller cancellation.
 * @returns the resolved note with both link directions.
 */
async readInScope( ref: string, scope: MemoryScope, cwd: string | undefined, signal?: AbortSignal, ): Promise<MemoryNote>

/**
 * Read one vault's persona note (`MEMORY.md`) whole. `scope: 'project'`
 * requires the caller's cwd to resolve to a registered workspace.
 * @param scope - which vault's persona note to read.
 * @param cwd - caller session working directory.
 * @param signal - caller cancellation.
 * @returns the persona note, or `undefined` when the vault has no `MEMORY.md`.
 */
async readPersona(scope: MemoryScope, cwd: string | undefined, signal?: AbortSignal): Promise<MemoryPersona | undefined>

/**
 * The project vault's most recently updated topic notes, newest first.
 * Requires the caller's cwd to resolve to a registered workspace; callers
 * that tolerate global-only sessions check `resolveScopes` first.
 * @param opts - optional window size, bounded by provider defaults.
 * @param cwd - caller session working directory.
 * @param signal - caller cancellation.
 * @returns the vault directory and its recency-window notes.
 */
async recent( opts: MemoryRecentOptions | undefined, cwd: string | undefined, signal?: AbortSignal, ): Promise<{ dir: string; notes: MemoryRecentNote[] }>

/**
 * Append one entry to a day's journal file. `scope: 'project'` requires the
 * caller's cwd to resolve to a registered workspace. The provider serializes
 * appends on the vault's exclusive chain, so concurrent sessions never
 * interleave inside one file.
 * @param input - journal scope, optional day, heading, and markdown body.
 * @param cwd - caller session working directory.
 * @param signal - caller cancellation.
 * @returns the committed journal file reference.
 */
async appendJournal( input: MemoryJournalAppendInput, cwd: string | undefined, signal?: AbortSignal, ): Promise<MemoryJournalAppendResult>
```

Source: [`packages/memory/memory/src/index.ts:118`](../../packages/memory/memory/src/index.ts)

<a id="memory-events"></a>

### `memory/*` events

<a id="memorychange--emit"></a>

#### `memory/change` — emit

The registered provider finished a watcher-driven reconciliation of one vault directory. Consumers tracking injected context compare the changed files against what they loaded.

```ts cordis-catalog
/**
 * The registered provider finished a watcher-driven reconciliation of one
 * vault directory. Consumers tracking injected context compare the changed
 * files against what they loaded.
 * @param payload.dir - absolute vault directory that changed.
 * @param payload.paths - changed markdown file paths relative to the vault root.
 * @mode emit
 */
'memory/change'(payload: { dir: string; paths: string[] }): void
```

Source: [`packages/memory/memory/src/index.ts:68`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
