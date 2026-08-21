/**
 * Memory lifecycle session-event payloads: the injected-context provenance,
 * the distillation write record, and the review promotion flow that make every
 * memory mutation reconstructable from the session log. Client-safe: only
 * pure types and brand constructors, no host-only symbols.
 * @module @deepseek-ai/dsh-memory-lifecycle/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MemoryNoteId, MemoryScope } from '@deepseek-ai/dsh-memory/types'

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

/** One new topic node committed by a distillation pass. */
export interface MemoryDistillNoteWrite {
  readonly id: string
  readonly scope: MemoryScope
  readonly title: string
  readonly path: string
  /** Exact scope-local journal block anchor this node links back to. */
  readonly journalAnchor: string
  /** The predecessor this new node links to, when the provider found one. */
  readonly previous?: {
    readonly id: string
    readonly title: string
    readonly path: string
  }
}

/** The journal entry one distillation pass appended. */
export interface MemoryDistillJournalWrite {
  readonly scope: MemoryScope
  readonly path: string
  readonly date: string
  readonly title: string
  /** Exact block anchor for this turn's appended journal entry. */
  readonly anchor: string
}

/** Write record payload of the log-only `memory/distill` event. */
export interface MemoryDistillEventData {
  /** The finished turn this pass distilled. */
  readonly turn: number
  /** Every committed topic node, in commit order; non-empty for every receipt. */
  readonly notes: readonly MemoryDistillNoteWrite[]
  /** One journal entry per participating scope. */
  readonly journals: readonly MemoryDistillJournalWrite[]
  /** Exact auxiliary model route that produced the candidates. */
  readonly model: { readonly provider: string; readonly model: string }
}

/** Stable identity of one `/memory-review` proposal. */
export type MemoryReviewId = Branded<'memory-review'>

/**
 * Brand a minted id string as a {@link MemoryReviewId}.
 * @param id - raw minted id.
 * @returns the same string with the memory-review brand.
 */
export function MemoryReviewId(id: string): MemoryReviewId {
  return id as MemoryReviewId
}

/** One project→global upgrade candidate the review pass proposes. */
export interface MemoryReviewCandidate {
  /** The project note proposed for promotion. */
  readonly id: MemoryNoteId
  readonly title: string
  /** First-line excerpt of the note, for the candidate card. */
  readonly snippet: string
  /** The model's justification for promoting this note. */
  readonly reason: string
}

/** Proposal payload of the log-only `memory/review` event. */
export interface MemoryReviewEventData {
  /** Stable identity every later decision addresses. */
  readonly reviewId: MemoryReviewId
  /** The bounded candidate set; empty when nothing was proposed. */
  readonly candidates: readonly MemoryReviewCandidate[]
  /** The registered workspace whose project vault the candidates came from. */
  readonly workspaceDir: string
}

/** One accepted promotion: the project note and the global note that replaced it. */
export interface MemoryReviewDecidedAccepted {
  /** The promoted project note id. */
  readonly id: MemoryNoteId
  readonly title: string
  /** The global note id the content was written to. */
  readonly globalId: MemoryNoteId
}

/** Settlement payload of the log-only `memory/review-decided` event. */
export interface MemoryReviewDecidedEventData {
  /** The review this settlement answers. */
  readonly reviewId: MemoryReviewId
  /** Every promoted note, in promotion order. */
  readonly accepted: readonly MemoryReviewDecidedAccepted[]
  /** Every rejected candidate id. */
  readonly rejected: readonly MemoryNoteId[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Provenance of one memory context injection: the persona notes in full
     * plus the note-catalog entries whose text entered the injected context.
     * The injected text itself is logged as the matching `user/message`; this
     * log-only event records which files were loaded and why, so the injected
     * set reconstructs from the log.
     */
    'memory/inject': MemoryInjectEventData
    /**
     * Every write one distillation pass committed, plus its journal append and
     * auxiliary route. Log-only: together with the pass's `turn/end` and the
     * vault files it names, the log reconstructs every silent memory mutation.
     */
    'memory/distill': MemoryDistillEventData
    /**
     * One `/memory-review` proposal: the bounded project→global upgrade
     * candidate set one auxiliary call produced. Log-only; the conversation
     * node renders candidate cards from this event and settles through
     * `memory/review-decided`.
     */
    'memory/review': MemoryReviewEventData
    /**
     * The user's decision on one review: every promoted note with its global
     * replacement, and every rejected id. Appended by the `memoryReview.decide`
     * remote after the promotion commits.
     */
    'memory/review-decided': MemoryReviewDecidedEventData
  }
}
