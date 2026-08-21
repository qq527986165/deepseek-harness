/** Reproduction: the mounted memory Remote namespace service exposes its methods. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { apply as gatewayApply, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import { apply as remotesApply, inject as remotesInject } from '@deepseek-ai/dsh-api-remotes/client'

describe('memory Remote namespace service', () => {
  it('installs the memory methods through the real client assembly', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('connection', { rpc: { call: () => Promise.reject(new Error('unexpected rpc')) } } as unknown as ConnectionHandle)
    await ctx.plugin({ inject: gatewayInject, apply: gatewayApply })
    await ctx.plugin({ inject: remotesInject, apply: remotesApply })
    const namespace = ctx.get('remote.memory') as Record<string, unknown>
    for (const method of ['info', 'list', 'read', 'search', 'write', 'delete']) {
      expect(typeof namespace[method], method).toBe('function')
    }
  })
})
