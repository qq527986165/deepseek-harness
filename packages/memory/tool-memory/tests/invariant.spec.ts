import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '@deepseek-ai/dsh-tool-memory/invariant'

describe('tool-memory invariant companion', () => {
  it('registers the package invariant and returns its disposer', async () => {
    const disposer = vi.fn(() => {})
    const register = vi.fn(() => disposer)
    const ctx = new Context()
    ctx.provide('invariants', { register })
    const installed = await apply(ctx)
    expect(name).toBe('tool-memory-invariant')
    expect(inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-tool-memory', expect.any(Function))
    installed()
    expect(disposer).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
