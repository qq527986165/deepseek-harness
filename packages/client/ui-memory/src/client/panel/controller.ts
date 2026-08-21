/**
 * Browser-local object layer behind the memory panel: the vault listing,
 * ranked search, note read with outbound wikilink resolution, conflict-aware
 * save, soft delete, and the provider-missing/error classification, all over
 * the generated `memory` Remote. React-free — it publishes immutable
 * snapshots through a HostObservable and the components only read those and
 * call its methods.
 * @module @deepseek-ai/dsh-client-ui-memory/client/panel/controller
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  MemoryLinkTarget,
  MemoryListedNote,
  MemoryNote,
  MemoryNoteId,
  MemoryRemoteListRequest,
  MemoryRemoteReadRequest,
  MemoryRemoteWriteRequest,
  MemoryScope,
  MemorySearchHit,
} from '@deepseek-ai/dsh-memory-remote/types'
import type { MemoryDraft, SaveOutcome } from '../contract/slots.ts'
import type { MemoryRemote } from '../contract/remote.ts'

/** The memory-lifecycle settings fields the panel reads. */
export interface PanelSettings {
  /** Age in days after which the panel marks a note with a review badge. */
  reviewAfterDays?: number
}

/** Default review threshold when the settings namespace answers nothing yet. */
const DEFAULT_REVIEW_AFTER_DAYS = 30

/** Panel data status: nothing loaded yet, loading, ready, or failed. */
export type MemoryPanelStatus = 'idle' | 'loading' | 'ready' | 'error'

/** A save conflict surfaced by the last attempt: the note changed after it was opened. */
export interface SaveConflict {
  /** The changed note's index update timestamp, for the notice. */
  readonly updated: number
}

/** One note opened in the read view, with its outbound wikilink resolution. */
export interface SelectionView {
  readonly note: MemoryNote
  /** Outbound body-wikilink targets resolved by exact title; `id` absent marks dangling. */
  readonly outbound: readonly MemoryLinkTarget[]
  /** True for adopted/journal files: no edit or delete affordances. */
  readonly readOnly: boolean
  /** The conflict surfaced by the latest save attempt, pending user confirmation. */
  readonly conflict: SaveConflict | null
}

/** Immutable panel snapshot published to the components. */
export interface MemoryPanelSnapshot {
  readonly status: MemoryPanelStatus
  readonly error: string | null
  /** True when the remote answers but no storage provider is mounted. */
  readonly providerMissing: boolean
  /** The configured global vault directory; null until info() answered. */
  readonly globalDir: string | null
  /** Review-badge threshold in days (settings value or the default). */
  readonly reviewAfterDays: number
  /** The vault this snapshot lists; project scopes carry the workspace dir. */
  readonly scope: MemoryScope
  readonly workspaceDir: string | undefined
  /** Absolute vault directory of the last successful listing; null until one. */
  readonly vaultDir: string | null
  /** Listable rows of the active vault, persona pinned first. */
  readonly rows: readonly MemoryListedNote[]
  /** Ranked hits while the query is non-empty; null on the plain listing. */
  readonly searchHits: readonly MemorySearchHit[] | null
  /** The opened note; null on the list view. */
  readonly selection: SelectionView | null
  /** True while a read/adjacency load for a selection is in flight. */
  readonly selectionLoading: boolean
  readonly selectionError: string | null
}

const INITIAL_SNAPSHOT: MemoryPanelSnapshot = Object.freeze({
  status: 'idle',
  error: null,
  providerMissing: false,
  globalDir: null,
  reviewAfterDays: DEFAULT_REVIEW_AFTER_DAYS,
  scope: 'global',
  workspaceDir: undefined,
  vaultDir: null,
  rows: Object.freeze([]),
  searchHits: null,
  selection: null,
  selectionLoading: false,
  selectionError: null,
})

/** Human-oriented classification of one Remote failure. */
export interface PanelFailure {
  /** True when the host answers but no storage provider is registered. */
  readonly providerMissing: boolean
  /** True when the failure is the provider's NOT_FOUND miss. */
  readonly notFound: boolean
  /** Message shown in the error state. */
  readonly message: string
}

/** The provider's NOT_FOUND message: `no memory note matches "<ref>"`. */
const NOT_FOUND_PATTERN = /^no memory note matches /u

/**
 * Classify one Remote failure into the panel's failure view.
 * @param error - Remote result error.
 * @returns the failure view.
 */
