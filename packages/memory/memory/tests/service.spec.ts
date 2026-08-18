import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import MemoryService, { MemoryError, MemoryNoteId, PROJECT_MEMORY_DIR } from '@deepseek-ai/dsh-memory'
import type { MemoryNote, MemoryProvider, MemoryTraversal, MemoryWriteResult } from '@deepseek-ai/dsh-memory'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = tmpdir()

interface FakeRegistry {
  resolveByPath: ReturnType<typeof vi.fn>
}

function fakeRegistry(resolves: boolean): FakeRegistry {
  return { resolveByPath: vi.fn((path: string) => resolves
    ? Promise.resolve({ path })
    : Promise.reject(new Error(`no workspace for ${path}`))) }
}

function selectiveRegistry(registered: string): FakeRegistry {
  return { resolveByPath: vi.fn((path: string) => path === registered
    ? Promise.resolve({ path })
    : Promise.reject(new Error(`no workspace for ${path}`))) }
}

type ProviderSpies = Pick<MemoryProvider, 'write' | 'read' | 'search' | 'traverse'>

function fakeProvider(overrides: Partial<MemoryProvider> = {}): ProviderSpies & { provider: MemoryProvider } {
  const note: MemoryNote = {
    id: MemoryNoteId('n1'),
    scope: 'global',
    title: 'A note',
    path: 'notes/a-note.md',
    tags: [],
    body: 'body',
    related: [],
    backlinks: [],
  }
  const result: MemoryWriteResult = {
    id: MemoryNoteId('n1'),
    scope: 'global',
    title: 'A note',
    path: 'notes/a-note.md',
    created: 't0',
    updated: 't0',
  }
  const traversal: MemoryTraversal = { start: { id: MemoryNoteId('n1'), title: 'A note' }, nodes: [], truncated: false }
  const write = overrides.write ?? vi.fn(async () => result)
  const read = overrides.read ?? vi.fn(async () => note)
  const search = overrides.search ?? vi.fn(async () => [])
  const traverse = overrides.traverse ?? vi.fn(async () => traversal)
  return { provider: { write, read, search, traverse }, write, read, search, traverse }
}

async function mounted(config: Parameters<typeof MemoryService.prototype.constructor>[1] = { dshHome: HOME }) {
  const ctx = new Context()
  await ctx.plugin(MemoryService, config)
  return ctx
}

