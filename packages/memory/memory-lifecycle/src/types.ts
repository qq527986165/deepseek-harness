/**
 * Memory lifecycle session-event payloads: the injected-context provenance and
 * the distillation write record that make every Phase 2 memory mutation
 * reconstructable from the session log.
 * @module @deepseek-ai/dsh-memory-lifecycle/types
 */

import type { MemoryScope } from '@deepseek-ai/dsh-memory'

/** Why one memory context was injected into an agent. */
export type MemoryInjectReason = 'start' | 'change'

/** One memory file whose content entered the injected context. */
export interface MemoryInjectRef {
  /** Vault scope the file came from. */
  readonly scope: MemoryScope
  /** Absolute vault directory. */
  readonly dir: string
  /** File path relative to the vault root. */
  readonly path: string
  /** Topic-note title; absent for persona notes. */
  readonly title?: string
}

/** Provenance payload of the log-only `memory/inject` event. */
export interface MemoryInjectEventData {
  /** `start` for the session-start load, `change` for a watcher-driven reload. */
  readonly reason: MemoryInjectReason
  /** Exactly the files whose content entered the injected text. */
  readonly notes: readonly MemoryInjectRef[]
  /** UTF-8 byte length of the complete injected text. */
  readonly bytes: number
}

/** What one committed topic-note write did. */
export type MemoryDistillNoteAction = 'create' | 'merge'

/** One topic-note write committed by a distillation pass. */
export interface MemoryDistillNoteWrite {
  readonly id: string
  readonly scope: MemoryScope
  readonly title: string
  readonly path: string
  readonly action: MemoryDistillNoteAction
}

/** The journal entry one distillation pass appended. */
export interface MemoryDistillJournalWrite {
  readonly scope: MemoryScope
  readonly path: string
  readonly date: string
  readonly title: string
}

/** Write record payload of the log-only `memory/distill` event. */
export interface MemoryDistillEventData {
  /** The finished turn this pass distilled. */
  readonly turn: number
  /** Every committed topic-note write, in commit order; empty when none landed. */
  readonly notes: readonly MemoryDistillNoteWrite[]
  /** The appended journal entry; absent when the pass failed before appending. */
  readonly journal?: MemoryDistillJournalWrite
  /** Exact auxiliary model route that produced the candidates. */
  readonly model: { readonly provider: string; readonly model: string }
  /** Present when the pass failed after committing at least one write. */
  readonly error?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Provenance of one memory context injection. The injected text itself is
     * logged as the matching `user/message`; this log-only event records which
     * files were loaded and why, so the injected set reconstructs from the log.
     */
    'memory/inject': MemoryInjectEventData
    /**
     * Every write one distillation pass committed, plus its journal append and
     * auxiliary route. Log-only: together with the pass's `turn/end` and the
     * vault files it names, the log reconstructs every silent memory mutation.
     */
    'memory/distill': MemoryDistillEventData
  }
}
