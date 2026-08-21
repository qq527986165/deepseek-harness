/**
 * Pure display helpers for the memory panel: relative-time bucketing, the
 * review-age badge, and the at-most-three tag overflow. All pure functions of
 * their arguments — unit-testable without render machinery.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Relative-time bucket unit; `now` renders a bare word, the rest a count. */
export type RelativeTimeUnit = 'now' | 'minute' | 'hour' | 'day'

/** One bucketed relative age for the `time.<unit>` dictionary template. */
export interface RelativeTime {
  /** Count for unit-bearing templates; 0 for `now`. */
  readonly value: number
  readonly unit: RelativeTimeUnit
}

/**
 * Bucket an update timestamp into a relative-time unit against now.
 * @param nowMs - current epoch milliseconds.
 * @param updatedMs - note update epoch milliseconds.
 * @returns the bucket; the day unit caps at 999 so the template stays short.
 */
export function relativeTime(nowMs: number, updatedMs: number): RelativeTime {
  const elapsed = Math.max(0, nowMs - updatedMs)
  if (elapsed < MINUTE_MS) return { value: 0, unit: 'now' }
  if (elapsed < HOUR_MS) return { value: Math.floor(elapsed / MINUTE_MS), unit: 'minute' }
  if (elapsed < DAY_MS) return { value: Math.floor(elapsed / HOUR_MS), unit: 'hour' }
  return { value: Math.min(999, Math.floor(elapsed / DAY_MS)), unit: 'day' }
}

/**
 * Whether a note's update age exceeds the review threshold.
 * @param updatedMs - note update epoch milliseconds.
 * @param reviewAfterDays - threshold in days.
 * @param nowMs - current epoch milliseconds.
 * @returns true when the note is due for a review badge.
 */
export function needsReview(updatedMs: number, reviewAfterDays: number, nowMs: number): boolean {
  return nowMs - updatedMs >= reviewAfterDays * DAY_MS
}

/** Tag overflow split: at most `max` badges plus an `+N` count. */
export interface TagOverflow {
  readonly shown: readonly string[]
  readonly overflow: number
}

/**
 * Split one note's tags into the badge set and the overflow count.
 * @param tags - note tags in display order.
 * @param max - badge budget; defaults to 3.
 * @returns at most `max` shown tags plus the remainder count.
 */
export function visibleTags(tags: readonly string[], max = 3): TagOverflow {
  if (tags.length <= max) return { shown: tags, overflow: 0 }
  return { shown: tags.slice(0, max), overflow: tags.length - max }
}