export function classifyFailure(error: { code: string; message: string }): PanelFailure {
  return {
    providerMissing: /no memory provider/i.test(error.message),
    notFound: NOT_FOUND_PATTERN.test(error.message),
    message: error.message,
  }
}

/** The failure-free result unwrap. */
type ResultUnwrap<T> = { ok: true; value: T } | { ok: false; error: PanelFailure }

/** Await one Remote call and unwrap it into the panel's failure view. */
async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<ResultUnwrap<T>> {
  const result = await call
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, error: classifyFailure(result.error) }
}

/** Whether a note id is an adopted identity (no provider-owned frontmatter). */
function isAdopted(id: MemoryNoteId): boolean {
  return String(id).startsWith('adopted:')
}

/** Extract exact `[[wikilink]]` targets from a body, deduplicated in occurrence order. */
function extractWikiLinkTargets(body: string): string[] {
  const targets = new Set<string>()
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) {
    /* v8 ignore next -- the pattern's group 1 always captures, so `.trim()` never yields nullish and the `?? ''` fallback is unreachable */
    const title = match[1]?.trim() ?? ''
    if (title !== '') targets.add(title)
  }
  return [...targets]
}

/**
 * Per-panel object layer over the memory Remote. One instance per client
 * plugin application; the two registrations (footer + drawer) share it through
 * the panel entry's inject hooks compartment. Serializes its operations on
 * one tail so rapid tab/query switches never interleave stale answers.
 */
export class MemoryPanelController implements HostObservable<MemoryPanelSnapshot> {
  private snapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  /** The vault the next load addresses; null when setView never ran. */
  private view: { scope: MemoryScope; workspaceDir?: string } | null = null
  private query = ''
  /** The update timestamp of the note the current selection read, for conflict checks. */
  private readUpdated: number | undefined
  /** Read-only pin carried by the latest note-open request, consumed by the next select. */
  private pendingReadOnly = false

  /**
   * @param remote - reader resolving the `memory` Remote namespace service.
   * @param settings - bound memory-lifecycle settings scope (review threshold).
   */
  constructor(
    private readonly remote: () => MemoryRemote,
    private readonly settings: SettingsScope<PanelSettings>,
  ) {
    settings.subscribe(() => { this.publish(this.with({})) })
    this.refreshInfo()
  }

