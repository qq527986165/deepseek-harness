# Memory

[English](memory.md) | 中文

Memory 是第一方、默认关闭的跨会话记忆能力：两个 Obsidian 兼容的 markdown vault（一个全局、一个每项目），配派生的 SQLite 全文/链接索引、四个面向模型的工具与一套自动生命周期——会话开始上下文注入，加每回合蒸馏进主题笔记与关联的日记。子系统由 `packages/memory/` 下的四个包组成——`dsh-memory` 服务、`dsh-memory-local` 文件优先提供方、`dsh-tool-memory` 模型工具与 `dsh-memory-lifecycle` 自动化消费者。设计、分期与被否决的替代方案见[第一方记忆 Agent Note](../../.agents/notes/proposed/feature/2026-08-18-first-party-pluggable-memory.md)；包配置见各包 README。

Source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)

## Scopes and vaults

会话的作用域链从其 cwd 解析：cwd 匹配已注册 workspace 时得到 `['project', 'global']`，其余情况得到 `['global']`。全局 vault 位于 `$DSH_HOME/memory/`（可经服务的 `dir` 配置覆盖）；项目 vault 位于 `<cwd>/.dsh/memory/`。两者都是可用 Obsidian 直接打开的普通文件夹——`MEMORY.md`、`notes/` 主题笔记与可收养的 `journal/`——一个提供方实现同时服务两者。读取与搜索沿链项目优先行走；链接限于单个 vault 内。索引（`.memory-index.sqlite`）是派生状态：schema 版本不匹配或删除会从文件重建，chokidar watcher 加读取时的 mtime 复查使索引相对外部编辑保持新鲜。

## Notes and journal

提供方写入的笔记是带 frontmatter（`id`、`scope`、`title`、`created`、`updated`、`tags`、`related`）加正文的 markdown；正文中的 `[[wikilinks]]` 与 frontmatter 的 `related` 标题成为带类型的链接行（`wikilink`/`related`），可双向查询。没有该 frontmatter 的文件以确定的 `adopted:<path>` 身份被收养——任何已存在的 markdown 文件夹都成为可搜索的记忆。`memory_write` 按 `id` 原地替换并保留 `created`；文件名在创建时由标题派生且稳定不变。`appendJournal` 在提供方的独占链上向当天的 `journal/YYYY-MM-DD.md` 追加一条 `## heading` 条目；文件不存在时以 `type: journal` frontmatter 创建。

## The service surface

`ctx.memory` 是唯一提供方 seam：`register()` 只接受一个提供方，`resolveScopes(cwd)` 拥有作用域解析，`write`/`read`/`search`/`traverse` 以显式 vault 目录路由到提供方；`readInScope`、`readPersona`、`recent` 与 `appendJournal` 服务生命周期消费者。失败使用 `MemoryError`，错误码为 `DUPLICATE_PROVIDER`、`NO_PROVIDER`、`NO_PROJECT_SCOPE` 与 `NOT_FOUND`。提供方在每次 watcher 驱动的 vault 对账后发出 `memory/change`；生命周期消费者为每次注入的上下文落 `memory/inject`、为每次蒸馏写入记录落 `memory/distill`，使面向模型的注入与每次静默变更都能从会话日志重建。

## Consumers

`dsh-tool-memory` 注册四个模型工具。`dsh-memory-lifecycle` 在 `agent/session-start` 时注入两份人设笔记外加字节封顶的项目主题笔记近期窗口，在已加载文件变更时重载，通过一次缓存复用的辅助调用蒸馏每个完成的回合（候选按 `project`/`global` 分类、合并而非重述），追加该回合的日记条目，并注册一段简短引导 section，告诉模型何时查阅、何时显式写入记忆。

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
