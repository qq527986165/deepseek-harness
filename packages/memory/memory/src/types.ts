/**
 * Memory capability types: scopes, note identity, and the provider/result
 * vocabulary the service, storage provider, and model tools share.
 * @module @deepseek-ai/dsh-memory/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** A memory vault scope: `project` follows the session's workspace, `global` lives under the harness home. */
export type MemoryScope = 'project' | 'global'

/** Stable identity of one memory note, minted by the storage provider at creation. */
export type MemoryNoteId = Branded<'memory-note'>

/**
 * Brand a provider-minted id string as a {@link MemoryNoteId}.
 * @param id - raw provider-issued id.
 * @returns the same string with the memory-note brand.
 */
export function MemoryNoteId(id: string): MemoryNoteId {
  return id as MemoryNoteId
}

/** Link kinds the index records: body `[[wikilinks]]` and frontmatter `related` entries. */
export type MemoryLinkKind = 'wikilink' | 'related'

/** One link endpoint: the exact note title a link names, plus the target id when it resolves. */
export interface MemoryLinkTarget {
  /** Exact note title named by the link. */
  readonly title: string
  /** Target id when the title resolves within the same vault; absent means dangling. */
  readonly id?: MemoryNoteId
}

/** A full memory note as read back from storage. */
export interface MemoryNote {
  readonly id: MemoryNoteId
  readonly scope: MemoryScope
  readonly title: string
  /** Note path relative to its vault root, for humans and Obsidian. */
  readonly path: string
  readonly tags: readonly string[]
  readonly body: string
  readonly related: readonly MemoryLinkTarget[]
  readonly backlinks: readonly MemoryLinkTarget[]
}

/** Create or replace one note: `id` present replaces that note, absent creates a new one. */
export interface MemoryWriteInput {
  readonly id?: MemoryNoteId
  readonly scope: MemoryScope
  readonly title: string
  readonly content: string
  readonly tags?: readonly string[]
  readonly related?: readonly string[]
}

/** Result of one committed write. */
export interface MemoryWriteResult {
  readonly id: MemoryNoteId
  readonly scope: MemoryScope
  readonly title: string
  /** Note path relative to its vault root. */
  readonly path: string
  readonly created: string
  readonly updated: string
}

/** Search options; every bound is enforced provider-side, never raised by a caller. */
export interface MemorySearchOptions {
  readonly limit?: number
}

/** One ranked full-text hit. */
export interface MemorySearchHit {
  readonly id: MemoryNoteId
  readonly scope: MemoryScope
  readonly title: string
  readonly snippet: string
  readonly tags: readonly string[]
}

/** Traversal options. */
export interface MemoryTraverseOptions {
  readonly depth?: 1 | 2
  readonly kinds?: readonly MemoryLinkKind[]
}

/** One adjacency edge from the start note; `id` absent marks a dangling link. */
export interface MemoryTraversalNode {
  readonly id?: MemoryNoteId
  readonly title: string
  readonly via: { readonly kind: MemoryLinkKind; readonly direction: 'out' | 'in' }
}

/** Bounded adjacency result around one note. */
export interface MemoryTraversal {
  readonly start: { readonly id: MemoryNoteId; readonly title: string }
  readonly nodes: readonly MemoryTraversalNode[]
  /** True when the provider's node cap cut the adjacency short. */
  readonly truncated: boolean
}

/** One vault's persona note (`MEMORY.md`) read whole for session-start injection. */
export interface MemoryPersona {
  /** Absolute vault directory the note came from. */
  readonly dir: string
  /** Note path relative to the vault root; always `MEMORY.md`. */
  readonly path: string
  /** Raw markdown text of the persona note. */
  readonly text: string
}

/** One topic note in the recency window, without link resolution. */
export interface MemoryRecentNote {
  /** Note path relative to its vault root, always under `notes/`. */
  readonly path: string
  readonly title: string
  readonly body: string
  /** Index timestamp in epoch milliseconds of the latest indexed update. */
  readonly updated: number
}

/** Recency-window options. */
export interface MemoryRecentOptions {
  /** Maximum topic notes to return, most recently updated first. */
  readonly limit?: number
}

/** Appending journal entry input: the service routes it by `scope` like a write. */
export interface MemoryJournalAppendInput {
  /** Which vault's `journal/` file the entry appends to. */
  readonly scope: MemoryScope
  /** Target journal day, `YYYY-MM-DD` in UTC; defaults to today (UTC). */
  readonly date?: string
  /** Entry heading: the short task narrative title. */
  readonly title: string
  /** Entry body in markdown, usually `-` bullets that may carry `[[wikilinks]]`. */
  readonly body: string
}

/** One committed journal append. */
export interface MemoryJournalAppendResult {
  /** Absolute vault directory the journal file lives in. */
  readonly dir: string
  /** Journal file path relative to the vault root, e.g. `journal/2026-08-18.md`. */
  readonly path: string
  /** The entry's journal day, `YYYY-MM-DD` in UTC. */
  readonly date: string
}

/**
 * Storage-and-index provider bound through {@link MemoryService.register}.
 * Vault directories are explicit arguments: the service owns scope resolution,
 * the provider owns file layout and indexing within each directory. Read walks
 * the directory chain in order, first hit wins per entry.
 */
export interface MemoryProvider {
  /** Create or replace one note inside the target vault directory. */
  write(input: MemoryWriteInput, dir: string, signal?: AbortSignal): Promise<MemoryWriteResult>
  /** Resolve a note by id or exact title across the vault chain, project first. */
  read(ref: string, dirs: readonly string[], signal?: AbortSignal): Promise<MemoryNote>
  /** Ranked full-text hits across the vault chain, project hits first. */
  search(query: string, opts: MemorySearchOptions | undefined, dirs: readonly string[], signal?: AbortSignal): Promise<MemorySearchHit[]>
  /** Bounded link adjacency around one note, within the note's own vault. */
  traverse(ref: string, opts: MemoryTraverseOptions | undefined, dirs: readonly string[], signal?: AbortSignal): Promise<MemoryTraversal>
  /** Read one vault's persona note whole, or `undefined` when the vault has none. */
  readPersona(dir: string, signal?: AbortSignal): Promise<{ path: string; text: string } | undefined>
  /** Topic notes under `notes/`, most recently updated first, capped by `limit`. */
  recentNotes(opts: MemoryRecentOptions | undefined, dir: string, signal?: AbortSignal): Promise<MemoryRecentNote[]>
  /** Append one entry to a day's journal file on the vault's exclusive chain. */
  appendJournal(input: MemoryJournalAppendInput, dir: string, signal?: AbortSignal): Promise<{ path: string; date: string }>
}
