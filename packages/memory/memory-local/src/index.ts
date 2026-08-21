/**
 * File-first memory provider: Obsidian-compatible markdown vaults with a
 * derived SQLite index and chokidar reconciliation. One vault handle per
 * directory; every write and reconcile runs on that vault's single exclusive
 * operation chain.
 * @module @deepseek-ai/dsh-memory-local
 */

import { Context } from '@deepseek-ai/cordis'
import { watch as chokidarWatch } from 'chokidar'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { MemoryError, MemoryNoteId } from '@deepseek-ai/dsh-memory'
import type {
  MemoryDeleteOptions,
  MemoryDistillCommitGroupInput,
  MemoryDistillCommitResult,
  MemoryJournalAppendInput,
  MemoryLinkTarget,
  MemoryListedNote,
  MemoryListOptions,
  MemoryNote,
  MemoryProvider,
  MemoryRecentNote,
  MemoryRecentOptions,
  MemorySearchHit,
  MemorySearchOptions,
  MemoryTraversal,
  MemoryTraversalNode,
  MemoryTraverseOptions,
  MemoryWriteInput,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory'
import { JOURNAL_DIR, NOTES_DIR, newDistillNotePath, newNotePath, parseNote, stringifyJournalFrontmatter, stringifyNote, validateJournalDate } from './format.ts'
import {
  MEMORY_INDEX_FILE,
  findIndexedNote,
  findIndexedNoteById,
  findLatestIndexedNoteByTitle,
  findNoteIdByLinkTarget,
  inLinksToNote,
  listIndexedPaths,
  openIndexFile,
  outLinks,
  parseTags,
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
  /** Listing row cap; defaults to 200. */
  maxListNotes?: number
}

/** Loader-visible config schema; `apply` re-validates for programmatic mounts. */
export const Config: z<Config> = z.object({
  watch: z.boolean().default(true),
  debounceMs: z.number().min(0).default(100),
  maxSearchResults: z.number().step(1).min(1).default(20),
  maxTraverseNodes: z.number().step(1).min(1).default(50),
  maxListNotes: z.number().step(1).min(1).default(200),
})

/** Fully resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedConfig {
  readonly watch: boolean
  readonly debounceMs: number
  readonly maxSearchResults: number
  readonly maxTraverseNodes: number
  readonly maxListNotes: number
}

/**
 * Resolve and validate plugin config: numeric caps must be positive integers.
 * @param config - raw plugin config.
 * @returns validated runtime parameters.
 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const candidate: Config = config ?? {}
  for (const key of ['debounceMs', 'maxSearchResults', 'maxTraverseNodes', 'maxListNotes'] as const) {
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
    maxListNotes: candidate.maxListNotes ?? 200,
  }
}

/**
 * Extract exact `[[wikilink]]` targets from markdown body text, deduplicated.
 * @param body - markdown text to scan.
 * @returns unique link titles in occurrence order.
 */
export function extractWikiLinks(body: string): string[] {
  const links = new Set<string>()
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) {
    /* v8 ignore next -- the capture group always participates in a match. */
    const title = (match[1]?.trim() ?? '').split('#')[0]?.trim() ?? ''
    if (title !== '') links.add(title)
  }
  return [...links]
}

/** Recover provider-owned interrupted distillation transactions before indexing a vault. */
async function recoverDistillTransactions(dir: string): Promise<void> {
  const entries = await readdir(dir)
  for (const name of entries) {
    const match = /^\.memory-distill-([a-f0-9]+)\.json$/.exec(name)
    if (match === null) continue
    const transactionId = name.slice('.memory-distill-'.length, -'.json'.length)
    const manifestPath = join(dir, name)
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') throw new Error(`memory-local: invalid recovery manifest ${name}`)
    const manifest = parsed as Partial<DistillRecoveryManifest>
    const participants = manifest.participantManifestPaths
    const coordinatorPath = manifest.coordinatorPath
    const currentManifestPath = resolve(manifestPath)
    if (typeof coordinatorPath !== 'string' || typeof manifest.journalExisted !== 'boolean'
      || basename(coordinatorPath) !== `.memory-distill-${transactionId}.committed`
      || !isStringArray(participants) || participants.length === 0 || participants.length > 2
      || participants.some(path => !isAbsolute(path) || basename(path) !== name)
      || new Set(participants.map(path => resolve(path))).size !== participants.length
      || !participants.some(path => resolve(path) === currentManifestPath)
      || !participants.some(path => resolve(dirname(path)) === resolve(dirname(coordinatorPath)))
      || !validDistillRecoveryPaths(transactionId, manifest)) {
      throw new Error(`memory-local: invalid recovery manifest ${name}`)
    }
    const committed = await readDistillCoordinator(coordinatorPath, transactionId, participants)
    if (!committed) {
      for (const path of manifest.notePaths) await rm(join(dir, path), { force: true })
      const journal = join(dir, manifest.journalPath)
      const backup = join(dir, manifest.journalBackupPath)
      if (await pathExists(backup)) {
        await rm(journal, { force: true })
        await rename(backup, journal)
      } else if (!manifest.journalExisted) {
        await rm(journal, { force: true })
      } else {
        throw new Error(`memory-local: recovery backup is missing for ${manifest.journalPath}`)
      }
    }
    for (const path of manifest.noteStagedPaths) await rm(join(dir, path), { force: true })
    await rm(join(dir, manifest.journalStagedPath), { force: true })
    await rm(join(dir, manifest.journalBackupPath), { force: true })
    await rm(manifestPath, { force: true })
  }
  for (const name of await readdir(dir)) {
    if (/^\.memory-distill-[a-f0-9]+(?:-[^.]+)?\.tmp$/.test(name)
      || /^\.memory-distill-[a-f0-9]+\.json\.tmp$/.test(name)) {
      await rm(join(dir, name), { force: true })
    }
  }
}

