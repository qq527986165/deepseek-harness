/**
 * File-first memory provider: Obsidian-compatible markdown vaults with a
 * derived SQLite index and chokidar reconciliation. One vault handle per
 * directory; every write and reconcile runs on that vault's single exclusive
 * operation chain.
 * @module @deepseek-ai/dsh-memory-local
 */

import { Context } from '@deepseek-ai/cordis'
import { watch as chokidarWatch } from 'chokidar'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { MemoryError, MemoryNoteId } from '@deepseek-ai/dsh-memory'
import type {
  MemoryLinkTarget,
  MemoryNote,
  MemoryProvider,
  MemorySearchHit,
  MemorySearchOptions,
  MemoryTraversal,
  MemoryTraversalNode,
  MemoryTraverseOptions,
  MemoryWriteInput,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory'
import { newNotePath, parseNote, stringifyNote } from './format.ts'
import {
  MEMORY_INDEX_FILE,
  findIndexedNote,
  findIndexedNoteById,
  findNoteIdByTitle,
  inLinks,
  listIndexedPaths,
  openIndexFile,
  outLinks,
  removeIndexedNote,
  searchIndex,
  upsertIndexedNote,
} from './schema.ts'
import { VaultWatcher } from './watcher.ts'
import type { WatchImpl } from './watcher.ts'

/** Cordis plugin name, matching the npm package. */
export const name = '@deepseek-ai/dsh-memory-local'
/** The memory service this provider registers into. */
export const inject = ['memory']

/** Plugin configuration. */
export interface Config {
  /** Watch each vault and reconcile external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
  /** Search result cap; defaults to 20. */
  maxSearchResults?: number
  /** Traversal node cap; defaults to 50. */
  maxTraverseNodes?: number
}

/** Loader-visible config schema; `apply` re-validates for programmatic mounts. */
export const Config: z<Config> = z.object({
  watch: z.boolean().default(true),
  debounceMs: z.number().min(0).default(100),
  maxSearchResults: z.number().step(1).min(1).default(20),
  maxTraverseNodes: z.number().step(1).min(1).default(50),
})

/** Fully resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedConfig {
  readonly watch: boolean
  readonly debounceMs: number
  readonly maxSearchResults: number
  readonly maxTraverseNodes: number
}

/**
 * Resolve and validate plugin config: numeric caps must be positive integers.
 * @param config - raw plugin config.
 * @returns validated runtime parameters.
 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const candidate: Config = config ?? {}
  for (const key of ['debounceMs', 'maxSearchResults', 'maxTraverseNodes'] as const) {
    const value = candidate[key]
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`memory-local: ${key} must be a positive integer`)
    }
  }
  return {
    watch: candidate.watch ?? true,
    debounceMs: candidate.debounceMs ?? 100,
    maxSearchResults: candidate.maxSearchResults ?? 20,
    maxTraverseNodes: candidate.maxTraverseNodes ?? 50,
  }
}

/** Extract exact `[[wikilink]]` targets from markdown body text, deduplicated. */
export function extractWikiLinks(body: string): string[] {
  const links = new Set<string>()
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) {
    const title = match[1]?.trim() ?? ''
    if (title !== '') links.add(title)
  }
  return [...links]
}

