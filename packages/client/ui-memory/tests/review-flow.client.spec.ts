/** The review decision-flow helpers: staging completeness, the decide partition, and failure keys. */
import { describe, expect, it } from 'vitest'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory/types'
import { MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { MemoryReviewCandidate } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { MemoryReviewDecideFailure } from '@deepseek-ai/dsh-memory-remote/types'
import { failureKeyOf, stagedPartition, stagingComplete } from '../src/client/review/review-flow.ts'

const REVIEW = MemoryReviewId('r1')

function candidate(id: string, title: string): MemoryReviewCandidate {
  return { id: MemoryNoteId(id), title, snippet: `${title} snippet`, reason: `${title} reason` }
}

describe('stagingComplete', () => {
  it('is true only once every candidate carries a staged decision', () => {
    const candidates = [candidate('a', 'A'), candidate('b', 'B')]
    expect(stagingComplete(candidates, new Map())).toBe(false)
    expect(stagingComplete(candidates, new Map([['a', true]]))).toBe(false)
    expect(stagingComplete(candidates, new Map([['a', true], ['b', false]]))).toBe(true)
  })

  it('is vacuously true for an empty candidate set', () => {
    expect(stagingComplete([], new Map())).toBe(true)
  })
})

describe('stagedPartition', () => {
  it('returns null until every candidate is decided', () => {
    const candidates = [candidate('a', 'A'), candidate('b', 'B')]
    expect(stagedPartition(candidates, new Map([['a', true]]))).toBeNull()
  })

  it('projects the exact accept/reject partition in proposal order', () => {
    const candidates = [candidate('a', 'A'), candidate('b', 'B'), candidate('c', 'C')]
    expect(stagedPartition(candidates, new Map([['a', true], ['b', false], ['c', true]]))).toEqual({
      accepted: [MemoryNoteId('a'), MemoryNoteId('c')],
      rejected: [MemoryNoteId('b')],
    })
  })

  it('accepts every candidate when the staging is all-true', () => {
    const candidates = [candidate('a', 'A'), candidate('b', 'B')]
    expect(stagedPartition(candidates, new Map([['a', true], ['b', true]]))).toEqual({
      accepted: [MemoryNoteId('a'), MemoryNoteId('b')],
      rejected: [],
    })
  })

  it('partitions an empty candidate set as two empty lists', () => {
    expect(stagedPartition([], new Map())).toEqual({ accepted: [], rejected: [] })
  })
})

describe('failureKeyOf', () => {
  it('maps every decide business failure code to its locale key', () => {
    const cases: ReadonlyArray<[MemoryReviewDecideFailure, string]> = [
      [{ code: 'review-not-found', reviewId: REVIEW }, 'review.fail.notFound'],
      [{ code: 'review-decided', reviewId: REVIEW }, 'review.fail.decided'],
      [{ code: 'unknown-candidate', reviewId: REVIEW, id: MemoryNoteId('a') }, 'review.fail.unknownCandidate'],
      [{ code: 'duplicate-candidate', reviewId: REVIEW, id: MemoryNoteId('a') }, 'review.fail.duplicateCandidate'],
      [{ code: 'undecided-candidates', reviewId: REVIEW, ids: [MemoryNoteId('a')] }, 'review.fail.undecided'],
      [{ code: 'note-missing', reviewId: REVIEW, id: MemoryNoteId('a') }, 'review.fail.noteMissing'],
    ]
    for (const [failure, key] of cases) {
      expect(failureKeyOf(failure)).toBe(key)
    }
  })
})
