# Memory

[English](memory.md) | 中文

Memory 是第一方、默认关闭的跨会话记忆能力：两个 Obsidian 兼容的 markdown vault（一个全局、一个每项目），配派生的 SQLite 全文/链接索引与四个面向模型的工具。子系统由 `packages/memory/` 下的三个包组成——`dsh-memory` 服务、`dsh-memory-local` 文件优先提供方与 `dsh-tool-memory` 模型工具。设计、分期与被否决的替代方案见[第一方记忆 Agent Note](../../.agents/notes/proposed/feature/2026-08-18-first-party-pluggable-memory.md)；包配置见各包 README。

Source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)

## Scopes and vaults

会话的作用域链从其 cwd 解析：cwd 匹配已注册 workspace 时得到 `['project', 'global']`，其余情况得到 `['global']`。全局 vault 位于 `$DSH_HOME/memory/`（可经服务的 `dir` 配置覆盖）；项目 vault 位于 `<cwd>/.dsh/memory/`。两者都是可用 Obsidian 直接打开的普通文件夹——`MEMORY.md`、`notes/` 主题笔记与可收养的 `journal/`——一个提供方实现同时服务两者。读取与搜索沿链项目优先行走；链接限于单个 vault 内。索引（`.memory-index.sqlite`）是派生状态：schema 版本不匹配或删除会从文件重建，chokidar watcher 加读取时的 mtime 复查使索引相对外部编辑保持新鲜。

## Notes

提供方写入的笔记是带 frontmatter（`id`、`scope`、`title`、`created`、`updated`、`tags`、`related`）加正文的 markdown；正文中的 `[[wikilinks]]` 与 frontmatter 的 `related` 标题成为带类型的链接行（`wikilink`/`related`），可双向查询。没有该 frontmatter 的文件以确定的 `adopted:<path>` 身份被收养——任何已存在的 markdown 文件夹都成为可搜索的记忆。`memory_write` 按 `id` 原地替换并保留 `created`；文件名在创建时由标题派生且稳定不变。

## The service surface

`ctx.memory` 是唯一提供方 seam：`register()` 只接受一个提供方，`resolveScopes(cwd)` 拥有作用域解析，`write`/`read`/`search`/`traverse` 以显式 vault 目录路由到提供方。失败使用 `MemoryError`，错误码为 `DUPLICATE_PROVIDER`、`NO_PROVIDER`、`NO_PROJECT_SCOPE` 与 `NOT_FOUND`。Phase 1 不新增任何 `SessionEventMap` 成员：记忆工具调用与结果本就落日志，也没有其他内容到达模型。

## Consumers

`dsh-tool-memory` 注册四个模型工具，是 Phase 1 唯一面向模型的接口。Phase 2 增加会话开始注入、带作用域分类的每回合蒸馏与 `memory/*` 会话事件。

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
