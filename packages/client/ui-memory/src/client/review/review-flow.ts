/**
 * Pure decision-flow helpers for the review node: the per-candidate staging
 * projection onto the decide partition, completeness, and the business-failure
 * message mapping. React-free; the component holds no partition logic beyond
 * calling these.
 * @module @deepseek-ai/dsh-client-ui-memory/client/review/review-flow
 */
import type { MemoryNoteId } from '@deepseek-ai/dsh-memory/types'
import type { MemoryReviewCandidate } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { MemoryReviewDecideFailure, MemoryReviewDecisions } from '@deepseek-ai/dsh-memory-remote/types'

/** Per-candidate staging: candidate id → accepted (true) or rejected (false). */
export type ReviewStaging = ReadonlyMap<string, boolean>

/**
 * Whether every candidate carries a staged decision.
 * @param candidates - the review's candidate set.
 * @param staging - per-candidate accept/reject decisions.
 * @returns true when no candidate remains undecided.
 */
export function stagingComplete(
  candidates: readonly MemoryReviewCandidate[],
  staging: ReviewStaging,
): boolean {
  return candidates.every(candidate => staging.has(String(candidate.id)))
}

/**
 * Project the staging onto the decide partition; null while incomplete.
 * @param candidates - the review's candidate set, in proposal order.
 * @param staging - per-candidate accept/reject decisions.
 * @returns the exact partition, or null until every candidate is decided.
 */
export function stagedPartition(
  candidates: readonly MemoryReviewCandidate[],
  staging: ReviewStaging,
): MemoryReviewDecisions | null {
  if (!stagingComplete(candidates, staging)) return null
  const accepted: MemoryNoteId[] = []
  const rejected: MemoryNoteId[] = []
  for (const candidate of candidates) {
    (staging.get(String(candidate.id)) === true ? accepted : rejected).push(candidate.id)
  }
  return { accepted, rejected }
}

/** The locale key naming one decide business failure. */
export type ReviewFailureKey =
  | 'review.fail.notFound'
  | 'review.fail.decided'
  | 'review.fail.unknownCandidate'
  | 'review.fail.duplicateCandidate'
  | 'review.fail.undecided'
  | 'review.fail.noteMissing'

/**
 * Map one decide business failure onto its locale key.
 * @param failure - the settlement failure the remote answered.
 * @returns the locale key naming that failure for the user.
 */
export function failureKeyOf(failure: MemoryReviewDecideFailure): ReviewFailureKey {
  switch (failure.code) {
    case 'review-not-found': return 'review.fail.notFound'
    case 'review-decided': return 'review.fail.decided'
    case 'unknown-candidate': return 'review.fail.unknownCandidate'
    case 'duplicate-candidate': return 'review.fail.duplicateCandidate'
    case 'undecided-candidates': return 'review.fail.undecided'
    case 'note-missing': return 'review.fail.noteMissing'
    /* v8 ignore next -- MemoryReviewDecideFailure is closed and every code is handled above. */
    default: return failure satisfies never
  }
}