  /** @returns the current snapshot (stable reference until the next change). */
  getSnapshot(): MemoryPanelSnapshot {
    return this.snapshot
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release listeners; later operations no-op. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  /**
   * Await the one-tick window in which the client assembly has provided the
   * `memory` namespace service but not yet installed its methods (the gateway
   * installs them one tick after providing the service). `info` is the
   * sentinel: every method installs in the same pass.
   */
  private async ready(): Promise<void> {
    while (!this.disposed && typeof this.remote().info !== 'function') {
      await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    }
  }

  /** Re-read the read-only service facts (global vault directory). */
  refreshInfo(): void {
    this.enqueue(async () => {
      await this.ready()
      if (this.disposed) return
      const info = await unwrap(this.remote().info())
      if (info.ok) this.publish(this.with({ globalDir: info.value.globalDir }))
    })
  }

  /**
   * Retarget the controller at one vault and load its rows. The project tab
   * stays idle until a registered workspace is picked (an unregistered or
   * missing directory would fail with NO_PROJECT_SCOPE).
   * @param view - scope plus optional project workspace directory.
   */
  setView(view: { scope: MemoryScope; workspaceDir?: string }): void {
    this.view = view
    this.publish(this.with({
      scope: view.scope,
      workspaceDir: view.workspaceDir,
      rows: Object.freeze([]),
      searchHits: null,
      selection: null,
      selectionError: null,
    }))
    if (view.scope === 'project' && (view.workspaceDir === undefined || view.workspaceDir === '')) return
    void this.load()
  }

  /**
   * Search the active vault; an empty query restores the plain listing.
   * @param query - FTS query text.
   */
  setQuery(query: string): void {
    this.query = query
    this.publish(this.with({
      ...(query === '' ? {} : { searchHits: Object.freeze([]) }),
      selection: null,
      selectionError: null,
    }))
    void this.load()
  }

  /**
   * Load one note into the read view, resolving its body wikilinks by exact
   * title (a NOT_FOUND miss becomes a dangling target). Consumes a
   * note-open-request's read-only pin once.
   * @param ref - note id or exact title.
   * @param readOnly - pin the read-only view (journal/adopted opens).
   */
  select(ref: string, readOnly = false): Promise<void> {
    return this.enqueueResult(() => this.runSelect(ref, readOnly))
  }

  /** Drop the current selection back to the list view. */
  clearSelection(): void {
    this.pendingReadOnly = false
    this.publish(this.with({ selection: null, selectionLoading: false, selectionError: null }))
  }

  /**
   * Re-read the note and save the draft. A changed update timestamp blocks the
   * write once and surfaces the conflict; the next save commits (overwrite).
   * @param draft - the edit form's complete value.
   * @returns committed, or conflict with the changed timestamp.
   */
  save(draft: MemoryDraft): Promise<SaveOutcome> {
    return this.enqueueResult(async (): Promise<SaveOutcome> => {
      const selection = this.snapshot.selection
      if (selection === null || this.view === null) return { outcome: 'committed' }
      const current = await unwrap(this.remote().read(this.readRequest(selection.note.id)))
      if (!current.ok) {
        this.publish(this.with({ error: current.error.message, status: 'error' }))
        return { outcome: 'failed', message: current.error.message }
      }
      if (current.value.updated !== this.readUpdated && selection.conflict === null) {
        this.publish(this.with({
          selection: { ...selection, conflict: { updated: current.value.updated } },
        }))
        return { outcome: 'conflict', updated: current.value.updated }
      }
      const written = await unwrap(this.remote().write(this.writeRequest(selection.note.id, draft)))
      if (!written.ok) {
        this.publish(this.with({
          error: written.error.message,
          status: 'error',
          ...(written.error.providerMissing ? { providerMissing: true } : {}),
        }))
        return { outcome: 'failed', message: written.error.message }
      }
      await this.loadBody()
      await this.runSelect(written.value.id, selection.readOnly)
      return { outcome: 'committed' }
    })
  }

  /**
   * Soft-delete the selected note into the vault's sibling trash folder.
   * @returns whether the deletion committed.
   */
  deleteSelected(): Promise<boolean> {
    return this.enqueueResult(async (): Promise<boolean> => {
      const selection = this.snapshot.selection
      if (selection === null || this.view === null) return false
      const deleted = await unwrap(this.remote().delete({
        ref: selection.note.id,
        scope: this.view.scope,
        ...(this.view.workspaceDir === undefined ? {} : { workspaceDir: this.view.workspaceDir }),
      }))
      if (!deleted.ok) {
        this.publish(this.with({
          error: deleted.error.message,
          status: 'error',
          ...(deleted.error.providerMissing ? { providerMissing: true } : {}),
        }))
        return false
      }
      await this.loadBody()
      this.publish(this.with({ selection: null }))
      return true
    })
  }

  /** Reload the active vault's rows (or search hits). */
  reload(): void {
    void this.load()
  }

  /**
   * Record one acknowledged node open request; its read-only pin rides the next select.
   * @param request - the open request: note ref, target scope, and the read-only pin.
   */
  noteOpenRequest(request: { ref: string; scope: MemoryScope; readOnly?: boolean }): void {
    this.pendingReadOnly = request.readOnly === true
  }

  /**
   * A forwarded `memory/change` payload touched the active vault: reload.
   * @param dir - absolute vault directory that changed.
   */
  reconcile(dir: string): void {
    if (this.snapshot.vaultDir !== null && this.snapshot.vaultDir === dir) {
      void this.load()
    }
  }

  /** Queue one background operation behind the panel's operation tail. */
  private enqueue(operation: () => Promise<void> | void): void {
    if (this.disposed) return
    this.tail = this.tail.then(operation, operation)
  }

  /** Queue one result-bearing operation behind the tail. */
  private enqueueResult<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** One select's body, callable inline from operations already on the tail. */
  private async runSelect(ref: string, readOnly: boolean): Promise<void> {
    const pinnedReadOnly = readOnly || this.pendingReadOnly
    this.pendingReadOnly = false
    this.publish(this.with({ selectionLoading: true, selectionError: null }))
    const note = await unwrap(this.remote().read(this.readRequest(ref)))
    if (!note.ok) {
      this.publish(this.with({
        selectionLoading: false,
        selectionError: note.error.message,
        ...(note.error.providerMissing ? { providerMissing: true } : {}),
      }))
      return
    }
    const outbound = await this.resolveOutbound(note.value)
    this.readUpdated = note.value.updated
    this.publish(this.with({
      selectionLoading: false,
      selection: {
        note: note.value,
        outbound,
        readOnly: pinnedReadOnly || isAdopted(note.value.id),
        conflict: null,
      },
    }))
  }

  /** Load the active vault according to the current view and query. */
  private load(): Promise<void> {
    const view = this.view
    if (view === null || this.disposed) return Promise.resolve()
    const request: MemoryRemoteListRequest = {
      scope: view.scope,
      ...(view.workspaceDir === undefined ? {} : { workspaceDir: view.workspaceDir }),
    }
    let settle: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })
    this.enqueue(() => this.runLoad(view, request).then(settle, settle))
    return done
  }

  /** One load run against the current view; callable inline from the tail. */
  private loadBody(): Promise<void> {
    const view = this.view
    if (view === null || this.disposed) return Promise.resolve()
    const request: MemoryRemoteListRequest = {
      scope: view.scope,
      ...(view.workspaceDir === undefined ? {} : { workspaceDir: view.workspaceDir }),
    }
    return this.runLoad(view, request)
  }

  /** One load's body, guarded against a superseded view or query. */
  private async runLoad(
    view: { scope: MemoryScope; workspaceDir?: string },
    request: MemoryRemoteListRequest,
  ): Promise<void> {
    const query = this.query
    if (this.view !== view) return
    this.publish(this.with({ status: 'loading', error: null }))
    await this.ready()
    if (this.disposed || this.view !== view) return
    if (query === '') {
      const listed = await unwrap(this.remote().list(request))
      if (this.view !== view || this.query !== query) return
      if (!listed.ok) {
        this.publish(this.with({
          status: 'error',
          error: listed.error.message,
          providerMissing: listed.error.providerMissing,
        }))
        return
      }
      this.publish(this.with({
        status: 'ready',
        error: null,
        providerMissing: false,
        vaultDir: listed.value.dir,
        rows: Object.freeze([...listed.value.notes]),
        searchHits: null,
      }))
      return
    }
    const searched = await unwrap(this.remote().search({ query, ...request }))
    if (this.view !== view || this.query !== query) return
    if (!searched.ok) {
      this.publish(this.with({
        status: 'error',
        error: searched.error.message,
        providerMissing: searched.error.providerMissing,
      }))
      return
    }
    this.publish(this.with({
      status: 'ready',
      error: null,
      providerMissing: false,
      rows: Object.freeze([]),
      searchHits: Object.freeze([...searched.value]),
    }))
  }

  /** Resolve one note's body wikilinks to exact targets within its vault. */
  private async resolveOutbound(note: MemoryNote): Promise<readonly MemoryLinkTarget[]> {
    const titles = extractWikiLinkTargets(note.body)
    if (titles.length === 0) return Object.freeze([])
    const resolved: MemoryLinkTarget[] = []
    for (const title of titles) {
      if (title === note.title) {
        resolved.push({ title, id: note.id })
        continue
      }
      const target = await unwrap(this.remote().read(this.readRequest(title)))
      resolved.push(target.ok
        ? { title, id: target.value.id }
        : { title })
    }
    return Object.freeze(resolved)
  }

  /** One read request addressed at the active vault. */
  private readRequest(ref: string): MemoryRemoteReadRequest {
    return {
      ref,
      scope: this.view?.scope ?? 'global',
      ...(this.view?.workspaceDir === undefined ? {} : { workspaceDir: this.view.workspaceDir }),
    }
  }

  /** One write request addressed at the active vault. */
  private writeRequest(id: MemoryNoteId, draft: MemoryDraft): MemoryRemoteWriteRequest {
    return {
      id,
      /* v8 ignore next -- save() returns before writeRequest when the view is null, so the `?? 'global'` fallback is unreachable */
      scope: this.view?.scope ?? 'global',
      title: draft.title,
      content: draft.body,
      tags: draft.tags,
      ...(this.view?.workspaceDir === undefined ? {} : { workspaceDir: this.view.workspaceDir }),
    }
  }

  /** Merge a partial view into a new frozen snapshot and publish it. */
  private with(partial: Partial<MemoryPanelSnapshot>): MemoryPanelSnapshot {
    const settings = this.settings.getSnapshot().value
    return Object.freeze({
      ...this.snapshot,
      ...partial,
      reviewAfterDays: settings?.reviewAfterDays ?? DEFAULT_REVIEW_AFTER_DAYS,
    })
  }

  /** Publish a prepared snapshot to the listeners. */
  private publish(next: MemoryPanelSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