/** Validate that a recovery manifest can only mutate provider-owned local files. */
type DistillRecoveryPaths = Pick<DistillRecoveryManifest,
  'journalPath' | 'journalStagedPath' | 'journalBackupPath' | 'notePaths' | 'noteStagedPaths'>

/** True when a durable value is an array containing only strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function validDistillRecoveryPaths(
  transactionId: string,
  manifest: Partial<DistillRecoveryManifest>,
): manifest is Partial<DistillRecoveryManifest> & DistillRecoveryPaths {
  const notePaths = manifest.notePaths
  const stagedPaths = manifest.noteStagedPaths
  if (!isStringArray(notePaths) || !isStringArray(stagedPaths)
    || notePaths.length === 0 || notePaths.length !== stagedPaths.length) return false
  if (typeof manifest.journalPath !== 'string' || !/^journal\/\d{4}-\d{2}-\d{2}\.md$/.test(manifest.journalPath)) return false
  const journalStage = new RegExp(`^\\.memory-distill-${transactionId}-(project|global)-journal\\.tmp$`)
  const journalBackup = new RegExp(`^\\.memory-distill-${transactionId}-(project|global)-journal\\.backup$`)
  if (typeof manifest.journalStagedPath !== 'string' || !journalStage.test(manifest.journalStagedPath)) return false
  if (typeof manifest.journalBackupPath !== 'string' || !journalBackup.test(manifest.journalBackupPath)) return false
  for (const [index, notePath] of notePaths.entries()) {
    const suffix = /-([a-f0-9]{8})(?:-\d+)?\.md$/.exec(notePath)?.[1]
    if (suffix === undefined || !/^notes\/[^/]+-[a-f0-9]{8}(?:-\d+)?\.md$/.test(notePath)
      || stagedPaths[index] !== `.memory-distill-${transactionId}-note-${index}-${suffix}.tmp`) return false
  }
  return true
}

interface DistillCoordinatorMarker {
  readonly transactionId: string
  readonly participantManifestPaths: readonly string[]
}

/** Read and authenticate one coordinator marker without mutating its vault. */
async function readDistillCoordinator(
  path: string,
  transactionId: string,
  participants: readonly string[],
): Promise<boolean> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object') throw new Error('memory-local: invalid distillation coordinator marker')
  const marker = parsed as Partial<DistillCoordinatorMarker>
  if (marker.transactionId !== transactionId || !Array.isArray(marker.participantManifestPaths)
    || marker.participantManifestPaths.length !== participants.length
    || marker.participantManifestPaths.some((participant, index) => participant !== participants[index])) {
    throw new Error('memory-local: invalid distillation coordinator marker')
  }
  return true
}

