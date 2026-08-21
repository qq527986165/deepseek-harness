/**
 * Wire vocabulary of the memory Remote namespaces: session-independent panel
 * operations and the session-addressed review decision. Pure types only —
 * client programs import exactly this subpath.
 * @module @deepseek-ai/dsh-memory-remote/types
 */

import type { MemoryNoteId, MemoryScope } from '@deepseek-ai/dsh-memory/types'
import type { MemoryReviewDecidedEventData, MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'

export type {
  MemoryDeleteResult,
  MemoryInfo,
  MemoryLinkTarget,
  MemoryListResult,
  MemoryListedNote,
  MemoryNote,
  MemoryNoteId,
  MemoryScope,
  MemorySearchHit,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory/types'
export type { MemoryReviewDecidedEventData, MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'

/** `memory.list` request: one vault, addressed by scope and optional workspace directory. */
export interface MemoryRemoteListRequest {
  readonly scope: MemoryScope
  /** Registered workspace directory; required to reach the project vault. */
  readonly workspaceDir?: string
  readonly limit?: number
}

/** `memory.read` request: one note within exactly one vault. */
export interface MemoryRemoteReadRequest {
  readonly ref: string
  readonly scope: MemoryScope
  /** Registered workspace directory; required to reach the project vault. */
  readonly workspaceDir?: string
}

/** `memory.search` request: full-text search within exactly one vault. */
export interface MemoryRemoteSearchRequest {
  readonly query: string
  readonly scope: MemoryScope
  /** Registered workspace directory; required to reach the project vault. */
  readonly workspaceDir?: string
  readonly limit?: number
}

/** `memory.write` request: create or replace one note. */
export interface MemoryRemoteWriteRequest {
  /** Present to replace that exact note, absent to create. */
  readonly id?: MemoryNoteId
  readonly scope: MemoryScope
  readonly title: string
  readonly content: string
  readonly tags?: readonly string[]
  readonly related?: readonly string[]
  /** Registered workspace directory; required to reach the project vault. */
  readonly workspaceDir?: string
}

/** `memory.delete` request: soft-delete one note, resolved by id or exact title. */
export interface MemoryRemoteDeleteRequest {
  readonly ref: string
  /** Vault to resolve within; absent resolves across both scopes, project first. */
  readonly scope?: MemoryScope
  /** Registered workspace directory; required to reach the project vault. */
  readonly workspaceDir?: string
}

/** One review decision: every candidate id lands in exactly one of the two sets. */
export interface MemoryReviewDecisions {
  readonly accepted: readonly MemoryNoteId[]
  readonly rejected: readonly MemoryNoteId[]
}

/** Business failure of `memoryReview.decide`, keyed by stable code. */
export type MemoryReviewDecideFailure =
  | { readonly code: 'review-not-found'; readonly reviewId: MemoryReviewId }
  | { readonly code: 'review-decided'; readonly reviewId: MemoryReviewId }
  | { readonly code: 'unknown-candidate'; readonly reviewId: MemoryReviewId; readonly id: MemoryNoteId }
  | { readonly code: 'duplicate-candidate'; readonly reviewId: MemoryReviewId; readonly id: MemoryNoteId }
  | { readonly code: 'undecided-candidates'; readonly reviewId: MemoryReviewId; readonly ids: readonly MemoryNoteId[] }
  | { readonly code: 'note-missing'; readonly reviewId: MemoryReviewId; readonly id: MemoryNoteId }

/** Settled decision: the appended settlement payload or an explicit failure. */
export type MemoryReviewDecideResult =
  | { readonly ok: true; readonly value: MemoryReviewDecidedEventData }
  | { readonly ok: false; readonly error: MemoryReviewDecideFailure }