/** One open vault: directory, index database, watcher, and its exclusive chain. */
class Vault {
  private db: DatabaseSync | undefined
  private watcher: VaultWatcher | undefined
  private operations: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    readonly dir: string,
    private readonly config: ResolvedConfig,
    private readonly watchImpl: WatchImpl,
    private readonly warn: (error: unknown) => void,
  ) {}

  /** Open the directory, index, and watcher, then run the initial full reconcile. */
  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    this.db = await openIndexFile(this.dir)
    await this.reconcile()
    if (this.config.watch) {
      this.watcher = new VaultWatcher(this.dir, this.config.debounceMs, paths => this.reconcile(paths), this.watchImpl, this.warn)
      this.watcher.start()
    }
  }

  /** The open index; every public path opens the vault first. */
  get database(): DatabaseSync {
    /* v8 ignore next -- only reachable through paths that opened the vault. */
    if (this.db === undefined) throw new Error('memory vault is not open')
    return this.db
  }

  /** Run one operation on the vault's single exclusive chain; caller errors propagate. */
  run<T>(work: () => Promise<T>): Promise<T> {
    /* v8 ignore next -- teardown race guard: no public path reaches a closed vault. */
    if (this.closed) return Promise.reject(new MemoryError('memory vault is closed', 'NOT_FOUND'))
    const run = this.operations.then(work)
    this.operations = run.then(() => undefined, () => undefined)
    return run
  }

  /** Full or incremental index reconciliation from vault files. */
  async reconcile(paths?: string[]): Promise<void> {
    await this.run(async () => {
      const db = this.database
      const full = paths === undefined || paths.length === 0
      const touched = new Set(full ? [] : paths)
      if (full) {
        for (const file of await this.walkMarkdown()) {
          touched.add(file)
        }
      }
      for (const path of touched) {
        if (await this.indexFile(path)) continue
        this.removeByPath(path)
      }
      if (full) {
        const indexed = new Set(listIndexedPaths(db))
        for (const path of touched) indexed.delete(path)
        for (const stale of indexed) {
          const row = db.prepare('SELECT id FROM notes WHERE path = ?').get(stale) as { id: string } | undefined
          /* v8 ignore next -- index rows are path-unique, so the lookup always resolves. */
          if (row === undefined) return
          removeIndexedNote(db, row.id)
        }
      }
    })
  }

  /** Index one markdown file; `false` means the file is gone and rows must drop. */
  private async indexFile(path: string): Promise<boolean> {
    const db = this.database
    const absolute = join(this.dir, path)
    let info
    try {
      info = await stat(absolute)
    } catch (error: unknown) {
      /* v8 ignore next -- ENOENT handles deletion; other stat faults surface as caller errors. */
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      /* v8 ignore next -- the non-ENOENT branch above is platform-specific. */
      throw error
    }
    const text = await readFile(absolute, 'utf8')
    const parsed = parseNote(text)
    if (parsed === undefined) {
      const title = basename(path, '.md')
      upsertIndexedNote(
        db,
        { id: `adopted:${path}`, path, title, created: info.mtimeMs, updated: info.mtimeMs, tags: [] },
        text,
        extractWikiLinks(text),
        [],
      )
      return true
    }
    const created = Number.isFinite(Date.parse(parsed.frontmatter.created)) ? Date.parse(parsed.frontmatter.created) : info.mtimeMs
    upsertIndexedNote(
      db,
      { id: parsed.frontmatter.id, path, title: parsed.frontmatter.title, created, updated: info.mtimeMs, tags: parsed.frontmatter.tags },
      parsed.body,
      extractWikiLinks(parsed.body),
      parsed.frontmatter.related,
    )
    return true
  }

  /** Drop index rows for one missing file. */
  private removeByPath(path: string): void {
    const db = this.database
    const row = db.prepare('SELECT id FROM notes WHERE path = ?').get(path) as { id: string } | undefined
    if (row !== undefined) removeIndexedNote(db, row.id)
  }

  /** Re-index one note when its file changed after the last index write. */
  async refreshIfStale(ref: string): Promise<void> {
    const db = this.database
    const row = findIndexedNote(db, ref)
    if (row === undefined) return
    let info
    try {
      info = await stat(join(this.dir, row.path))
    } catch (error: unknown) {
      /* v8 ignore next -- ENOENT handles deletion; other stat faults surface as caller errors. */
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.removeByPath(row.path)
        return
      }
      /* v8 ignore next -- the non-ENOENT branch above is platform-specific. */
      throw error
    }
    if (info.mtimeMs <= row.updated) return
    await this.indexFile(row.path)
  }

  /** Every `.md` path under the vault, skipping `.obsidian/` and the index file. */
  private async walkMarkdown(): Promise<string[]> {
    const results: string[] = []
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(join(this.dir, dir), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.obsidian') continue
        const rel = dir === '' ? entry.name : `${dir}${sep}${entry.name}`
        if (entry.isDirectory()) {
          await walk(rel)
        } else if (entry.isFile() && rel !== MEMORY_INDEX_FILE && entry.name.endsWith('.md')) {
          results.push(rel)
        }
      }
    }
    await walk('')
    return results
  }

  /** Close the watcher, drain the operation chain, and close the database. */
  async dispose(): Promise<void> {
    /* v8 ignore next -- each provider vault is disposed exactly once. */
    if (this.closed) return
    this.closed = true
    await this.watcher?.dispose()
    await this.operations
    this.db?.close()
    this.db = undefined
  }
}

/** Which scope one directory maps to: the chain head is the project vault. */
function scopeOf(dir: string, dirs: readonly string[]): 'project' | 'global' {
  return dirs.length > 1 && dir === dirs[0] ? 'project' : 'global'
}

/** The default silent warn sink for tests and compositions without logging. */
export function silentWarn(): void {}

/**
 * File-first memory provider: one vault handle per directory, the four
 * service operations over markdown files plus their derived SQLite index.
 */