/** Remove completed coordinator markers only from the vault that owns them. */
async function sweepDistillCoordinators(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const match = /^\.memory-distill-([a-f0-9]+)\.committed$/.exec(name)
    if (match === null) continue
    const transactionId = name.slice('.memory-distill-'.length, -'.committed'.length)
    const path = join(dir, name)
    const text = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') throw new Error(`memory-local: invalid coordinator marker ${name}`)
    const marker = parsed as Partial<DistillCoordinatorMarker>
    if (marker.transactionId !== transactionId || !isStringArray(marker.participantManifestPaths)
      || marker.participantManifestPaths.length === 0 || marker.participantManifestPaths.length > 2
      || marker.participantManifestPaths.some(participant => !isAbsolute(participant)
        || basename(participant) !== `.memory-distill-${transactionId}.json`)) {
      throw new Error(`memory-local: invalid coordinator marker ${name}`)
    }
    const remaining = await Promise.all(marker.participantManifestPaths.map(participant => pathExists(participant)))
    if (remaining.every(exists => !exists)) await rm(path, { force: true })
  }
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
    private readonly onChange: (dir: string, paths: readonly string[]) => void,
  ) {}

  /** Open the directory, index, and watcher, then run the initial full reconcile. */
  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await recoverDistillTransactions(this.dir)
    this.db = await openIndexFile(this.dir)
    await this.reconcile()
    if (this.config.watch) {
      this.watcher = new VaultWatcher(this.dir, this.config.debounceMs, paths => this.onWatcherBatch(paths), this.watchImpl, this.warn)
      this.watcher.start()
    }
  }

  /** Sweep committed transaction markers owned by this vault. */
  async sweepDistillCoordinators(): Promise<void> {
    await this.run(() => sweepDistillCoordinators(this.dir))
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

  /** Index one watcher batch, then report its changed files to change consumers. */
  private async onWatcherBatch(paths: string[]): Promise<void> {
    await this.reconcile(paths)
    this.onChange(this.dir, paths.map(path => relative(this.dir, path).split(sep).join('/')))
  }

  /** Full or incremental index reconciliation from vault files. */
  async reconcile(paths?: string[]): Promise<void> {
    await this.run(() => this.reconcileLocked(paths))
  }

  /** Reconcile while the caller already owns this vault's exclusive chain. */
  async reconcileLocked(paths?: string[]): Promise<void> {
    const db = this.database
    const full = paths === undefined || paths.length === 0
    const touched = new Set(full ? [] : paths)
    if (full) {
      for (const file of await this.walkMarkdown()) touched.add(file)
    }
    for (const path of touched) {
      if (await this.indexFile(path)) continue
      this.removeByPath(path)
    }
    if (full) {
      const indexed = new Set(listIndexedPaths(db))
      for (const path of touched) indexed.delete(path)
      for (const path of indexed) {
        const row = db.prepare('SELECT id FROM notes WHERE path = ?').get(path) as { id: string } | undefined
        /* v8 ignore next -- index rows are path-unique, so the lookup always resolves. */
        if (row === undefined) continue
        removeIndexedNote(db, row.id)
      }
    }
  }

  /** Index one markdown file; `false` means the file is gone and rows must drop. */
  private async indexFile(path: string): Promise<boolean> {
    const db = this.database
    // Index rows always store vault-relative forward-slash paths: reconciled
    // walk entries arrive native-separated and watcher batches arrive absolute.
    const rel = (isAbsolute(path) ? relative(this.dir, path) : path).split(sep).join('/')
    const absolute = join(this.dir, rel)
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
      const title = basename(rel, '.md')
      upsertIndexedNote(
        db,
        { id: `adopted:${rel}`, path: rel, title, created: info.mtimeMs, updated: info.mtimeMs, tags: [] },
        text,
        extractWikiLinks(text),
        [],
      )
      return true
    }
    const created = Number.isFinite(Date.parse(parsed.frontmatter.created)) ? Date.parse(parsed.frontmatter.created) : info.mtimeMs
    upsertIndexedNote(
      db,
      {
        id: parsed.frontmatter.id,
        path: rel,
        title: parsed.frontmatter.title,
        created,
        updated: info.mtimeMs,
        tags: parsed.frontmatter.tags,
      },
      parsed.body,
      extractWikiLinks(parsed.body),
      parsed.frontmatter.related,
    )
    return true
  }

  /** Drop index rows for one missing file. */
  private removeByPath(path: string): void {
    const db = this.database
    const rel = (isAbsolute(path) ? relative(this.dir, path) : path).split(sep).join('/')
    const row = db.prepare('SELECT id FROM notes WHERE path = ?').get(rel) as { id: string } | undefined
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
        const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
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

/** Test-only fail points for the multi-file distillation commit path. */
export interface LocalMemoryProviderDistillHooks {
  afterStageNote?(title: string): void | Promise<void>
  afterWriteNote?(title: string): void | Promise<void>
  afterIndexNote?(title: string): void | Promise<void>
  afterStageJournal?(title: string): void | Promise<void>
  afterWriteJournal?(title: string): void | Promise<void>
  afterIndexJournal?(title: string): void | Promise<void>
  beforeVerify?(): void | Promise<void>
  beforeReadNote?(title: string): void | Promise<void>
  beforeVerifyLinks?(title: string): void | Promise<void>
  beforeFinalize?(): void | Promise<void>
  shortId?(): string
  verificationFault?: 'journalIndex' | 'journalAnchor' | 'noteIndex' | 'noteBacklink' | 'journalLink' | 'indexedBacklink' | 'predecessor'
}

/** The sibling folder a vault's soft-deleted files move into. */
export const TRASH_DIR_NAME = 'memory-trash'

/**
 * The first non-empty body line, for list excerpts. Multiline bodies start at
 * their first meaningful line; an effectively empty body excerpts empty.
 * @param body - note body text.
 * @returns the trimmed first non-empty line.
 */
export function firstLine(body: string): string {
  for (const line of body.split('\n')) {
    if (line.trim() !== '') return line.trim()
  }
  return ''
}

/** Convert model-authored wikilinks into plain labels before host links are added. */
function stripWikiLinks(body: string): string {
  return body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias: string | undefined) =>
    alias ?? target)
}

/** Short suffix used in distillation filenames and journal anchors. */
function shortId(): string {
  return randomBytes(4).toString('hex')
}

/** Canonical lookup key for one vault on the host filesystem. */
function vaultKey(path: string): string {
  const absolute = resolve(path)
  /* v8 ignore next -- the opposite case is exercised by the POSIX CI matrix. */
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

interface PlannedDistillNote {
  readonly id: MemoryNoteId
  readonly title: string
  readonly path: string
  readonly stagedPath: string
  readonly content: string
  readonly body: string
  readonly tags: readonly string[]
  readonly related: readonly string[]
  readonly created: number
  updated?: number
  readonly createdIso: string
  updatedIso: string
  readonly journalAnchor: string
  readonly previous?: { readonly id: MemoryNoteId; readonly title: string; readonly path: string }
}

interface PlannedDistillGroup {
  readonly scope: 'project' | 'global'
  readonly dir: string
  readonly vault: Vault
  readonly date: string
  readonly journalTitle: string
  readonly journalPath: string
  readonly journalStagedPath: string
  readonly journalBackupPath: string
  readonly journalAnchor: string
  readonly journalBody: string
  readonly notes: readonly PlannedDistillNote[]
  readonly manifestPath: string
  readonly coordinatorPath: string
  journalBefore: string | undefined
  journalInspected: boolean
}

interface DistillRecoveryManifest {
  readonly coordinatorPath: string
  readonly participantManifestPaths: readonly string[]
  readonly journalPath: string
  readonly journalStagedPath: string
  readonly journalBackupPath: string
  readonly journalExisted: boolean
  readonly notePaths: readonly string[]
  readonly noteStagedPaths: readonly string[]
}

/** A vault-relative markdown path without its `.md` extension. */
function pathStem(path: string): string {
  return path.slice(0, -3)
}

/** Render an exact path-targeted Obsidian link with a human title. */
function wikiPath(path: string, title: string, anchor = ''): string {
  return `[[${pathStem(path)}${anchor}|${title.replaceAll(']]', '')}]]`
}

/** Hold every participating vault chain until one whole-turn operation settles. */
function withVaultLocks<T>(vaults: readonly Vault[], work: () => Promise<T>, index = 0): Promise<T> {
  const vault = vaults[index]
  if (vault === undefined) return work()
  return vault.run(() => withVaultLocks(vaults, work, index + 1))
}

/** Collect rejected reasons as unknown values from settled cleanup work. */
function rejectedReasons(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
}

/** A Windows-filename-safe UTC timestamp for one trashed file. */
function trashStamp(): string {
  return new Date().toISOString().replaceAll(':', '-')
}

/** `stat` one path; `false` when it does not exist, other faults propagate. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    /* v8 ignore next -- non-ENOENT stat faults surface as caller errors; platform-specific. */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    /* v8 ignore next -- the non-ENOENT branch above is platform-specific. */
    throw error
  }
}