describe('MemoryService', () => {
  it('delegates every operation to the sole registered provider', async () => {
    const ctx = await mounted()
    const { provider, write, read, search, traverse } = fakeProvider()
    ctx.memory.register(provider)
    const signal = new AbortController().signal

    const written = await ctx.memory.write({ scope: 'global', title: 'A note', content: 'body' }, undefined, signal)
    expect(written.id).toBe('n1')
    expect(write).toHaveBeenCalledWith({ scope: 'global', title: 'A note', content: 'body' }, join(HOME, 'memory'), signal)

    await ctx.memory.read('n1', undefined, signal)
    expect(read).toHaveBeenCalledWith('n1', [join(HOME, 'memory')], signal)

    await ctx.memory.search('body', { limit: 3 }, undefined, signal)
    expect(search).toHaveBeenCalledWith('body', { limit: 3 }, [join(HOME, 'memory')], signal)

    await ctx.memory.traverse('n1', { depth: 2 }, undefined, signal)
    expect(traverse).toHaveBeenCalledWith('n1', { depth: 2 }, [join(HOME, 'memory')], signal)
    await ctx.fiber.dispose()
  })

  it('fails every operation loudly without a registered provider', async () => {
    const ctx = await mounted()
    await expect(ctx.memory.write({ scope: 'global', title: 't', content: 'c' }, undefined)).rejects.toThrow('no memory provider is registered')
    await expect(ctx.memory.read('n1', undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(ctx.memory.search('q', undefined, undefined)).rejects.toBeInstanceOf(MemoryError)
    await expect(ctx.memory.traverse('n1', undefined, undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await ctx.fiber.dispose()
  })

  it('rejects a second registration and rejects a malformed provider', async () => {
    const ctx = await mounted()
    ctx.memory.register(fakeProvider().provider)
    expect(() => ctx.memory.register(fakeProvider().provider)).toThrow('a memory provider is already registered')
    expect(() => ctx.memory.register({} as never)).toThrow('memory provider must implement write()')
    expect(() => ctx.memory.register('provider' as never)).toThrow('memory provider must be an object')
    expect(() => ctx.memory.register({ write: () => {} } as never)).toThrow('memory provider must implement read()')
    await ctx.fiber.dispose()
  })

  it('resolves a session without cwd to the global scope only', async () => {
    const ctx = await mounted()
    await expect(ctx.memory.resolveScopes(undefined)).resolves.toEqual(['global'])
    const { provider, read } = fakeProvider()
    ctx.memory.register(provider)
    await ctx.memory.read('n1', undefined)
    expect(read).toHaveBeenCalledWith('n1', [join(HOME, 'memory')], undefined)
    await ctx.fiber.dispose()
  })

  it('resolves a registered workspace cwd to the project + global chain, project first', async () => {
    const ctx = await mounted()
    ctx.provide('workspaceRegistry', fakeRegistry(true))
    const cwd = join(HOME, 'work', 'proj')
    await expect(ctx.memory.resolveScopes(cwd)).resolves.toEqual(['project', 'global'])
    const { provider, read } = fakeProvider()
    ctx.memory.register(provider)
    await ctx.memory.read('n1', cwd)
    expect(read).toHaveBeenCalledWith('n1', [join(cwd, PROJECT_MEMORY_DIR), join(HOME, 'memory')], undefined)
    await ctx.fiber.dispose()
  })

  it('falls back to global-only for an unregistered cwd and a registry fault', async () => {
    const cwd = join(HOME, 'unregistered')

    const unregistered = await mounted()
    unregistered.provide('workspaceRegistry', fakeRegistry(false))
    await expect(unregistered.memory.resolveScopes(cwd)).resolves.toEqual(['global'])
    await unregistered.fiber.dispose()

    const faulty = await mounted()
    faulty.provide('workspaceRegistry', { resolveByPath: vi.fn(async () => { throw new Error('fault') }) })
    await expect(faulty.memory.resolveScopes(cwd)).resolves.toEqual(['global'])
    await faulty.fiber.dispose()
  })

  it('falls back to global-only when no workspace registry is composed', async () => {
    const bare = await mounted()
    await expect(bare.memory.resolveScopes(join(HOME, 'anywhere'))).resolves.toEqual(['global'])
    await bare.fiber.dispose()
  })

  it('routes writes by scope and rejects project writes without a workspace', async () => {
    const ctx = await mounted()
    const cwd = join(HOME, 'work', 'proj')
    ctx.provide('workspaceRegistry', selectiveRegistry(cwd))
    const { provider, write } = fakeProvider()
    ctx.memory.register(provider)

    await ctx.memory.write({ scope: 'global', title: 'g', content: 'c' }, cwd)
    expect(write).toHaveBeenLastCalledWith({ scope: 'global', title: 'g', content: 'c' }, join(HOME, 'memory'), undefined)

    await ctx.memory.write({ scope: 'project', title: 'p', content: 'c' }, cwd)
    expect(write).toHaveBeenLastCalledWith({ scope: 'project', title: 'p', content: 'c' }, join(cwd, PROJECT_MEMORY_DIR), undefined)

    await expect(ctx.memory.write({ scope: 'project', title: 'p', content: 'c' }, undefined))
      .rejects.toMatchObject({ code: 'NO_PROJECT_SCOPE' })
    await expect(ctx.memory.write({ scope: 'project', title: 'p', content: 'c' }, join(HOME, 'unregistered')))
      .rejects.toThrow('outside a registered workspace')
    await ctx.fiber.dispose()
  })

  it('rejects an aborted caller signal before the provider runs', async () => {
    const ctx = await mounted()
    const { provider, write } = fakeProvider()
    ctx.memory.register(provider)
    const controller = new AbortController()
    controller.abort(new Error('caller aborted'))
    await expect(ctx.memory.write({ scope: 'global', title: 't', content: 'c' }, undefined, controller.signal)).rejects.toThrow('caller aborted')
    expect(write).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('clears the registration on disposer and drains in-flight work first', async () => {
    const ctx = await mounted()
    let resolveWrite: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { resolveWrite = resolve })
    const { provider } = fakeProvider({ write: vi.fn(async () => { await pending; return { id: MemoryNoteId('n1'), scope: 'global', title: 't', path: 'p', created: 'c', updated: 'u' } }) })
    const dispose = ctx.memory.register(provider)
    const write = ctx.memory.write({ scope: 'global', title: 't', content: 'c' }, undefined)

    const disposal = dispose()
    let drained = false
    void disposal.then(() => { drained = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(drained).toBe(false)

    resolveWrite!()
    await write
    await disposal
    expect(drained).toBe(true)
    await expect(ctx.memory.read('n1', undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await ctx.fiber.dispose()
  })

  it('cleans rejected operations out of the in-flight set', async () => {
    const ctx = await mounted()
    const { provider } = fakeProvider({ write: vi.fn(async () => { throw new Error('write failed') }) })
    ctx.memory.register(provider)
    await expect(ctx.memory.write({ scope: 'global', title: 't', content: 'c' }, undefined)).rejects.toThrow('write failed')
    await ctx.fiber.dispose()
  })

  it('drains in-flight operations during service disposal', async () => {
    const ctx = await mounted()
    let resolveWrite: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { resolveWrite = resolve })
    const { provider } = fakeProvider({ write: vi.fn(async () => { await pending; return { id: MemoryNoteId('n1'), scope: 'global', title: 't', path: 'p', created: 'c', updated: 'u' } }) })
    ctx.memory.register(provider)
    const write = ctx.memory.write({ scope: 'global', title: 't', content: 'c' }, undefined)

    const disposal = ctx.fiber.dispose()
    let drained = false
    void disposal.then(() => { drained = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(drained).toBe(false)

    resolveWrite!()
    await write
    await disposal
    expect(drained).toBe(true)
  })

  it('defaults the global vault to memory/ under the harness home', async () => {
    const ctx = await mounted({ dshHome: join(HOME, 'alt-home') })
    const { provider, read } = fakeProvider()
    ctx.memory.register(provider)
    await ctx.memory.read('n1', undefined)
    expect(read).toHaveBeenCalledWith('n1', [join(HOME, 'alt-home', 'memory')], undefined)
    await ctx.fiber.dispose()
  })

  it('accepts an explicit global dir override', async () => {
    const ctx = await mounted({ dir: join(HOME, 'custom-vault') })
    const { provider, read } = fakeProvider()
    ctx.memory.register(provider)
    await ctx.memory.read('n1', undefined)
    expect(read).toHaveBeenCalledWith('n1', [join(HOME, 'custom-vault')], undefined)
    await ctx.fiber.dispose()
  })
})
