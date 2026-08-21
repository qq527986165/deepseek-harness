/** The ui-memory invariant companion registers the package's empty installer. */
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '@deepseek-ai/dsh-client-ui-memory/invariant'
import { apply as nodeApply } from '../src/index.ts'

describe('ui-memory invariant companion', () => {
  it('declares its companion name and service edge', () => {
    expect(name).toBe('client-ui-memory-invariant')
    expect(inject).toEqual(['invariants'])
  })

  it('registers a no-op installer for the package', async () => {
    const register = vi.fn()
    const ctx = {
      invariants: { register },
    }
    await apply(ctx as never)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-memory', expect.any(Function))
  })

  it('the node-half apply is a no-op host placeholder', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
