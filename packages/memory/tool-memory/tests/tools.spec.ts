import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import MemoryService, { MemoryNoteId, PROJECT_MEMORY_DIR } from '@deepseek-ai/dsh-memory'
import type { MemoryNote, MemoryProvider, MemoryTraversal, MemoryWriteResult } from '@deepseek-ai/dsh-memory'
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

type ProviderSpies = Pick<MemoryProvider, 'write' | 'read' | 'search' | 'traverse'>

function fakeProvider(): ProviderSpies & { provider: MemoryProvider } {
  const note: MemoryNote = {
    id: MemoryNoteId('n1'),
    scope: 'project',
    title: 'A note',
    path: 'notes/a-note.md',
    tags: ['t'],
    body: 'body',
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
  return { provider: { write, read, search, traverse }, write, read, search, traverse }
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
  it('registers the four memory tools on the shared registry', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('memory_write')
    expect(names).toContain('memory_read')
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_traverse')
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
    expect(String(result.content[0]?.text)).toContain('project')
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
    expect(String(invalid.content[0]?.text)).toContain('scope must be "project" or "global"')
    await ctx.fiber.dispose()
  })

  it('reports invalid arguments as an error result', async () => {
    const ctx = await setup()
    const failed = await call(ctx, 'memory_write', { title: 'T' })
    expect(failed.isError).toBe(true)
    expect(String(failed.content[0]?.text)).toContain('content')
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
    expect(String(failed.content[0]?.text)).toContain('require an agent caller')
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
    expect(String(read.content[0]?.text)).toContain('A note')
    expect(String(read.content[0]?.text)).toContain('Backlinks: Source')

    const search = await call(ctx, 'memory_search', { query: 'vitest', limit: 3 }, CWD)
    expect(provider.search).toHaveBeenCalledWith('vitest', { limit: 3 }, [PROJECT_DIR, GLOBAL_DIR], expect.anything())
    expect(String(search.content[0]?.text)).toContain('A note (project)')

    const traverse = await call(ctx, 'memory_traverse', { ref: 'n1', depth: 2, kinds: ['wikilink'] }, CWD)
    expect(provider.traverse).toHaveBeenCalledWith('n1', { depth: 2, kinds: ['wikilink'] }, [PROJECT_DIR, GLOBAL_DIR], expect.anything())
    expect(String(traverse.content[0]?.text)).toContain('out wikilink')
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
    expect(String(empty[0]?.text)).toBe('No memory notes matched the query.')
    const dangling = tool.renderTraverse({
      start: { id: MemoryNoteId('n1'), title: 'Start' },
      nodes: [{ title: 'Ghost', via: { kind: 'wikilink', direction: 'out' } }, { id: MemoryNoteId('n2'), title: 'Real', via: { kind: 'related', direction: 'in' } }],
      truncated: true,
    })
    const text = String(dangling[0]?.text)
    expect(text).toContain('Ghost (dangling)')
    expect(text).toContain('truncated')
    expect(tool.renderTraverse({ start: { id: MemoryNoteId('n1'), title: 'Start' }, nodes: [], truncated: false })[0]?.text).toContain('No linked notes')
  })

  it('renders a read note without links and tags', () => {
    const note: MemoryNote = {
      id: MemoryNoteId('n1'),
      scope: 'global',
      title: 'Plain',
      path: 'p',
      tags: [],
      body: 'just body',
      related: [],
      backlinks: [],
    }
    const text = String(tool.renderRead(note)[0]?.text)
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
      related: [{ id: MemoryNoteId('n2'), title: 'Resolved' }, { title: 'Dangling' }],
      backlinks: [{ id: MemoryNoteId('n3'), title: 'Source' }],
    }
    const text = String(tool.renderRead(note)[0]?.text)
    expect(text).toContain('Resolved (resolved)')
    expect(text).toContain('Dangling')
    expect(text).toContain('Backlinks: Source')
    expect(text).toContain('Tags: a, b')
  })

  it('renders write results for both scopes', () => {
    const written = tool.renderWrite('project', 'T', 'notes/t.md')
    expect(String(written[0]?.text)).toContain('(project scope)')
    expect(String(tool.renderWrite('global', 'T', 'p')[0]?.text)).toContain('(global scope)')
  })
})
