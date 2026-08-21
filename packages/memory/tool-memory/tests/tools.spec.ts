import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import MemoryService, { MemoryNoteId, PROJECT_MEMORY_DIR } from '@deepseek-ai/dsh-memory'
import type { MemoryNote, MemoryProvider, MemoryTraversal, MemoryWriteResult } from '@deepseek-ai/dsh-memory'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tool from '../src/index.ts'

const HOME = tmpdir()
const CWD = join(HOME, 'work', 'proj')
const PROJECT_DIR = join(CWD, PROJECT_MEMORY_DIR)
const GLOBAL_DIR = join(HOME, 'memory')
const signal = new AbortController().signal

function agentWithCwd(cwd: string | undefined): Agent {
  const session = Session.create(SessionId('tool-parent'), undefined, {
    version: 0,
    id: SessionId('tool-parent'),
    createdAt: 0,
    ...(cwd !== undefined ? { cwd } : {}),
  })
  return { id: SessionId('tool-parent'), session } as unknown as Agent
}

type ProviderSpies = Pick<MemoryProvider, 'write' | 'read' | 'search' | 'traverse' | 'readPersona' | 'recentNotes' | 'appendJournal' | 'commitDistill' | 'listNotes' | 'delete'>

function fakeProvider(): ProviderSpies & { provider: MemoryProvider } {
  const note: MemoryNote = {
    id: MemoryNoteId('n1'),
    scope: 'project',
    title: 'A note',
    path: 'notes/a-note.md',
    tags: ['t'],
    body: 'body',
    updated: 1,
    related: [{ id: MemoryNoteId('n2'), title: 'Other' }],
    backlinks: [{ id: MemoryNoteId('n3'), title: 'Source' }],
  }
  const result: MemoryWriteResult = {
    id: MemoryNoteId('n1'),
    scope: 'project',
    title: 'A note',
    path: 'notes/a-note.md',
    created: 't0',
    updated: 't0',
  }
  const traversal: MemoryTraversal = {
    start: { id: MemoryNoteId('n1'), title: 'A note' },
    nodes: [{ id: MemoryNoteId('n2'), title: 'Other', via: { kind: 'wikilink', direction: 'out' } }],
    truncated: false,
  }
  const write = vi.fn(async () => result)
  const read = vi.fn(async () => note)
  const search = vi.fn(async () => [{ id: MemoryNoteId('n1'), scope: 'project' as const, title: 'A note', snippet: 'body', tags: ['t'] }])
  const traverse = vi.fn(async () => traversal)
  const readPersona = vi.fn(async () => ({ path: 'MEMORY.md', text: 'persona' }))
  const recentNotes = vi.fn(async () => [])
  const appendJournal = vi.fn(async () => ({ path: 'journal/2026-08-18.md', date: '2026-08-18' }))
  const commitDistill = vi.fn(async () => { throw new Error('unused in tool-memory tests') })
  const listNotes = vi.fn(async () => [])
  const del = vi.fn(async () => ({ id: MemoryNoteId('n1'), title: 'A note', path: 'notes/a-note.md', trashPath: join(GLOBAL_DIR, 'memory-trash', 'notes', 'a-note.md') }))
  return {
    provider: { write, read, search, traverse, readPersona, recentNotes, appendJournal, commitDistill, listNotes, delete: del },
    write, read, search, traverse, readPersona, recentNotes, appendJournal, commitDistill, listNotes, delete: del,
  }
}

function selectiveRegistry(registered: string): { resolveByPath: ReturnType<typeof vi.fn> } {
  return { resolveByPath: vi.fn((path: string) => path === registered
    ? Promise.resolve({ path })
    : Promise.reject(new Error(`no workspace for ${path}`))) }
}

async function setup(options: { registry?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemoryService, { dir: join(HOME, 'memory') })
  if (options.registry === true) ctx.provide('workspaceRegistry', selectiveRegistry(CWD))
  await ctx.plugin(tool, undefined)
  return ctx
}


function textOf(blocks: ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, cwd?: string) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: agentWithCwd(cwd),
  })
}