/**
 * Move one vault file into the sibling trash folder outside the vault, under
 * its original subpath with a timestamped filename. A colliding name gains a
 * numeric suffix; a source that vanished before the move reports `undefined`
 * so the caller still drops the index rows.
 * @param source - absolute source file path.
 * @param vaultDir - vault directory the file lived in.
 * @param rel - source path relative to the vault root.
 * @returns the absolute trash path, or `undefined` when the source is gone.
 */
export async function moveToTrash(source: string, vaultDir: string, rel: string): Promise<string | undefined> {
  if (!(await pathExists(source))) return undefined
  const trashDir = join(dirname(vaultDir), TRASH_DIR_NAME)
  const stamp = trashStamp()
  const base = basename(rel, '.md')
  let destination = join(trashDir, dirname(rel), `${base}.${stamp}.md`)
  let suffix = 2
  while (await pathExists(destination)) {
    destination = join(trashDir, dirname(rel), `${base}.${stamp}-${suffix}.md`)
    suffix += 1
  }
  await mkdir(dirname(destination), { recursive: true })
  await rename(source, destination)
  return destination
}

/**
 * File-first memory provider: one vault handle per directory, the four
 * service operations over markdown files plus their derived SQLite index.
 */
export class LocalMemoryProvider implements MemoryProvider {
  private readonly vaults = new Map<string, Vault>()
  private readonly watchImpl: WatchImpl
  private distillCommits: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: ResolvedConfig,
    watchImpl?: WatchImpl,
    private readonly warn: (error: unknown) => void = silentWarn,
    private readonly onChange: (dir: string, paths: readonly string[]) => void = () => {},
    private readonly distillHooks: LocalMemoryProviderDistillHooks = {},
  ) {
    this.watchImpl = watchImpl ?? chokidarWatch
  }

  /** Open (once) and return the vault handle for one directory. */
  private async vault(dir: string): Promise<Vault> {
    const absolute = resolve(dir)
    const key = vaultKey(absolute)
    let vault = this.vaults.get(key)
    if (vault === undefined) {
      vault = new Vault(absolute, this.config, this.watchImpl, this.warn, this.onChange)
      this.vaults.set(key, vault)
      await vault.open()
      for (const opened of this.vaults.values()) await opened.sweepDistillCoordinators()
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

  async readPersona(dir: string, signal?: AbortSignal): Promise<{ path: string; text: string } | undefined> {
    signal?.throwIfAborted()
    const path = 'MEMORY.md'
    let text: string
    try {
      text = await readFile(join(dir, path), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    return { path, text }
  }

  async recentNotes(
    opts: MemoryRecentOptions | undefined,
    dir: string,
    signal?: AbortSignal,
  ): Promise<MemoryRecentNote[]> {
    signal?.throwIfAborted()
    if (opts?.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
      throw new Error(`memory-local: recent limit must be a positive integer, got ${opts.limit}`)
    }
    const cap = Math.min(opts?.limit ?? this.config.maxSearchResults, this.config.maxSearchResults)
    const vault = await this.vault(dir)
    return vault.run(async () => {
      const rows = vault.database.prepare(
        'SELECT id, path, title, updated FROM notes WHERE path LIKE ? ORDER BY updated DESC, rowid DESC LIMIT ?',
      ).all(`${NOTES_DIR}/%`, cap) as Array<{ id: string; path: string; title: string; updated: number }>
      const notes: MemoryRecentNote[] = []
      for (const row of rows) {
        signal?.throwIfAborted()
        const text = await readFile(join(dir, row.path), 'utf8')
        const parsed = parseNote(text)
        notes.push({ path: row.path, title: row.title, body: parsed?.body ?? text, updated: row.updated })
      }
      return notes
    })
  }

  async appendJournal(
    input: MemoryJournalAppendInput,
    dir: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; date: string }> {
    signal?.throwIfAborted()
    const date = validateJournalDate(input.date ?? new Date().toISOString().slice(0, 10))
    if (input.title.trim() === '' || input.title.includes('\n')) {
      throw new Error('memory-local: journal title must be a single non-empty line')
    }
    if (input.body.trim() === '') {
      throw new Error('memory-local: journal body must not be empty')
    }
    const path = `${JOURNAL_DIR}/${date}.md`
    const vault = await this.vault(dir)
    return vault.run(async () => {
      signal?.throwIfAborted()
      const absolute = join(dir, path)
      let text: string
      try {
        text = await readFile(absolute, 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        text = stringifyJournalFrontmatter(date)
      }
      text = `${text.trimEnd()}\n\n## ${input.title}\n${input.body}\n`
      await mkdir(join(dir, JOURNAL_DIR), { recursive: true })
      await writeFile(absolute, text, 'utf8')
      const after = await stat(absolute)
      upsertIndexedNote(
        vault.database,
        { id: `adopted:${path}`, path, title: date, created: after.mtimeMs, updated: after.mtimeMs, tags: [] },
        text,
        extractWikiLinks(text),
        [],
      )
      return { path, date }
    })
  }

  async commitDistill(
    groups: readonly MemoryDistillCommitGroupInput[],
    dirs: Readonly<Record<'project' | 'global', string | undefined>>,
    signal?: AbortSignal,
  ): Promise<MemoryDistillCommitResult> {
    signal?.throwIfAborted()
    if (groups.length === 0) {
      throw new Error('memory-local: distillation commit requires at least one scope group')
    }
    const run = this.distillCommits.then(() => this.commitDistillUnlocked(groups, dirs, signal))
    this.distillCommits = run.then(() => undefined, () => undefined)
    return run
  }

  private async commitDistillUnlocked(
    groups: readonly MemoryDistillCommitGroupInput[],
    dirs: Readonly<Record<'project' | 'global', string | undefined>>,
    signal?: AbortSignal,
  ): Promise<MemoryDistillCommitResult> {
    const inputs: Array<{ group: MemoryDistillCommitGroupInput; dir: string; vault: Vault }> = []
    const scopes = new Set<string>()
    for (const group of groups) {
      signal?.throwIfAborted()
      if (group.notes.length === 0) {
        throw new Error('memory-local: distillation scope group must create at least one node')
      }
      if (scopes.has(group.scope)) throw new Error(`memory-local: duplicate distillation scope group ${group.scope}`)
      scopes.add(group.scope)
      const dir = dirs[group.scope]
      if (dir === undefined) {
        throw new MemoryError('project-scope distillation requires a session working directory', 'NO_PROJECT_SCOPE')
      }
      const vault = await this.vault(dir)
      inputs.push({ group, dir, vault })
    }
    const vaults = [...new Set(inputs.map(input => input.vault))].sort((a, b) => a.dir.localeCompare(b.dir))
    if (vaults.length !== inputs.length) {
      throw new Error('memory-local: project and global distillation scopes must use different vault directories')
    }
    return withVaultLocks(vaults, async () => {
      const transactionId = this.nextDistillShortId()
      const coordinatorInput = inputs.find(input => input.group.scope === 'global') ?? inputs[0]
      /* v8 ignore next -- the public entry point rejects an empty group list before planning. */
      if (coordinatorInput === undefined) throw new Error('memory-local: distillation commit requires an input group')
      const coordinatorVault = coordinatorInput.vault
      const coordinatorPath = join(coordinatorVault.dir, `.memory-distill-${transactionId}.committed`)
      const plans = inputs.map(({ group, dir, vault }) => this.planDistillGroup(group, dir, vault, transactionId, coordinatorPath))
      const participantManifestPaths = plans.map(plan => join(plan.dir, plan.manifestPath))
      try {
        for (const plan of plans) await this.stageDistillGroup(plan, signal)
        for (const plan of plans) await this.writeDistillManifest(plan, participantManifestPaths)
        for (const plan of plans) await this.publishDistillGroup(plan, signal)
        for (const plan of plans) await this.indexDistillGroup(plan)
        await this.distillHooks.beforeVerify?.()
        for (const plan of plans) await this.verifyDistillGroup(plan)
        const stagedCoordinator = `${coordinatorPath}.tmp`
        await mkdir(dirname(coordinatorPath), { recursive: true })
        await writeFile(stagedCoordinator, `${JSON.stringify({
          transactionId,
          participantManifestPaths,
        } satisfies DistillCoordinatorMarker)}\n`, 'utf8')
        await rename(stagedCoordinator, coordinatorPath)
      } catch (error: unknown) {
        const rolledBack = await Promise.allSettled(plans.map(plan => this.rollbackDistillGroup(plan)))
        await rm(coordinatorPath, { force: true })
        await rm(`${coordinatorPath}.tmp`, { force: true })
        const rollbackErrors = rejectedReasons(rolledBack)
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], 'memory-local: distillation commit and rollback failed')
        }
        throw error
      }
      const finalized = await Promise.allSettled([
        Promise.resolve().then(() => this.distillHooks.beforeFinalize?.()),
        ...plans.map(plan => this.finalizeDistillGroup(plan)),
      ])
      const cleanupErrors = rejectedReasons(finalized)
      if (cleanupErrors.length === 0) {
        try {
          await rm(coordinatorPath, { force: true })
        } catch (error: unknown) {
          this.warn(error)
        }
      } else {
        for (const error of cleanupErrors) this.warn(error)
      }
      return {
        notes: plans.flatMap(plan => plan.notes.map(note => ({
          id: note.id,
          scope: plan.scope,
          title: note.title,
          path: note.path,
          created: note.createdIso,
          updated: note.updatedIso,
          journalAnchor: note.journalAnchor,
          ...(note.previous === undefined ? {} : { previous: note.previous }),
        }))),
        journals: plans.map(plan => ({
          scope: plan.scope,
          path: plan.journalPath,
          date: plan.date,
          title: plan.journalTitle,
          anchor: plan.journalAnchor,
        })),
      }
    })
  }

  private planDistillGroup(
    group: MemoryDistillCommitGroupInput,
    dir: string,
    vault: Vault,
    transactionId: string,
    coordinatorPath: string,
  ): PlannedDistillGroup {
    const date = validateJournalDate(group.date)
    if (group.journalTitle.trim() === '' || group.journalTitle.includes('\n')) {
      throw new Error('memory-local: distillation journal title must be a single non-empty line')
    }
    if (group.journalBody.trim() === '') {
      throw new Error('memory-local: distillation journal body must not be empty')
    }
    const taken = new Set(listIndexedPaths(vault.database))
    const notes: PlannedDistillNote[] = []
    const journalPath = `${JOURNAL_DIR}/${date}.md`
    const journalAnchor = `^memory-${transactionId}-${group.scope}`
    for (const [noteIndex, input] of group.notes.entries()) {
      if (input.title.trim() === '' || input.title.includes('\n')) {
        throw new Error('memory-local: distillation note title must be a single non-empty line')
      }
      if (input.content.trim() === '') {
        throw new Error('memory-local: distillation note content must not be empty')
      }
      const id = MemoryNoteId(randomUUID())
      const suffix = this.nextDistillShortId()
      const path = newDistillNotePath(input.title, suffix, taken)
      taken.add(path)
      const previousRow = findLatestIndexedNoteByTitle(vault.database, input.title)
      const previous = previousRow !== undefined && previousRow.path.startsWith(`${NOTES_DIR}/`)
        ? { id: MemoryNoteId(previousRow.id), title: previousRow.title, path: previousRow.path }
        : undefined
      const relatedRows = (input.related ?? [])
        .map(title => findIndexedNote(vault.database, title))
        .filter((row): row is NonNullable<typeof row> => row !== undefined && row.path.startsWith(`${NOTES_DIR}/`))
      const related = [...new Set([
        ...relatedRows.map(row => pathStem(row.path)),
        ...(previous === undefined ? [] : [pathStem(previous.path)]),
      ])]
      const body = [
        stripWikiLinks(input.content).trim(),
        `Source: ${wikiPath(journalPath, date, `#${journalAnchor}`)}`,
        ...previous === undefined ? [] : [`Previous: ${wikiPath(previous.path, previous.title)}`],
      ].join('\n\n')
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      notes.push({
        id,
        title: input.title,
        path,
        stagedPath: `.memory-distill-${transactionId}-note-${noteIndex}-${suffix}.tmp`,
        content: stripWikiLinks(input.content).trim(),
        body,
        tags: input.tags ?? [],
        related,
        created: now,
        createdIso: nowIso,
        updatedIso: nowIso,
        journalAnchor,
        ...(previous === undefined ? {} : { previous }),
      })
    }
    const journalBody = [
      stripWikiLinks(group.journalBody).trim(),
      `- Touched nodes: ${notes.map(note => wikiPath(note.path, note.title)).join(', ')}`,
      journalAnchor,
    ].join('\n')
    return {
      scope: group.scope,
      dir,
      vault,
      date,
      journalTitle: group.journalTitle,
      journalPath,
      journalStagedPath: `.memory-distill-${transactionId}-${group.scope}-journal.tmp`,
      journalBackupPath: `.memory-distill-${transactionId}-${group.scope}-journal.backup`,
      journalAnchor,
      journalBody,
      notes,
      manifestPath: `.memory-distill-${transactionId}.json`,
      coordinatorPath,
      journalBefore: undefined,
      journalInspected: false,
    }
  }

  private async stageDistillGroup(plan: PlannedDistillGroup, signal?: AbortSignal): Promise<void> {
    for (const note of plan.notes) {
      signal?.throwIfAborted()
      const frontmatter = {
        id: note.id,
        scope: plan.scope,
        title: note.title,
        created: note.createdIso,
        updated: new Date(Date.now()).toISOString(),
        tags: note.tags,
        related: note.related,
      }
      const text = stringifyNote(frontmatter, note.body)
      note.updatedIso = frontmatter.updated
      await writeFile(join(plan.dir, note.stagedPath), text, 'utf8')
      await this.distillHooks.afterStageNote?.(note.title)
    }
    const absolute = join(plan.dir, plan.journalPath)
    try {
      plan.journalBefore = await readFile(absolute, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      plan.journalBefore = undefined
    }
    plan.journalInspected = true
    const before = plan.journalBefore ?? stringifyJournalFrontmatter(plan.date)
    const text = `${before.trimEnd()}\n\n## ${plan.journalTitle}\n${plan.journalBody}\n`
    await writeFile(join(plan.dir, plan.journalStagedPath), text, 'utf8')
    await this.distillHooks.afterStageJournal?.(plan.journalTitle)
  }

  private async writeDistillManifest(plan: PlannedDistillGroup, participantManifestPaths: readonly string[]): Promise<void> {
    const manifest: DistillRecoveryManifest = {
      coordinatorPath: plan.coordinatorPath,
      participantManifestPaths,
      journalPath: plan.journalPath,
      journalStagedPath: plan.journalStagedPath,
      journalBackupPath: plan.journalBackupPath,
      journalExisted: plan.journalBefore !== undefined,
      notePaths: plan.notes.map(note => note.path),
      noteStagedPaths: plan.notes.map(note => note.stagedPath),
    }
    const staged = `${plan.manifestPath}.tmp`
    await writeFile(join(plan.dir, staged), `${JSON.stringify(manifest)}\n`, 'utf8')
    await rename(join(plan.dir, staged), join(plan.dir, plan.manifestPath))
  }

  private async publishDistillGroup(plan: PlannedDistillGroup, signal?: AbortSignal): Promise<void> {
    for (const note of plan.notes) {
      signal?.throwIfAborted()
      await mkdir(join(plan.dir, dirname(note.path)), { recursive: true })
      await rename(join(plan.dir, note.stagedPath), join(plan.dir, note.path))
      await this.distillHooks.afterWriteNote?.(note.title)
    }
    const journal = join(plan.dir, plan.journalPath)
    await mkdir(dirname(journal), { recursive: true })
    if (plan.journalBefore !== undefined) {
      await rename(journal, join(plan.dir, plan.journalBackupPath))
    }
    await rename(join(plan.dir, plan.journalStagedPath), journal)
    await this.distillHooks.afterWriteJournal?.(plan.journalTitle)
  }

  private async indexDistillGroup(plan: PlannedDistillGroup): Promise<void> {
    const db = plan.vault.database
    for (const note of plan.notes) {
      const after = await stat(join(plan.dir, note.path))
      note.updated = after.mtimeMs
      upsertIndexedNote(
        db,
        { id: note.id, path: note.path, title: note.title, created: note.created, updated: after.mtimeMs, tags: note.tags },
        note.body,
        extractWikiLinks(note.body),
        note.related,
      )
      await this.distillHooks.afterIndexNote?.(note.title)
    }
    const journal = join(plan.dir, plan.journalPath)
    const text = await readFile(journal, 'utf8')
    const after = await stat(journal)
    upsertIndexedNote(
      db,
      { id: `adopted:${plan.journalPath}`, path: plan.journalPath, title: plan.date, created: after.mtimeMs, updated: after.mtimeMs, tags: [] },
      text,
      extractWikiLinks(text),
      [],
    )
    await this.distillHooks.afterIndexJournal?.(plan.journalTitle)
  }

  private async verifyDistillGroup(plan: PlannedDistillGroup): Promise<void> {
    const db = plan.vault.database
    const journal = findIndexedNoteById(db, `adopted:${plan.journalPath}`)
    if (this.distillHooks.verificationFault === 'journalIndex' || journal === undefined || journal.path !== plan.journalPath) {
      throw new Error(`memory-local: committed journal ${plan.journalPath} is not indexed`)
    }
    const journalText = await readFile(join(plan.dir, plan.journalPath), 'utf8')
    if (this.distillHooks.verificationFault === 'journalAnchor' || !journalText.includes(plan.journalAnchor)) {
      throw new Error(`memory-local: committed journal ${plan.journalPath} is missing anchor ${plan.journalAnchor}`)
    }
    for (const note of plan.notes) {
      await this.distillHooks.beforeReadNote?.(note.title)
      const row = findIndexedNoteById(db, note.id)
      if (this.distillHooks.verificationFault === 'noteIndex' || row === undefined || row.path !== note.path) {
        throw new Error(`memory-local: committed node ${note.path} is not indexed`)
      }
      const read = await this.materialize(plan.dir, plan.scope, plan.vault, row)
      if (this.distillHooks.verificationFault === 'noteBacklink'
        || !read.body.includes(wikiPath(plan.journalPath, plan.date, `#${note.journalAnchor}`))) {
        throw new Error(`memory-local: committed node ${note.path} is missing its journal backlink`)
      }
      await this.distillHooks.beforeVerifyLinks?.(note.title)
      if (this.distillHooks.verificationFault === 'journalLink' || !journalText.includes(wikiPath(note.path, note.title))) {
        throw new Error(`memory-local: committed journal ${plan.journalPath} does not link node ${note.title}`)
      }
      if (this.distillHooks.verificationFault === 'indexedBacklink' || !read.backlinks.some(link => link.title === plan.date)) {
        throw new Error(`memory-local: committed node ${note.path} has no indexed journal backlink`)
      }
      if (note.previous !== undefined && (this.distillHooks.verificationFault === 'predecessor'
        || !read.related.some(link => link.id === note.previous?.id))) {
        throw new Error(`memory-local: committed node ${note.path} has no indexed predecessor link`)
      }
    }
  }

  private async rollbackDistillGroup(plan: PlannedDistillGroup): Promise<void> {
    for (const note of plan.notes) {
      await rm(join(plan.dir, note.path), { force: true })
      await rm(join(plan.dir, note.stagedPath), { force: true })
    }
    const journal = join(plan.dir, plan.journalPath)
    const backup = join(plan.dir, plan.journalBackupPath)
    if (await pathExists(backup)) {
      await rm(journal, { force: true })
      await rename(backup, journal)
    } else if (plan.journalInspected && plan.journalBefore === undefined) {
      await rm(journal, { force: true })
    }
    await rm(join(plan.dir, plan.journalStagedPath), { force: true })
    await rm(join(plan.dir, plan.manifestPath), { force: true })
    await rm(join(plan.dir, `${plan.manifestPath}.tmp`), { force: true })
    await plan.vault.reconcileLocked()
  }

  private async finalizeDistillGroup(plan: PlannedDistillGroup): Promise<void> {
    for (const note of plan.notes) await rm(join(plan.dir, note.stagedPath), { force: true })
    await rm(join(plan.dir, plan.journalStagedPath), { force: true })
    await rm(join(plan.dir, plan.journalBackupPath), { force: true })
    await rm(join(plan.dir, plan.manifestPath), { force: true })
    await rm(join(plan.dir, `${plan.manifestPath}.tmp`), { force: true })
  }

  private nextDistillShortId(): string {
    const id = this.distillHooks.shortId?.() ?? shortId()
    if (!/^[a-f0-9]{8}$/.test(id)) throw new Error('memory-local: distillation short id must be eight lowercase hex characters')
    return id
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

  async listNotes(
    opts: MemoryListOptions | undefined,
    dir: string,
    signal?: AbortSignal,
  ): Promise<MemoryListedNote[]> {
    signal?.throwIfAborted()
    if (opts?.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
      throw new Error(`memory-local: list limit must be a positive integer, got ${opts.limit}`)
    }
    const cap = Math.min(opts?.limit ?? this.config.maxListNotes, this.config.maxListNotes)
    const vault = await this.vault(dir)
    return vault.run(async () => {
      const rows = vault.database.prepare(
        "SELECT id, path, title, updated, tags FROM notes WHERE path = 'MEMORY.md' OR path LIKE 'notes/%' "
        + "ORDER BY (path = 'MEMORY.md') DESC, updated DESC, rowid DESC LIMIT ?",
      ).all(cap) as Array<{ id: string; path: string; title: string; updated: number; tags: string }>
      const notes: MemoryListedNote[] = []
      for (const row of rows) {
        signal?.throwIfAborted()
        const text = await readFile(join(dir, row.path), 'utf8')
        const parsed = parseNote(text)
        notes.push({
          id: MemoryNoteId(row.id),
          path: row.path,
          title: row.title,
          tags: parseTags(row.tags),
          updated: row.updated,
          excerpt: firstLine(parsed?.body ?? text),
          persona: row.path === 'MEMORY.md',
        })
      }
      return notes
    })
  }

  async delete(
    ref: string,
    dir: string,
    signal?: AbortSignal,
    opts?: MemoryDeleteOptions,
  ): Promise<{ id: MemoryNoteId; title: string; path: string; trashPath?: string }> {
    signal?.throwIfAborted()
    const vault = await this.vault(dir)
    return vault.run(async () => {
      signal?.throwIfAborted()
      const db = vault.database
      await vault.refreshIfStale(ref)
      const row = findIndexedNote(db, ref)
      if (row === undefined) {
        throw new MemoryError(`no memory note matches "${ref}"`, 'NOT_FOUND')
      }
      const absolute = join(dir, row.path)
      let trashPath: string | undefined
      if ((opts?.mode ?? 'trash') === 'trash') {
        trashPath = await moveToTrash(absolute, dir, row.path)
      } else {
        await rm(absolute, { force: true })
      }
      removeIndexedNote(db, row.id)
      db.prepare('DELETE FROM links WHERE to_title = ?').run(row.title)
      return {
        id: MemoryNoteId(row.id),
        title: row.title,
        path: row.path,
        ...(trashPath === undefined ? {} : { trashPath }),
      }
    })
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
          const targetId = findNoteIdByLinkTarget(db, toTitle)
          nodes.push({ ...(targetId !== undefined ? { id: MemoryNoteId(targetId) } : {}), title: toTitle, via: { kind: kind as 'wikilink' | 'related', direction: 'out' } })
          if (targetId !== undefined) next.push({ id: targetId, title: toTitle })
          if (nodes.length >= cap) { truncated = true; break outer }
        }
        const nodeRow = findIndexedNoteById(db, node.id)
        /* v8 ignore next -- traversal nodes always originate from an indexed row. */
        if (nodeRow === undefined) throw new Error(`index inconsistency: node ${node.id} has no row`)
        for (const { kind, fromId } of inLinksToNote(db, nodeRow)) {
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
  private async materialize(dir: string, scope: 'project' | 'global', vault: Vault, row: { id: string; path: string; title: string; updated: number; tags: readonly string[] }): Promise<MemoryNote> {
    const db = vault.database
    const text = await readFile(join(dir, row.path), 'utf8')
    const parsed = parseNote(text)
    const body = parsed?.body ?? text
    const related: MemoryLinkTarget[] = []
    for (const title of parsed?.frontmatter.related ?? []) {
      const targetId = findNoteIdByLinkTarget(db, title)
      related.push({ ...(targetId !== undefined ? { id: MemoryNoteId(targetId) } : {}), title })
    }
    const backlinks: MemoryLinkTarget[] = inLinksToNote(db, row).map(({ fromId }) => {
      const from = findIndexedNoteById(db, fromId)
      /* v8 ignore next -- link rows are only written for indexed notes. */
      if (from === undefined) throw new Error(`index inconsistency: link source ${fromId} has no note`)
      return { id: MemoryNoteId(fromId), title: from.title }
    })
    return {
      id: MemoryNoteId(row.id),
      scope,
      title: row.title,
      path: row.path,
      tags: row.tags,
      body,
      updated: row.updated,
      related,
      backlinks,
    }
  }

  /** Close every vault: watchers first, then drained chains, then databases. */
  async dispose(): Promise<void> {
    const vaults = [...this.vaults.values()]
    this.vaults.clear()
    await Promise.all(vaults.map(vault => vault.dispose()))
  }
}

/**
 * Mount the provider into the memory service; unloading closes vaults, data survives.
 * @param ctx - Cordis context carrying the memory service.
 * @param config - optional watch and bound configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  /* v8 ignore next -- the plugin-level warn body fires only on real watcher faults. */
  const provider = new LocalMemoryProvider(resolved, undefined, (error) =>{  ctx.logger.warn('memory-local: %s', String(error)) }, (dir, paths) => {
    ctx.emit('memory/change', { dir, paths: [...paths] })
  })
  ctx.memory.register(provider)
  ctx.effect(() => () => provider.dispose(), 'memory-local lifecycle')
}

/** Provider-owned id factory re-export for tests and diagnostics. */
export { MemoryNoteId }