export class LocalMemoryProvider implements MemoryProvider {
  private readonly vaults = new Map<string, Vault>()
  private readonly watchImpl: WatchImpl

  constructor(
    private readonly config: ResolvedConfig,
    watchImpl?: WatchImpl,
    private readonly warn: (error: unknown) => void = silentWarn,
  ) {
    this.watchImpl = watchImpl ?? chokidarWatch
  }

  /** Open (once) and return the vault handle for one directory. */
  private async vault(dir: string): Promise<Vault> {
    let vault = this.vaults.get(dir)
    if (vault === undefined) {
      vault = new Vault(dir, this.config, this.watchImpl, this.warn)
      this.vaults.set(dir, vault)
      await vault.open()
    }
    return vault
  }

  async write(input: MemoryWriteInput, dir: string, signal?: AbortSignal): Promise<MemoryWriteResult> {
    signal?.throwIfAborted()
    const vault = await this.vault(dir)
    return vault.run(async () => {
      signal?.throwIfAborted()
      const db = vault.database
      const now = Date.now()
      const existing = input.id === undefined ? undefined : findIndexedNoteById(db, input.id)
      const taken = new Set(listIndexedPaths(db))
      if (existing !== undefined) taken.delete(existing.path)
      const id = existing?.id ?? MemoryNoteId(randomUUID())
      const path = existing?.path ?? newNotePath(input.title, taken)
      const created = existing?.created ?? now
      const frontmatter = {
        id,
        scope: input.scope,
        title: input.title,
        created: new Date(created).toISOString(),
        updated: new Date(now).toISOString(),
        tags: input.tags ?? [],
        related: input.related ?? [],
      }
      const text = stringifyNote(frontmatter, input.content)
      await mkdir(join(dir, dirname(path)), { recursive: true })
      await writeFile(join(dir, path), text, 'utf8')
      const after = await stat(join(dir, path))
      upsertIndexedNote(
        db,
        { id, path, title: input.title, created, updated: after.mtimeMs, tags: frontmatter.tags },
        input.content,
        extractWikiLinks(input.content),
        frontmatter.related,
      )
      return {
        id: MemoryNoteId(id),
        scope: input.scope,
        title: input.title,
        path,
        created: frontmatter.created,
        updated: frontmatter.updated,
      }
    })
  }

  async read(ref: string, dirs: readonly string[], signal?: AbortSignal): Promise<MemoryNote> {
    for (const dir of dirs) {
      signal?.throwIfAborted()
      const vault = await this.vault(dir)
      const note = await vault.run(async () => {
        await vault.refreshIfStale(ref)
        const row = findIndexedNote(vault.database, ref)
        return row === undefined ? undefined : await this.materialize(dir, scopeOf(dir, dirs), vault, row)
      })
      if (note !== undefined) return note
    }
    throw new MemoryError(`no memory note matches "${ref}"`, 'NOT_FOUND')
  }

  async search(
    query: string,
    opts: MemorySearchOptions | undefined,
    dirs: readonly string[],
    signal?: AbortSignal,
  ): Promise<MemorySearchHit[]> {
    const hits: MemorySearchHit[] = []
    if (query.trim() === '') return hits
    if (opts?.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
      throw new Error(`memory-local: limit must be a positive integer, got ${opts.limit}`)
    }
    const cap = Math.min(opts?.limit ?? this.config.maxSearchResults, this.config.maxSearchResults)
    for (const dir of dirs) {
      if (hits.length >= cap) break
      signal?.throwIfAborted()
      const vault = await this.vault(dir)
      const part = await vault.run(() => Promise.resolve(searchIndex(vault.database, query, cap - hits.length)))
      for (const hit of part) {
        hits.push({ id: MemoryNoteId(hit.id), scope: scopeOf(dir, dirs), title: hit.title, snippet: hit.snippet, tags: hit.tags })
      }
    }
    return hits
  }

  async traverse(
    ref: string,
    opts: MemoryTraverseOptions | undefined,
    dirs: readonly string[],
    signal?: AbortSignal,
  ): Promise<MemoryTraversal> {
    const depth: number = opts?.depth ?? 1
    if (depth !== 1 && depth !== 2) throw new Error(`memory-local: depth must be 1 or 2, got ${depth}`)
    const kinds = new Set(opts?.kinds ?? ['wikilink', 'related'])
    for (const kind of kinds) {
      if (kind !== 'wikilink' && kind !== 'related') throw new Error(`memory-local: unknown link kind "${kind}"`)
    }
    let startRow
    let startVault: Vault | undefined
    for (const dir of dirs) {
      signal?.throwIfAborted()
      const vault = await this.vault(dir)
      const found = await vault.run(async () => {
        await vault.refreshIfStale(ref)
        return findIndexedNote(vault.database, ref)
      })
      if (found !== undefined) {
        startRow = found
        startVault = vault
        break
      }
    }
    if (startRow === undefined || startVault === undefined) {
      throw new MemoryError(`no memory note matches "${ref}"`, 'NOT_FOUND')
    }
    const row = startRow
    const vault = startVault
    return vault.run(() => Promise.resolve(this.walkLinks(vault, row, depth, kinds, this.config.maxTraverseNodes)))
  }

