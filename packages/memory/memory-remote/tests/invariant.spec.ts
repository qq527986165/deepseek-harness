import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

describe('memory-remote invariant companion', () => {
  it('declares its identity and registers the package invariant', async () => {
    const disposer = vi.fn(() => {})
    const register = vi.fn(() => disposer)
    const ctx = new Context()
    ctx.provide('invariants', { register })
    const installed = await apply(ctx)
    expect(name).toBe('memory-remote-invariant')
    expect(inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-memory-remote', expect.any(Function))
    installed()
    expect(disposer).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
