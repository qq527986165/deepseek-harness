import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

describe('memory-lifecycle config', () => {
  it('resolves defaults for every field', () => {
    const hostTimeZone = new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone
    expect(resolveConfig()).toEqual({
      distill: true,
      distillMode: 'concise',
      minTurnChars: 40,
      maxDistillTokens: 2048,
      distillTimeoutMs: 30_000,
      timeZone: hostTimeZone,
      maxInjectBytes: 16_384,
      maxReviewCandidates: 5,
      reviewAfterDays: 30,
    })
    expect(resolveConfig(undefined as never)).toEqual(resolveConfig())
    expect(Config).toBeTruthy()
  })

  it('keeps explicit values and the explicit auxiliary route pair', () => {
    expect(resolveConfig({
      distill: false,
      distillMode: 'detailed',
      minTurnChars: 5,
      maxDistillTokens: 512,
      distillTimeoutMs: 1000,
      provider: 'deepseek',
      model: 'aux-model',
      timeZone: 'Asia/Shanghai',
      maxInjectBytes: 100,
      maxReviewCandidates: 2,
      reviewAfterDays: 7,
    })).toEqual({
      distill: false,
      distillMode: 'detailed',
      minTurnChars: 5,
      maxDistillTokens: 512,
      distillTimeoutMs: 1000,
      provider: 'deepseek',
      model: 'aux-model',
      timeZone: 'Asia/Shanghai',
      maxInjectBytes: 100,
      maxReviewCandidates: 2,
      reviewAfterDays: 7,
    })
  })

  it('rejects non-positive integer limits and an unknown distill mode', () => {
    expect(() => resolveConfig({ minTurnChars: 0 })).toThrow('minTurnChars must be a positive integer')
    expect(() => resolveConfig({ maxDistillTokens: 1.5 })).toThrow('maxDistillTokens must be a positive integer')
    expect(() => resolveConfig({ distillTimeoutMs: -1 })).toThrow('distillTimeoutMs must be a positive integer')
    expect(() => resolveConfig({ maxInjectBytes: 0 })).toThrow('maxInjectBytes must be a positive integer')
    expect(() => resolveConfig({ maxReviewCandidates: Number.NaN })).toThrow('maxReviewCandidates must be a positive integer')
    expect(() => resolveConfig({ reviewAfterDays: 0 })).toThrow('reviewAfterDays must be a positive integer')
    expect(() => resolveConfig({ distillMode: 'verbose' as never })).toThrow('distillMode must be "concise" or "detailed"')
  })

  it('rejects an over-long timeout and a half-supplied route', () => {
    expect(() => resolveConfig({ distillTimeoutMs: 2_147_483_648 })).toThrow('distillTimeoutMs must not exceed')
    expect(() => resolveConfig({ provider: 'deepseek' })).toThrow('provider and model must be supplied together')
    expect(() => resolveConfig({ model: 'm' })).toThrow('provider and model must be supplied together')
    expect(() => resolveConfig({ provider: '', model: 'm' })).toThrow('non-empty strings')
    expect(() => resolveConfig({ provider: 'p', model: '' })).toThrow('non-empty strings')
    expect(() => resolveConfig({ timeZone: 'Mars/Olympus' })).toThrow('invalid IANA timeZone')
  })
})
