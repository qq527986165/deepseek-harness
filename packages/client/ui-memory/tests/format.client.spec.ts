/** Pure display helpers: relative time buckets, review age, tag overflow. */
import { describe, expect, it } from 'vitest'
import { needsReview, relativeTime, visibleTags } from '../src/client/panel/format.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('relativeTime', () => {
  it('buckets under a minute as now', () => {
    expect(relativeTime(1_000, 500)).toEqual({ value: 0, unit: 'now' })
  })

  it('clamps a future timestamp to now', () => {
    expect(relativeTime(1_000, 2_000)).toEqual({ value: 0, unit: 'now' })
  })

  it('buckets minutes, hours, and days with floored counts', () => {
    expect(relativeTime(5 * MINUTE + 1, 0)).toEqual({ value: 5, unit: 'minute' })
    expect(relativeTime(3 * HOUR + 1, 0)).toEqual({ value: 3, unit: 'hour' })
    expect(relativeTime(4 * DAY + 1, 0)).toEqual({ value: 4, unit: 'day' })
  })

  it('caps the day count at 999', () => {
    expect(relativeTime(2000 * DAY, 0)).toEqual({ value: 999, unit: 'day' })
  })
})

describe('needsReview', () => {
  it('flags notes at or beyond the threshold only', () => {
    expect(needsReview(10 * DAY, 30, 40 * DAY - 1)).toBe(false)
    expect(needsReview(10 * DAY, 30, 40 * DAY)).toBe(true)
    expect(needsReview(10 * DAY, 30, 40 * DAY + 1)).toBe(true)
  })

  it('flags immediately at a zero-day threshold', () => {
    expect(needsReview(10 * DAY, 0, 10 * DAY)).toBe(true)
  })
})

describe('visibleTags', () => {
  it('returns everything within the budget', () => {
    expect(visibleTags(['a', 'b'])).toEqual({ shown: ['a', 'b'], overflow: 0 })
  })

  it('splits the overflow count beyond three', () => {
    expect(visibleTags(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], overflow: 2 })
  })

  it('honors a custom budget', () => {
    expect(visibleTags(['a', 'b'], 1)).toEqual({ shown: ['a'], overflow: 1 })
  })
})