describe('tool-memory registration', () => {
  it('registers the five memory tools on the shared registry', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('memory_write')
    expect(names).toContain('memory_read')
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_traverse')
    expect(names).toContain('memory_delete')
    await ctx.fiber.dispose()
  })

  it('unregisters the tools when the plugin fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemoryService, { dir: join(HOME, 'memory') })
    ctx.memory.register(fakeProvider().provider)
    const fiber = ctx.plugin(tool, undefined)
    await fiber
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('memory_write')
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('memory_write')
    await ctx.fiber.dispose()
  })
})

describe('memory_write', () => {
  it('defaults to the project scope in a registered workspace', async () => {
    const ctx = await setup({ registry: true })
    const provider = fakeProvider()
    ctx.memory.register(provider.provider)
    const result = await call(ctx, 'memory_write', { title: 'T', content: 'C' }, CWD)
    expect(provider.write).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project', title: 'T', content: 'C' }),
      PROJECT_DIR,
      expect.anything(),
    )
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(textOf(result.content)).toContain('project')
    await ctx.fiber.dispose()
  })

  it('defaults to the global scope without a workspace and honors explicit scopes', async () => {
    const ctx = await setup({ registry: true })
    const provider = fakeProvider()
    ctx.memory.register(provider.provider)
    await call(ctx, 'memory_write', { title: 'T', content: 'C' }, undefined)
    expect(provider.write).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'global' }), GLOBAL_DIR, expect.anything())
    await call(ctx, 'memory_write', { scope: 'project', title: 'T', content: 'C' }, CWD)
    expect(provider.write).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'project' }), PROJECT_DIR, expect.anything())
    await call(ctx, 'memory_write', { scope: 'global', title: 'T', content: 'C' }, CWD)
    expect(provider.write).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'global' }), GLOBAL_DIR, expect.anything())
    await ctx.fiber.dispose()
  })

  it('passes id, tags, and related through and rejects an invalid scope', async () => {
    const ctx = await setup({ registry: true })
    const provider = fakeProvider()
    ctx.memory.register(provider.provider)
    await call(ctx, 'memory_write', { id: 'x1', title: 'T', content: 'C', tags: ['a'], related: ['B'] }, CWD)
    expect(provider.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: MemoryNoteId('x1'), scope: 'project', title: 'T', content: 'C', tags: ['a'], related: ['B'] }),
      PROJECT_DIR,
      expect.anything(),
    )
    const invalid = await call(ctx, 'memory_write', { scope: 'other', title: 'T', content: 'C' })
    expect(invalid.isError).toBe(true)
    expect(textOf(invalid.content)).toContain('scope must be "project" or "global"')
    await ctx.fiber.dispose()
  })

  it('reports invalid arguments as an error result', async () => {
    const ctx = await setup()
    const failed = await call(ctx, 'memory_write', { title: 'T' })
    expect(failed.isError).toBe(true)
    expect(textOf(failed.content)).toContain('content')
    await ctx.fiber.dispose()
  })

  it('requires an agent caller', async () => {
    const ctx = await setup()
    const failed = await ctx.tools.execute({
      signal,
      callId: CallId('no-agent'),
      name: 'memory_read',
      arguments: { ref: 'n1' },
    })
    expect(failed.isError).toBe(true)
    expect(textOf(failed.content)).toContain('require an agent caller')
    await ctx.fiber.dispose()
  })
})

