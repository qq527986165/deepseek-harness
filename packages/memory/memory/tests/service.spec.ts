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

type ProviderSpies = Pick<MemoryProvider, 'write' | 'read' | 'search' | 'traverse' | 'readPersona' | 'recentNotes' | 'appendJournal' | 'commitDistill' | 'listNotes' | 'delete'>

function fakeProvider(overrides: Partial<MemoryProvider> = {}): ProviderSpies & { provider: MemoryProvider } {
  const note: MemoryNote = {
    id: MemoryNoteId('n1'),
    scope: 'global',
    title: 'A note',
    path: 'notes/a-note.md',
    tags: [],
    body: 'body',
    updated: 1,
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
  const readPersona = overrides.readPersona ?? vi.fn(async () => ({ path: 'MEMORY.md', text: 'persona' }))
  const recentNotes = overrides.recentNotes ?? vi.fn(async () => [{ path: 'notes/recent.md', title: 'Recent', body: 'b', updated: 1 }])
  const appendJournal = overrides.appendJournal ?? vi.fn(async () => ({ path: 'journal/2026-08-18.md', date: '2026-08-18' }))
  const commitDistill = overrides.commitDistill ?? vi.fn(async () => ({ notes: [], journals: [] }))
  const listNotes = overrides.listNotes ?? vi.fn(async () => [{
    id: MemoryNoteId('n1'), path: 'notes/a-note.md', title: 'A note', tags: [], updated: 1, excerpt: 'body', persona: false,
  }])
  const del = overrides.delete ?? vi.fn(async () => ({ id: MemoryNoteId('n1'), title: 'A note', path: 'notes/a-note.md', trashPath: '/trash/a-note.md' }))
  return {
    provider: { write, read, search, traverse, readPersona, recentNotes, appendJournal, commitDistill, listNotes, delete: del },
    write, read, search, traverse, readPersona, recentNotes, appendJournal, commitDistill, listNotes, delete: del,
  }
}

async function mounted(config: { dir?: string; dshHome?: string } = { dshHome: HOME }) {
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
    ctx.provide('workspaceRegistry', fakeRegistry(true))
    await expect(ctx.memory.write({ scope: 'global', title: 't', content: 'c' }, undefined)).rejects.toThrow('no memory provider is registered')
    await expect(ctx.memory.read('n1', undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(ctx.memory.search('q', undefined, undefined)).rejects.toBeInstanceOf(MemoryError)
    await expect(ctx.memory.traverse('n1', undefined, undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(ctx.memory.readInScope('n1', 'global', undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(ctx.memory.readPersona('global', undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(ctx.memory.recent(undefined, join(HOME, 'work', 'proj'))).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(ctx.memory.appendJournal({ scope: 'global', title: 't', body: 'b' }, undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await ctx.fiber.dispose()
  })

  it('rejects a second registration and rejects a malformed provider', async () => {
    const ctx = await mounted()
    ctx.memory.register(fakeProvider().provider)
    expect(() => ctx.memory.register(fakeProvider().provider)).toThrow('a memory provider is already registered')
    expect(() => ctx.memory.register({} as never)).toThrow('memory provider must implement write()')
    expect(() => ctx.memory.register('provider' as never)).toThrow('memory provider must be an object')
    expect(() => ctx.memory.register({ write: () => {} } as never)).toThrow('memory provider must implement read()')
    expect(() => ctx.memory.register({
      write: () => {}, read: () => {}, search: () => {}, traverse: () => {},
      readPersona: () => {}, recentNotes: () => {}, appendJournal: () => {}, commitDistill: () => {},
    } as never)).toThrow('memory provider must implement listNotes()')
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
    const { provider } = fakeProvider({ write: vi.fn(async (): Promise<MemoryWriteResult> => { await pending; return { id: MemoryNoteId('n1'), scope: 'global', title: 't', path: 'p', created: 'c', updated: 'u' } }) })
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
    const { provider } = fakeProvider({ write: vi.fn(async (): Promise<MemoryWriteResult> => { await pending; return { id: MemoryNoteId('n1'), scope: 'global', title: 't', path: 'p', created: 'c', updated: 'u' } }) })
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

  it('resolves readInScope within the exact vault only', async () => {
    const ctx = await mounted()
    const cwd = join(HOME, 'work', 'proj')
    ctx.provide('workspaceRegistry', selectiveRegistry(cwd))
    const { provider, read } = fakeProvider()
    ctx.memory.register(provider)
    await ctx.memory.readInScope('n1', 'global', cwd)
    expect(read).toHaveBeenCalledWith('n1', [join(HOME, 'memory')], undefined)
    await ctx.memory.readInScope('n1', 'project', cwd)
    expect(read).toHaveBeenLastCalledWith('n1', [join(cwd, PROJECT_MEMORY_DIR)], undefined)
    await expect(ctx.memory.readInScope('n1', 'project', undefined)).rejects.toMatchObject({ code: 'NO_PROJECT_SCOPE' })
    await ctx.fiber.dispose()
  })

  it('routes persona reads, recency windows, and journal appends by scope', async () => {
    const ctx = await mounted()
    const cwd = join(HOME, 'work', 'proj')
    ctx.provide('workspaceRegistry', selectiveRegistry(cwd))
    const { provider, readPersona, recentNotes, appendJournal } = fakeProvider()
    ctx.memory.register(provider)

    const persona = await ctx.memory.readPersona('global', undefined)
    expect(persona).toEqual({ dir: join(HOME, 'memory'), path: 'MEMORY.md', text: 'persona' })
    expect(readPersona).toHaveBeenCalledWith(join(HOME, 'memory'), undefined)

    await expect(ctx.memory.readPersona('project', undefined)).rejects.toMatchObject({ code: 'NO_PROJECT_SCOPE' })
    await ctx.memory.readPersona('project', cwd)
    expect(readPersona).toHaveBeenLastCalledWith(join(cwd, PROJECT_MEMORY_DIR), undefined)

    const recent = await ctx.memory.recent({ limit: 5 }, cwd)
    expect(recent).toEqual({ dir: join(cwd, PROJECT_MEMORY_DIR), notes: [{ path: 'notes/recent.md', title: 'Recent', body: 'b', updated: 1 }] })
    expect(recentNotes).toHaveBeenCalledWith({ limit: 5 }, join(cwd, PROJECT_MEMORY_DIR), undefined)
    await expect(ctx.memory.recent(undefined, undefined)).rejects.toMatchObject({ code: 'NO_PROJECT_SCOPE' })

    const journal = await ctx.memory.appendJournal({ scope: 'project', date: '2026-08-18', title: 'T', body: '- b' }, cwd)
    expect(journal).toEqual({ dir: join(cwd, PROJECT_MEMORY_DIR), path: 'journal/2026-08-18.md', date: '2026-08-18' })
    expect(appendJournal).toHaveBeenCalledWith({ scope: 'project', date: '2026-08-18', title: 'T', body: '- b' }, join(cwd, PROJECT_MEMORY_DIR), undefined)

    await ctx.memory.appendJournal({ scope: 'global', title: 'G', body: '- b' }, undefined)
    expect(appendJournal).toHaveBeenLastCalledWith({ scope: 'global', title: 'G', body: '- b' }, join(HOME, 'memory'), undefined)
    await ctx.fiber.dispose()
  })

  it('routes whole-turn distillation commits through resolved vault dirs', async () => {
    const ctx = await mounted()
    const cwd = join(HOME, 'work', 'proj')
    ctx.provide('workspaceRegistry', selectiveRegistry(cwd))
    const { provider, commitDistill } = fakeProvider()
    ctx.memory.register(provider)

    await ctx.memory.commitDistill([
      { scope: 'project', date: '2026-08-20', journalTitle: 'T', journalBody: '- b', notes: [{ title: 'A', content: 'a' }] },
      { scope: 'global', date: '2026-08-20', journalTitle: 'T', journalBody: '- b', notes: [{ title: 'B', content: 'b' }] },
    ], cwd)

    expect(commitDistill).toHaveBeenCalledWith(expect.any(Array), {
      project: join(cwd, PROJECT_MEMORY_DIR),
      global: join(HOME, 'memory'),
    }, undefined)
    await ctx.memory.commitDistill([
      { scope: 'global', date: '2026-08-20', journalTitle: 'G', journalBody: '- b', notes: [{ title: 'B', content: 'b' }] },
    ], undefined)
    expect(commitDistill).toHaveBeenLastCalledWith(expect.any(Array), {
      project: undefined,
      global: join(HOME, 'memory'),
    }, undefined)
    await expect(ctx.memory.commitDistill([
      { scope: 'project', date: '2026-08-20', journalTitle: 'T', journalBody: '- b', notes: [{ title: 'A', content: 'a' }] },
    ], undefined)).rejects.toMatchObject({ code: 'NO_PROJECT_SCOPE' })
    await ctx.fiber.dispose()
  })

  it('returns no persona when the vault has no MEMORY.md', async () => {
    const ctx = await mounted()
    const { provider } = fakeProvider({ readPersona: vi.fn(async () => undefined) })
    ctx.memory.register(provider)
    await expect(ctx.memory.readPersona('global', undefined)).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('passes an aborted journal signal through without touching the provider', async () => {
    const ctx = await mounted()
    const { provider, appendJournal } = fakeProvider()
    ctx.memory.register(provider)
    const controller = new AbortController()
    controller.abort(new Error('caller aborted'))
    await expect(ctx.memory.appendJournal({ scope: 'global', title: 't', body: 'b' }, undefined, controller.signal)).rejects.toThrow('caller aborted')
    expect(appendJournal).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('routes listings by scope with the provider cap contract intact', async () => {
    const ctx = await mounted()
    const cwd = join(HOME, 'work', 'proj')
    ctx.provide('workspaceRegistry', selectiveRegistry(cwd))
    const { provider, listNotes } = fakeProvider()
    ctx.memory.register(provider)

    const global = await ctx.memory.list('global', undefined, { limit: 7 })
    expect(global).toEqual({
      dir: join(HOME, 'memory'),
      scope: 'global',
      notes: [{ id: 'n1', path: 'notes/a-note.md', title: 'A note', tags: [], updated: 1, excerpt: 'body', persona: false }],
    })
    expect(listNotes).toHaveBeenCalledWith({ limit: 7 }, join(HOME, 'memory'), undefined)

    await ctx.memory.list('project', cwd)
    expect(listNotes).toHaveBeenLastCalledWith(undefined, join(cwd, PROJECT_MEMORY_DIR), undefined)

    await expect(ctx.memory.list('project', undefined)).rejects.toMatchObject({ code: 'NO_PROJECT_SCOPE' })
    await ctx.fiber.dispose()
  })

  it('searches within exactly one vault for per-tab consumers', async () => {
    const ctx = await mounted()
    const cwd = join(HOME, 'work', 'proj')
    ctx.provide('workspaceRegistry', selectiveRegistry(cwd))
    const { provider, search } = fakeProvider()
    ctx.memory.register(provider)

    await ctx.memory.searchInScope('q', { limit: 3 }, 'global', undefined)
    expect(search).toHaveBeenCalledWith('q', { limit: 3 }, [join(HOME, 'memory')], undefined)

    await ctx.memory.searchInScope('q', undefined, 'project', cwd)
    expect(search).toHaveBeenLastCalledWith('q', undefined, [join(cwd, PROJECT_MEMORY_DIR)], undefined)

    await expect(ctx.memory.searchInScope('q', undefined, 'project', undefined)).rejects.toMatchObject({ code: 'NO_PROJECT_SCOPE' })
    await ctx.fiber.dispose()
  })

  it('resolves a scope-less delete across the chain, first hit wins', async () => {
    const ctx = await mounted()
    const cwd = join(HOME, 'work', 'proj')
    ctx.provide('workspaceRegistry', selectiveRegistry(cwd))
    const notFound = new MemoryError('no memory note matches "n1"', 'NOT_FOUND')
    const { provider, delete: del } = fakeProvider({
      delete: vi.fn(async (ref: string, dir: string) => {
        if (ref === 'missing' || dir === join(cwd, PROJECT_MEMORY_DIR)) throw notFound
        return { id: MemoryNoteId('n1'), title: 'A note', path: 'notes/a-note.md', trashPath: join(dir, 'x.md') }
      }),
    })
    ctx.memory.register(provider)

    const result = await ctx.memory.delete('n1', undefined, cwd)
    expect(result).toEqual({ id: 'n1', scope: 'global', title: 'A note', path: 'notes/a-note.md', trashPath: join(HOME, 'memory', 'x.md') })
    expect(del).toHaveBeenCalledTimes(2)

    await expect(ctx.memory.delete('missing', undefined, cwd)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await ctx.fiber.dispose()
  })

  it('routes an explicit-scope delete with its options to the exact vault', async () => {
    const ctx = await mounted()
    const cwd = join(HOME, 'work', 'proj')
    ctx.provide('workspaceRegistry', selectiveRegistry(cwd))
    const { provider, delete: del } = fakeProvider({
      delete: vi.fn(async () => ({ id: MemoryNoteId('n1'), title: 'A note', path: 'notes/a-note.md' })),
    })
    ctx.memory.register(provider)

    const result = await ctx.memory.delete('n1', 'project', cwd, undefined, { mode: 'permanent' })
    expect(result).toEqual({ id: 'n1', scope: 'project', title: 'A note', path: 'notes/a-note.md' })
    expect(del).toHaveBeenCalledWith('n1', join(cwd, PROJECT_MEMORY_DIR), undefined, { mode: 'permanent' })

    const global = await ctx.memory.delete('n1', 'global', undefined)
    expect(global.scope).toBe('global')
    expect(del).toHaveBeenLastCalledWith('n1', join(HOME, 'memory'), undefined, undefined)

    await expect(ctx.memory.delete('n1', 'project', undefined)).rejects.toMatchObject({ code: 'NO_PROJECT_SCOPE' })
    await ctx.fiber.dispose()
  })

  it('reports project scope when a scope-less delete hits the chain head', async () => {
    const ctx = await mounted()
    const cwd = join(HOME, 'work', 'proj')
    ctx.provide('workspaceRegistry', selectiveRegistry(cwd))
    const { provider } = fakeProvider()
    ctx.memory.register(provider)
    const result = await ctx.memory.delete('n1', undefined, cwd)
    expect(result.scope).toBe('project')
    await ctx.fiber.dispose()
  })

  it('exposes the configured global vault directory through info()', async () => {
    const ctx = await mounted({ dir: join(HOME, 'custom-vault') })
    expect(ctx.memory.info()).toEqual({ globalDir: join(HOME, 'custom-vault') })
    await ctx.fiber.dispose()
  })

  it('fails listing and deletion loudly without a registered provider', async () => {
    const ctx = await mounted()
    await expect(ctx.memory.list('global', undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(ctx.memory.searchInScope('q', undefined, 'global', undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(ctx.memory.delete('n1', undefined, undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await ctx.fiber.dispose()
  })
})
