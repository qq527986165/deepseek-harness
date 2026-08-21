import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '@deepseek-ai/dsh-memory-local/invariant'

describe('memory-local invariant companion', () => {
  it('registers the package invariant and returns its disposer', async () => {
    const disposer = vi.fn(() => {})
    const register = vi.fn(() => disposer)
    const ctx = new Context()
    ctx.provide('invariants', { register })
    const installed = await apply(ctx)
    expect(name).toBe('memory-local-invariant')
    expect(inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-memory-local', expect.any(Function))
    installed()
    expect(disposer).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