describe('memory_delete', () => {
  it('delegates an approved soft delete with the caller cwd and renders the trash path', async () => {
    const ctx = await setup({ registry: true })
    const provider = fakeProvider()
    ctx.memory.register(provider.provider)
    const request = vi.fn(async (_req: { toolName: string; reason: string; callId?: unknown }) => 'allowed-once' as const)
    ctx.provide('approval', { request })

    const result = await call(ctx, 'memory_delete', { ref: 'n1' }, CWD)
    expect(provider.delete).toHaveBeenCalledWith('n1', PROJECT_DIR, expect.anything(), undefined)
    expect(request).toHaveBeenCalledTimes(1)
    const asked = request.mock.calls[0]?.[0]
    expect(asked).toMatchObject({
      toolName: 'memory_delete',
      reason: 'Delete the memory note "n1"?',
    })
    expect(asked?.callId).toBeDefined()
    expect(textOf(result.content)).toContain('moved to')
    await ctx.fiber.dispose()
  })

  it('passes an explicit scope through to the service', async () => {
    const ctx = await setup({ registry: true })
    const provider = fakeProvider()
    ctx.memory.register(provider.provider)
    ctx.provide('approval', { request: vi.fn(async () => 'allowed-once' as const) })

    await call(ctx, 'memory_delete', { ref: 'n1', scope: 'global' }, CWD)
    expect(provider.delete).toHaveBeenCalledWith('n1', GLOBAL_DIR, expect.anything(), undefined)
    await ctx.fiber.dispose()
  })

  it('rejects an invalid scope before asking for approval', async () => {
    const ctx = await setup()
    const request = vi.fn()
    ctx.provide('approval', { request })
    const failed = await call(ctx, 'memory_delete', { ref: 'n1', scope: 'other' }, CWD)
    expect(failed.isError).toBe(true)
    expect(textOf(failed.content)).toContain('scope must be "project" or "global"')
    expect(request).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('fails loudly when no approval channel is composed', async () => {
    const ctx = await setup({ registry: true })
    ctx.memory.register(fakeProvider().provider)
    const failed = await call(ctx, 'memory_delete', { ref: 'n1' }, CWD)
    expect(failed.isError).toBe(true)
    expect(textOf(failed.content)).toContain('no approval channel is available')
    await ctx.fiber.dispose()
  })

  it('denies on every non-grant outcome with a distinct reason', async () => {
    for (const [outcome, expected] of [
      ['rejected', 'the user rejected memory_delete'],
      ['cancelled', 'approval for memory_delete was cancelled'],
      ['unavailable', 'no approval channel is available'],
    ] as const) {
      const ctx = await setup({ registry: true })
      const provider = fakeProvider()
      ctx.memory.register(provider.provider)
      ctx.provide('approval', { request: vi.fn(async () => outcome) })
      const failed = await call(ctx, 'memory_delete', { ref: 'n1' }, CWD)
      expect(failed.isError).toBe(true)
      expect(textOf(failed.content)).toContain(expected)
      expect(provider.delete).not.toHaveBeenCalled()
      await ctx.fiber.dispose()
    }
  })

  it('fails the call on a rogue non-vocabulary answerer return', async () => {
    const ctx = await setup({ registry: true })
    const provider = fakeProvider()
    ctx.memory.register(provider.provider)
    ctx.provide('approval', { request: vi.fn(async () => 'whatever' as never) })
    const failed = await call(ctx, 'memory_delete', { ref: 'n1' }, CWD)
    expect(failed.isError).toBe(true)
    expect(provider.delete).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('requires an agent caller', async () => {
    const ctx = await setup()
    ctx.provide('approval', { request: vi.fn() })
    const failed = await ctx.tools.execute({
      signal,
      callId: CallId('no-agent'),
      name: 'memory_delete',
      arguments: { ref: 'n1' },
    })
    expect(failed.isError).toBe(true)
    expect(textOf(failed.content)).toContain('require an agent caller')
    await ctx.fiber.dispose()
  })
})

describe('memory_read, memory_search, and memory_traverse', () => {
  it('delegates each operation with the caller cwd', async () => {
    const ctx = await setup({ registry: true })
    const provider = fakeProvider()
    ctx.memory.register(provider.provider)

    const read = await call(ctx, 'memory_read', { ref: 'n1' }, CWD)
    expect(provider.read).toHaveBeenCalledWith('n1', [PROJECT_DIR, GLOBAL_DIR], expect.anything())
    expect(textOf(read.content)).toContain('A note')
    expect(textOf(read.content)).toContain('Backlinks: Source')

    const search = await call(ctx, 'memory_search', { query: 'vitest', limit: 3 }, CWD)
    expect(provider.search).toHaveBeenCalledWith('vitest', { limit: 3 }, [PROJECT_DIR, GLOBAL_DIR], expect.anything())
    expect(textOf(search.content)).toContain('A note (project)')

    const traverse = await call(ctx, 'memory_traverse', { ref: 'n1', depth: 2, kinds: ['wikilink'] }, CWD)
    expect(provider.traverse).toHaveBeenCalledWith('n1', { depth: 2, kinds: ['wikilink'] }, [PROJECT_DIR, GLOBAL_DIR], expect.anything())
    expect(textOf(traverse.content)).toContain('out wikilink')
    await ctx.fiber.dispose()
  })

  it('omits optional search and traverse options when absent', async () => {
    const ctx = await setup({ registry: true })
    const provider = fakeProvider()
    ctx.memory.register(provider.provider)
    await call(ctx, 'memory_search', { query: 'q' }, CWD)
    expect(provider.search).toHaveBeenCalledWith('q', undefined, [PROJECT_DIR, GLOBAL_DIR], expect.anything())
    await call(ctx, 'memory_traverse', { ref: 'n1' }, CWD)
    expect(provider.traverse).toHaveBeenCalledWith('n1', {}, [PROJECT_DIR, GLOBAL_DIR], expect.anything())
    await ctx.fiber.dispose()
  })
})

describe('render helpers', () => {
  it('renders empty search results and dangling traversal nodes', () => {
    const empty = tool.renderSearch([])
    expect(textOf(empty)).toBe('No memory notes matched the query.')
    const dangling = tool.renderTraverse({
      start: { id: MemoryNoteId('n1'), title: 'Start' },
      nodes: [{ title: 'Ghost', via: { kind: 'wikilink', direction: 'out' } }, { id: MemoryNoteId('n2'), title: 'Real', via: { kind: 'related', direction: 'in' } }],
      truncated: true,
    })
    const text = textOf(dangling)
    expect(text).toContain('Ghost (dangling)')
    expect(text).toContain('truncated')
    expect(textOf(tool.renderTraverse({ start: { id: MemoryNoteId('n1'), title: 'Start' }, nodes: [], truncated: false }))).toContain('No linked notes')
  })

  it('renders a read note without links and tags', () => {
    const note: MemoryNote = {
      id: MemoryNoteId('n1'),
      scope: 'global',
      title: 'Plain',
      path: 'p',
      tags: [],
      body: 'just body',
      updated: 1,
      related: [],
      backlinks: [],
    }
    const text = textOf(tool.renderRead(note))
    expect(text).toContain('just body')
    expect(text).toContain('(none)')
    expect(text).not.toContain('Related')
  })

  it('renders a read note with resolved and dangling links', () => {
    const note: MemoryNote = {
      id: MemoryNoteId('n1'),
      scope: 'global',
      title: 'Linked',
      path: 'p',
      tags: ['a', 'b'],
      body: 'body',
      updated: 1,
      related: [{ id: MemoryNoteId('n2'), title: 'Resolved' }, { title: 'Dangling' }],
      backlinks: [{ id: MemoryNoteId('n3'), title: 'Source' }],
    }
    const text = textOf(tool.renderRead(note))
    expect(text).toContain('Resolved (resolved)')
    expect(text).toContain('Dangling')
    expect(text).toContain('Backlinks: Source')
    expect(text).toContain('Tags: a, b')
  })

  it('renders write results for both scopes', () => {
    const written = tool.renderWrite('project', 'T', 'notes/t.md')
    expect(textOf(written)).toContain('(project scope)')
    expect(textOf(tool.renderWrite('global', 'T', 'p'))).toContain('(global scope)')
  })

  it('renders delete results with and without a trash path', () => {
    const trashed = tool.renderDelete({ scope: 'global', title: 'T', path: 'notes/t.md', trashPath: '/trash/t.md' })
    expect(textOf(trashed)).toContain('moved to /trash/t.md')
    const bare = tool.renderDelete({ scope: 'project', title: 'T', path: 'notes/t.md' })
    expect(textOf(bare)).toContain('Deleted memory note "T" (project scope) from notes/t.md.')
  })
})
