import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

describe('memory-lifecycle config', () => {
  it('resolves defaults for every field', () => {
    expect(resolveConfig()).toEqual({
      distill: true,
      minTurnChars: 40,
      maxDistillTokens: 1024,
      distillTimeoutMs: 30_000,
      maxInjectBytes: 16_384,
      recentNoteCount: 10,
    })
    expect(resolveConfig(undefined as never)).toEqual(resolveConfig())
    expect(Config).toBeTruthy()
  })

  it('keeps explicit values and the explicit auxiliary route pair', () => {
    expect(resolveConfig({
      distill: false,
      minTurnChars: 5,
      maxDistillTokens: 512,
      distillTimeoutMs: 1000,
      provider: 'deepseek',
      model: 'aux-model',
      maxInjectBytes: 100,
      recentNoteCount: 3,
    })).toEqual({
      distill: false,
      minTurnChars: 5,
      maxDistillTokens: 512,
      distillTimeoutMs: 1000,
      provider: 'deepseek',
      model: 'aux-model',
      maxInjectBytes: 100,
      recentNoteCount: 3,
    })
  })

  it('rejects non-positive integer limits', () => {
    expect(() => resolveConfig({ minTurnChars: 0 })).toThrow('minTurnChars must be a positive integer')
    expect(() => resolveConfig({ maxDistillTokens: 1.5 })).toThrow('maxDistillTokens must be a positive integer')
    expect(() => resolveConfig({ distillTimeoutMs: -1 })).toThrow('distillTimeoutMs must be a positive integer')
    expect(() => resolveConfig({ maxInjectBytes: 0 })).toThrow('maxInjectBytes must be a positive integer')
    expect(() => resolveConfig({ recentNoteCount: Number.NaN })).toThrow('recentNoteCount must be a positive integer')
  })

  it('rejects an over-long timeout and a half-supplied route', () => {
    expect(() => resolveConfig({ distillTimeoutMs: 2_147_483_648 })).toThrow('distillTimeoutMs must not exceed')
    expect(() => resolveConfig({ provider: 'deepseek' })).toThrow('provider and model must be supplied together')
    expect(() => resolveConfig({ model: 'm' })).toThrow('provider and model must be supplied together')
    expect(() => resolveConfig({ provider: '', model: 'm' })).toThrow('non-empty strings')
    expect(() => resolveConfig({ provider: 'p', model: '' })).toThrow('non-empty strings')
  })
})
