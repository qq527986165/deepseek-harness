/**
 * Chokidar-based vault watcher with the settings-file discipline: debounced
 * reloads, a ready-time full reconciliation pass, contained watcher errors,
 * and close-before-dispose quiescence.
 * @module @deepseek-ai/dsh-memory-local/watcher
 */

import { watch as chokidarWatch } from 'chokidar'
import { MEMORY_INDEX_FILE } from './schema.ts'

/** The chokidar surface the watcher needs; tests supply a fake. */
export interface WatchLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  close(): Promise<void>
}

/** A chokidar-compatible watch factory. */
export type WatchImpl = (path: string, options?: Record<string, unknown>) => WatchLike

/**
 * Watches one vault directory for markdown changes and hands debounced path
 * batches to `onChange`. An empty path batch signals the ready-time full
 * reconciliation pass. Watcher errors are reported to `warn` and never crash
 * the provider; reads still re-check mtimes as the fallback path.
 */
export class VaultWatcher {
  private handle: WatchLike | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly pending = new Set<string>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly dir: string,
    private readonly debounceMs: number,
    private readonly onChange: (paths: string[]) => Promise<void>,
    private readonly watchImpl: WatchImpl = chokidarWatch,
    private readonly warn: (error: unknown) => void = () => {},
  ) {}

  /** Open the watcher; idempotent per instance. */
  start(): void {
    if (this.handle !== undefined || this.closed) return
    this.handle = this.watchImpl(this.dir, { ignoreInitial: true, ignored: (path: unknown) => this.ignored(path) })
    this.handle.on('all', (event, path) => {
      // Directory events and non-markdown files are watched but not indexed:
      // chokidar's ignored predicate receives no directory stats, so extension
      // filtering must run here on the event name instead.
      if (event === 'addDir' || event === 'unlinkDir') return
      if (!String(path).endsWith('.md')) return
      this.enqueue(String(path))
    })
    this.handle.on('ready', () => {
      if (this.closed) return
      this.pending.clear()
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = undefined
      this.schedule(() => this.onChange([]))
    })
    this.handle.on('error', (error) =>{  this.warn(error) })
  }

  /** Close the watcher after every queued reconciliation settles. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.tail
    await this.handle?.close()
    this.handle = undefined
  }

  private ignored(path: unknown): boolean {
    // chokidar hands predicates unix-normalized paths; compare on the same form.
    const value = String(path).replaceAll('\\', '/')
    const dir = this.dir.replaceAll('\\', '/')
    if (value === `${dir}/${MEMORY_INDEX_FILE}`) return true
    return value.includes('/.obsidian/') || value.endsWith('/.obsidian')
  }

  private enqueue(path: string): void {
    if (this.closed) return
    this.pending.add(path)
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      const paths = [...this.pending]
      this.pending.clear()
      this.schedule(() => this.onChange(paths))
    }, this.debounceMs)
  }

  private schedule(work: () => Promise<void>): void {
    this.tail = this.tail.then(work).catch((error: unknown) => { this.warn(error) })
  }
}