  /** BFS over both link directions within one vault, capped by node count. */
  private walkLinks(vault: Vault, start: { id: string; title: string }, depth: number, kinds: Set<string>, cap: number): MemoryTraversal {
    const db = vault.database
    const nodes: MemoryTraversalNode[] = []
    const seen = new Set<string>()
    let truncated = false
    let frontier: Array<{ id: string; title: string }> = [{ id: start.id, title: start.title }]
    outer: for (let level = 0; level < depth; level += 1) {
      const next: Array<{ id: string; title: string }> = []
      for (const node of frontier) {
        for (const { kind, toTitle } of outLinks(db, node.id)) {
          if (!kinds.has(kind)) continue
          const key = `out:${kind}:${toTitle}`
          if (seen.has(key)) continue
          seen.add(key)
          const targetId = findNoteIdByTitle(db, toTitle)
          nodes.push({ ...(targetId !== undefined ? { id: MemoryNoteId(targetId) } : {}), title: toTitle, via: { kind: kind as 'wikilink' | 'related', direction: 'out' } })
          if (targetId !== undefined) next.push({ id: targetId, title: toTitle })
          if (nodes.length >= cap) { truncated = true; break outer }
        }
        for (const { kind, fromId } of inLinks(db, node.title)) {
          if (!kinds.has(kind)) continue
          const key = `in:${kind}:${fromId}`
          if (seen.has(key)) continue
          seen.add(key)
          const from = findIndexedNoteById(db, fromId)
          /* v8 ignore next -- link rows are only written for indexed notes. */
          if (from === undefined) throw new Error(`index inconsistency: link source ${fromId} has no note`)
          nodes.push({ id: MemoryNoteId(fromId), title: from.title, via: { kind: kind as 'wikilink' | 'related', direction: 'in' } })
          next.push({ id: fromId, title: from.title })
          if (nodes.length >= cap) { truncated = true; break outer }
        }
      }
      frontier = next
      if (frontier.length === 0) break
    }
    return { start: { id: MemoryNoteId(start.id), title: start.title }, nodes, truncated }
  }

  /** Read one indexed note back into the full `MemoryNote` form. */
  private async materialize(dir: string, scope: 'project' | 'global', vault: Vault, row: { id: string; path: string; title: string; tags: readonly string[] }): Promise<MemoryNote> {
    const db = vault.database
    const text = await readFile(join(dir, row.path), 'utf8')
    const parsed = parseNote(text)
    const body = parsed?.body ?? text
    const related: MemoryLinkTarget[] = []
    for (const title of parsed?.frontmatter.related ?? []) {
      const targetId = findNoteIdByTitle(db, title)
      related.push({ ...(targetId !== undefined ? { id: MemoryNoteId(targetId) } : {}), title })
    }
    const backlinks: MemoryLinkTarget[] = inLinks(db, row.title).map(({ fromId }) => {
      const from = findIndexedNoteById(db, fromId)
      /* v8 ignore next -- link rows are only written for indexed notes. */
      if (from === undefined) throw new Error(`index inconsistency: link source ${fromId} has no note`)
      return { id: MemoryNoteId(fromId), title: from.title }
    })
    return { id: MemoryNoteId(row.id), scope, title: row.title, path: row.path, tags: row.tags, body, related, backlinks }
  }

  /** Close every vault: watchers first, then drained chains, then databases. */
  async dispose(): Promise<void> {
    const vaults = [...this.vaults.values()]
    this.vaults.clear()
    await Promise.all(vaults.map(vault => vault.dispose()))
  }
}

/** Mount the provider into the memory service; unloading closes vaults, data survives. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  /* v8 ignore next -- the plugin-level warn body fires only on real watcher faults. */
  const provider = new LocalMemoryProvider(resolved, undefined, (error) =>{  ctx.logger.warn('memory-local: %s', String(error)) })
  ctx.memory.register(provider)
  ctx.effect(() => () => provider.dispose(), 'memory-local lifecycle')
}

/** Provider-owned id factory re-export for tests and diagnostics. */
export { MemoryNoteId }
