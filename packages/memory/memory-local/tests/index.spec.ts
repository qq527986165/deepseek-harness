import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MemoryService from '@deepseek-ai/dsh-memory'
import { LocalMemoryProvider, apply, extractWikiLinks, inject, name, resolveConfig, silentWarn } from '@deepseek-ai/dsh-memory-local'
import type { WatchImpl, WatchLike } from '../src/watcher.ts'

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-local-'))
  dirs.length = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const globalDir = () => join(root, 'home', 'memory')
const projectDir = () => join(root, 'work', 'proj', '.dsh', 'memory')
const chain = () => [projectDir(), globalDir()]

class FakeHandle extends EventEmitter implements WatchLike {
  closed = false
  constructor(readonly dir: string) { super() }
  async close(): Promise<void> { this.closed = true }
}

function fakeWatch(): { impl: WatchImpl; handles: FakeHandle[] } {
  const handles: FakeHandle[] = []
  const impl: WatchImpl = (dir: string) => {
    const handle = new FakeHandle(dir)
    handles.push(handle)
    return handle
  }
  return { impl, handles }
}

function provider(watch?: boolean  ) {
  const config = resolveConfig({ watch: watch ?? true, debounceMs: 5 })
  return new LocalMemoryProvider(config, fakeWatch().impl)
}

function configured(config: { watch?: boolean; maxSearchResults?: number; maxTraverseNodes?: number }) {
  return new LocalMemoryProvider(resolveConfig(config), fakeWatch().impl)
}

const input = (extra: Partial<Parameters<LocalMemoryProvider['write']>[0]> = {}) => ({
  scope: 'global' as const,
  title: 'My note',
  content: 'Body about vitest.',
  ...extra,
})

describe('LocalMemoryProvider write/read', () => {
  it('round-trips a created note with stable identity and Obsidian-readable files', async () => {
    const p = provider(false)
    const written = await p.write(input(), globalDir())
    expect(written.scope).toBe('global')
    expect(written.path).toBe('notes/my-note.md')

    const file = await readFile(join(globalDir(), written.path), 'utf8')
    expect(file).toContain('id:')
    expect(file).toContain('Body about vitest.')

    const read = await p.read(written.id, [globalDir()])
    expect(read.title).toBe('My note')
    expect(read.body).toBe('Body about vitest.')
    expect(read.scope).toBe('global')
    expect(read.id).toBe(written.id)
    await p.dispose()
  })

  it('replaces by id in place, preserving created and path', async () => {
    const p = provider(false)
    const first = await p.write(input(), globalDir())
    const second = await p.write(input({ id: first.id, content: 'Replaced body.' }), globalDir())
    expect(second.path).toBe(first.path)
    expect(second.created).toBe(first.created)
    expect(second.id).toBe(first.id)
    expect((await p.read(first.id, [globalDir()])).body).toBe('Replaced body.')
    await p.dispose()
  })

  it('suffixes path collisions without touching sibling notes', async () => {
    const p = provider(false)
    const first = await p.write(input({ title: 'Collide' }), globalDir())
    const second = await p.write(input({ title: 'Collide' }), globalDir())
    expect(first.path).toBe('notes/collide.md')
    expect(second.path).toBe('notes/collide-2.md')
    await p.dispose()
  })

  it('finds notes across the chain by id or exact title, project first', async () => {
    const p = provider(false)
    const project = await p.write(input({ scope: 'project', title: 'Project note' }), projectDir())
    const global = await p.write(input({ title: 'Global note' }), globalDir())
    expect((await p.read(project.id, chain())).scope).toBe('project')
    expect((await p.read('Global note', chain())).scope).toBe('global')
    expect((await p.read(global.id, [globalDir()])).scope).toBe('global')
    await expect(p.read('missing', chain())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await p.dispose()
  })

  it('rejects an aborted write before touching disk', async () => {
    const p = provider(false)
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(p.write(input(), globalDir(), controller.signal)).rejects.toThrow('stop')
    await p.dispose()
  })

  it('keeps the exclusive chain usable after a failed write', async () => {
    const p = provider(false)
    await mkdir(globalDir(), { recursive: true })
    await writeFile(join(globalDir(), 'notes'), 'blocker file', 'utf8')
    await expect(p.write(input(), globalDir())).rejects.toThrow()
    const blocked = join(root, 'work', 'proj', '.dsh', 'memory')
    const ok = await p.write(input({ title: 'Recovered' }), blocked)
    expect(ok.path).toBe('notes/recovered.md')
    await p.dispose()
  })

  it('drops stale rows during a full reconcile on open', async () => {
    const first = provider(false)
    const written = await first.write(input(), globalDir())
    await first.dispose()
    await rm(join(globalDir(), written.path))
    const second = provider(false)
    await expect(second.read(written.id, [globalDir()])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await second.search('vitest', undefined, [globalDir()])).toEqual([])
    await second.dispose()
  })

  it('falls back to file mtime for unparseable created timestamps', async () => {
    await mkdir(join(globalDir(), 'notes'), { recursive: true })
    await writeFile(join(globalDir(), 'notes', 'weird.md'), '---\nid: x1\nscope: global\ntitle: Weird\ncreated: garbage\nupdated: garbage\n---\nbody', 'utf8')
    const p = provider(false)
    const updated = await p.write(input({ id: 'x1' as never, title: 'Weird' }), globalDir())
    expect(Number.isFinite(Date.parse(updated.created))).toBe(true)
    await p.dispose()
  })

  it('reports watcher faults through the provider warn path', async () => {
    const { impl, handles } = fakeWatch()
    const warn = vi.fn()
    const p = new LocalMemoryProvider(resolveConfig({ watch: true, debounceMs: 5 }), impl, warn)
    await p.write(input(), globalDir())
    handles[0]!.emit('error', new Error('backend failed'))
    expect(warn).toHaveBeenCalledWith(expect.any(Error))
    await p.dispose()
  })
})

describe('LocalMemoryProvider search', () => {
  it('ranks hits and puts project hits first across the chain', async () => {
    const p = provider(false)
    await p.write(input({ title: 'Project vitest' }), projectDir())
    await p.write(input({ title: 'Global vitest' }), globalDir())
    const hits = await p.search('vitest', undefined, chain())
    expect(hits.map(hit => hit.scope)).toEqual(['project', 'global'])
    expect(hits[0]?.title).toBe('Project vitest')
    expect(hits[0]?.id).toBeTruthy()
    await p.dispose()
  })

  it('returns no hits for an empty query and caps at maxSearchResults', async () => {
    const p = configured({ watch: false, maxSearchResults: 1 })
    await p.write(input({ title: 'One' }), globalDir())
    await p.write(input({ title: 'Two' }), globalDir())
    expect(await p.search('   ', undefined, [globalDir()])).toEqual([])
    const hits = await p.search('vitest', undefined, [globalDir()])
    expect(hits).toHaveLength(1)
    await p.dispose()
  })

  it('stops after the cap is reached and skips later chain directories', async () => {
    const p = configured({ watch: false, maxSearchResults: 1 })
    await p.write(input({ title: 'Project hit' }), projectDir())
    await p.write(input({ title: 'Global hit' }), globalDir())
    const hits = await p.search('vitest', undefined, chain())
    expect(hits).toHaveLength(1)
    expect(hits[0]?.scope).toBe('project')
    await p.dispose()
  })

  it('validates an explicit limit and honors it below the config cap', async () => {
    const p = provider(false)
    await p.write(input({ title: 'One' }), globalDir())
    await p.write(input({ title: 'Two' }), globalDir())
    await expect(p.search('vitest', { limit: 0 }, [globalDir()])).rejects.toThrow('limit must be a positive integer')
    expect(await p.search('vitest', { limit: 1 }, [globalDir()])).toHaveLength(1)
    await p.dispose()
  })
})

describe('LocalMemoryProvider traverse', () => {
  it('walks outgoing and incoming links with resolution and dangling marks', async () => {
    const p = provider(false)
    const target = await p.write(input({ title: 'Target' }), globalDir())
    const source = await p.write(input({ title: 'Source', content: 'See [[Target]] and [[Missing]].', related: ['Target'] }), globalDir())
    const traversal = await p.traverse(source.id, undefined, [globalDir()])
    expect(traversal.start.title).toBe('Source')
    const byTitle = Object.fromEntries(traversal.nodes.map(node => [node.title, node]))
    expect(byTitle['Target']?.via).toEqual({ kind: 'related', direction: 'out' })
    expect(byTitle['Missing']?.via).toEqual({ kind: 'wikilink', direction: 'out' })
    expect(byTitle['Missing']?.id).toBeUndefined()
    const backlinks = await p.traverse(target.id, undefined, [globalDir()])
    expect(backlinks.nodes.map(node => node.title)).toEqual(['Source', 'Source'])
    expect(backlinks.nodes[0]?.via).toEqual({ kind: 'wikilink', direction: 'in' })
    expect(backlinks.nodes[1]?.via).toEqual({ kind: 'related', direction: 'in' })
    await p.dispose()
  })

  it('filters kinds, honors depth, and truncates at the node cap', async () => {
    const p = configured({ watch: false, maxTraverseNodes: 2 })
    await p.write(input({ title: 'A' }), globalDir())
    await p.write(input({ title: 'B', content: '[[A]]', related: ['A'] }), globalDir())
    const wikilinkOnly = await p.traverse('B', { kinds: ['wikilink'] }, [globalDir()])
    expect(wikilinkOnly.nodes.map(node => node.title)).toEqual(['A'])
    expect(wikilinkOnly.truncated).toBe(false)

    await p.write(input({ title: 'C', content: '[[B]]' }), globalDir())
    await p.write(input({ title: 'D', content: '[[B]]' }), globalDir())
    const truncated = await p.traverse('B', { depth: 1 }, [globalDir()])
    expect(truncated.truncated).toBe(true)
    expect(truncated.nodes).toHaveLength(2)

    const relatedOnly = await p.traverse('B', { kinds: ['related'] }, [globalDir()])
    expect(relatedOnly.nodes.map(node => node.via)).toEqual([{ kind: 'related', direction: 'out' }])

    const deep = await p.traverse('C', { depth: 2 }, [globalDir()])
    expect(deep.nodes.some(node => node.title === 'A')).toBe(true)
    await p.dispose()
  })

  it('rejects invalid depth and kinds, and misses with NOT_FOUND', async () => {
    const p = provider(false)
    await expect(p.traverse('n1', { depth: 3 as never }, [globalDir()])).rejects.toThrow('depth must be 1 or 2')
    await expect(p.traverse('n1', { kinds: ['other' as never] }, [globalDir()])).rejects.toThrow('unknown link kind')
    await expect(p.traverse('missing', undefined, [globalDir()])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await p.dispose()
  })

  it('deduplicates edges reached over multiple paths', async () => {
    const p = provider(false)
    await p.write(input({ title: 'C' }), globalDir())
    await p.write(input({ title: 'B', content: '[[C]]' }), globalDir())
    await p.write(input({ title: 'A', content: '[[B]] [[C]]' }), globalDir())
    const traversal = await p.traverse('A', { depth: 2 }, [globalDir()])
    expect(traversal.nodes.filter(node => node.title === 'C')).toHaveLength(1)
    await p.dispose()
  })

  it('truncates when the cap is hit while collecting backlinks', async () => {
    const p = configured({ watch: false, maxTraverseNodes: 2 })
    await p.write(input({ title: 'A' }), globalDir())
    await p.write(input({ title: 'C', content: '[[A]]' }), globalDir())
    await p.write(input({ title: 'D', content: '[[A]]' }), globalDir())
    const traversal = await p.traverse('A', undefined, [globalDir()])
    expect(traversal.truncated).toBe(true)
    expect(traversal.nodes).toHaveLength(2)
    await p.dispose()
  })

  it('returns empty adjacency for an isolated note', async () => {
    const p = provider(false)
    const note = await p.write(input({ title: 'Isolated' }), globalDir())
    const traversal = await p.traverse(note.id, { depth: 2 }, [globalDir()])
    expect(traversal.nodes).toEqual([])
    expect(traversal.truncated).toBe(false)
    await p.dispose()
  })

  it('reports dangling related targets on read', async () => {
    const p = provider(false)
    const note = await p.write(input({ title: 'Linker', related: ['Nope'] }), globalDir())
    const read = await p.read(note.id, [globalDir()])
    expect(read.related).toEqual([{ title: 'Nope' }])
    await p.dispose()
  })

  it('resolves related targets to ids on read', async () => {
    const p = provider(false)
    const target = await p.write(input({ title: 'Real' }), globalDir())
    const linker = await p.write(input({ title: 'Linker2', related: ['Real'] }), globalDir())
    const read = await p.read(linker.id, [globalDir()])
    expect(read.related).toEqual([{ id: target.id, title: 'Real' }])
    await p.dispose()
  })
})

describe('LocalMemoryProvider adoption and reconciliation', () => {
  it('adopts plain and frontmatter-less markdown as searchable memory on open', async () => {
    await mkdir(join(globalDir(), 'notes'), { recursive: true })
    await mkdir(join(globalDir(), 'journal'), { recursive: true })
    await writeFile(join(globalDir(), 'notes', 'existing.md'), 'Raw adopted knowledge about radishes.\n', 'utf8')
    await writeFile(join(globalDir(), 'journal', '2026-08-18.md'), '# Day one\nTried [[existing]] today.\n', 'utf8')
    const p = provider(false)
    const hits = await p.search('radishes', undefined, [globalDir()])
    expect(hits[0]?.title).toBe('existing')
    const journal = await p.search('Tried', undefined, [globalDir()])
    expect(journal[0]?.title).toBe('2026-08-18')
    const adopted = await p.read('existing', [globalDir()])
    expect(adopted.body).toContain('radishes')
    await p.dispose()
  })

  it('reconciles external edits through the watcher and deletion through scans', async () => {
    const { impl, handles } = fakeWatch()
    const p = new LocalMemoryProvider(resolveConfig({ watch: true, debounceMs: 5 }), impl)
    const written = await p.write(input(), globalDir())
    const path = join(globalDir(), written.path)
    await writeFile(path, await readFile(path, 'utf8').then(text => text.replace('vitest', 'jest')), 'utf8')
    handles[0]!.emit('all', 'change', path)
    await new Promise(resolve => setTimeout(resolve, 15))
    expect((await p.read(written.id, [globalDir()])).body).toContain('jest')

    await rm(path)
    handles[0]!.emit('all', 'unlink', path)
    await new Promise(resolve => setTimeout(resolve, 15))
    await expect(p.read(written.id, [globalDir()])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await p.dispose()
    expect(handles[0]!.closed).toBe(true)
  })

  it('re-checks mtimes on read even without a watcher', async () => {
    const p = provider(false)
    const written = await p.write(input(), globalDir())
    const path = join(globalDir(), written.path)
    await writeFile(path, await readFile(path, 'utf8').then(text => text.replace('vitest', 'jest')), 'utf8')
    expect((await p.read(written.id, [globalDir()])).body).toContain('jest')
    await p.dispose()
  })

  it('drops index rows for files deleted while unobserved', async () => {
    const p = provider(false)
    const written = await p.write(input(), globalDir())
    await rm(join(globalDir(), written.path))
    await expect(p.read(written.id, [globalDir()])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await p.dispose()
  })

  it('ignores .obsidian contents during scans', async () => {
    await mkdir(join(globalDir(), '.obsidian'), { recursive: true })
    await writeFile(join(globalDir(), '.obsidian', 'workspace.md'), 'secret obsidian config', 'utf8')
    const p = provider(false)
    expect(await p.search('secret', undefined, [globalDir()])).toEqual([])
    await p.dispose()
  })
})

describe('LocalMemoryProvider lifecycle', () => {
  it('keeps data across provider unload and remount', async () => {
    const first = provider(false)
    const written = await first.write(input(), globalDir())
    await first.dispose()
    const second = provider(false)
    expect((await second.read(written.id, [globalDir()])).title).toBe('My note')
    await second.dispose()
  })
})

describe('apply and config', () => {
  it('registers into the memory service and unregisters on plugin fiber disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryService, { dir: globalDir() })
    const fiber = ctx.plugin({ name, inject, apply }, { watch: true })
    await fiber
    await ctx.memory.write(input(), undefined)
    expect((await ctx.memory.read('My note', undefined)).title).toBe('My note')
    await fiber.dispose()
    await expect(ctx.memory.read('x', undefined)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await ctx.fiber.dispose()
  })

  it('validates numeric config loudly', () => {
    expect(() => resolveConfig({ debounceMs: 0 })).toThrow('debounceMs must be a positive integer')
    expect(() => resolveConfig({ maxSearchResults: 1.5 })).toThrow('maxSearchResults must be a positive integer')
    expect(() => resolveConfig({ maxTraverseNodes: -1 })).toThrow('maxTraverseNodes must be a positive integer')
    expect(resolveConfig({})).toEqual({ watch: true, debounceMs: 100, maxSearchResults: 20, maxTraverseNodes: 50 })
    expect(resolveConfig({ watch: false, debounceMs: 7, maxSearchResults: 3, maxTraverseNodes: 4 }))
      .toEqual({ watch: false, debounceMs: 7, maxSearchResults: 3, maxTraverseNodes: 4 })
    expect(resolveConfig(undefined as never)).toEqual({ watch: true, debounceMs: 100, maxSearchResults: 20, maxTraverseNodes: 50 })
  })

  it('supports constructor defaults without a watcher factory', async () => {
    const p = new LocalMemoryProvider(resolveConfig({ watch: false }))
    const written = await p.write(input(), globalDir())
    expect((await p.read(written.id, [globalDir()])).title).toBe('My note')
    silentWarn()
    await p.dispose()
  })
})

describe('extractWikiLinks', () => {
  it('extracts plain and aliased wikilinks, skipping empties', () => {
    expect(extractWikiLinks('[[a]] and [[b|alias]] and [[ ]]')).toEqual(['a', 'b'])
    expect(extractWikiLinks('no links')).toEqual([])
  })
})
