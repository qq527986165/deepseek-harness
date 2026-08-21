import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { buildInjectionText, loadInjectionPieces, renderInjection } from '../src/inject.ts'
import type { InjectedCatalogEntry, InjectedPersona } from '../src/inject.ts'

const PERSONA = (scope: 'project' | 'global', text: string): InjectedPersona => ({
  kind: 'persona',
  scope,
  dir: `C:/vaults/${scope}`,
  path: 'MEMORY.md',
  text,
})

const ENTRY = (scope: 'project' | 'global', title: string, overrides: Partial<InjectedCatalogEntry> = {}): InjectedCatalogEntry => ({
  kind: 'catalog',
  scope,
  dir: `C:/vaults/${scope}`,
  path: `notes/${title.toLowerCase().replaceAll(' ', '-')}.md`,
  title,
  tags: [],
  updated: 1,
  excerpt: 'Body.',
  ...overrides,
})

function fakeMemory(overrides: Record<string, unknown> = {}) {
  return {
    resolveScopes: vi.fn(async () => ['project', 'global']),
    readPersona: vi.fn(async (scope: 'project' | 'global') => PERSONA(scope, `Persona of ${scope}.`)),
    list: vi.fn(async (scope: 'project' | 'global') => ({
      dir: `C:/vaults/${scope}`,
      scope,
      notes: scope === 'project'
        ? [{ id: 'n1', path: 'notes/recent.md', title: 'Recent', tags: ['a'], updated: 1, excerpt: 'Body.', persona: false }]
        : [{ id: 'n2', path: 'notes/global.md', title: 'Global note', tags: [], updated: 2, excerpt: 'More.', persona: false }],
    })),
    ...overrides,
  }
}

describe('loadInjectionPieces', () => {
  it('loads both personas in scope order plus each scope note catalog', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    const pieces = await loadInjectionPieces(ctx, 'C:/work/proj')
    expect(pieces?.map(piece => piece.path)).toEqual(['MEMORY.md', 'MEMORY.md', 'notes/recent.md', 'notes/global.md'])
    expect(pieces?.map(piece => piece.scope)).toEqual(['project', 'global', 'project', 'global'])
    expect(pieces?.[2]).toMatchObject({ kind: 'catalog', title: 'Recent', tags: ['a'], updated: 1, excerpt: 'Body.' })
    await ctx.fiber.dispose()
  })

  it('skips empty persona files and loads an empty catalog for a bare vault', async () => {
    const ctx = new Context()
    const memory = fakeMemory({
      resolveScopes: vi.fn(async () => ['global']),
      readPersona: vi.fn(async (scope: 'project' | 'global') => scope === 'global' ? PERSONA('global', 'Global.') : PERSONA('project', '   ')),
      list: vi.fn(async () => ({ dir: 'C:/vaults/global', scope: 'global', notes: [] })),
    })
    ctx.provide('memory', memory)
    const pieces = await loadInjectionPieces(ctx, undefined)
    expect(pieces?.map(piece => piece.scope)).toEqual(['global'])
    expect(pieces?.length).toBe(1)
    await ctx.fiber.dispose()
  })

  it('returns undefined when nothing exists to inject', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory({
      readPersona: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ dir: 'd', scope: 'project', notes: [] })),
    }))
    await expect(loadInjectionPieces(ctx, 'C:/work/proj')).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('renderInjection', () => {
  it('renders personas then the note catalog with structured fields', () => {
    const text = renderInjection([
      PERSONA('project', 'Project rules.'),
      PERSONA('global', 'Global identity.'),
      ENTRY('project', 'Vitest setup', { tags: ['testing'], updated: 1_754_006_400_000, excerpt: 'We use vitest.' }),
      ENTRY('global', 'Other', { excerpt: 'More facts.' }),
    ])
    expect(text).toBe([
      'Memory context',
      '',
      '## Persona (project)',
      '',
      'Project rules.',
      '',
      '## Persona (global)',
      '',
      'Global identity.',
      '',
      '## Memory note catalog',
      '',
      '### Vitest setup (project)',
      'Tags: testing',
      'Updated: 2025-08-01',
      'We use vitest.',
      '',
      '### Other (global)',
      'Tags: (none)',
      'Updated: 1970-01-01',
      'More facts.',
    ].join('\n'))
  })
})

describe('buildInjectionText', () => {
  it('returns the complete text with refs under the byte cap', () => {
    const pieces = [PERSONA('global', 'Hello.')]
    const built = buildInjectionText(pieces, 10_000)
    expect(built?.text).toBe('Memory context\n\n## Persona (global)\n\nHello.')
    expect(built?.refs).toEqual([{ scope: 'global', dir: 'C:/vaults/global', path: 'MEMORY.md' }])
  })

  it('carries catalog entry titles in refs', () => {
    const built = buildInjectionText([PERSONA('global', 'P.'), ENTRY('project', 'Vitest')], 10_000)
    expect(built?.refs).toEqual([
      { scope: 'global', dir: 'C:/vaults/global', path: 'MEMORY.md' },
      { scope: 'project', dir: 'C:/vaults/project', path: 'notes/vitest.md', title: 'Vitest' },
    ])
  })

  it('returns undefined for an empty piece list', () => {
    expect(buildInjectionText([], 100)).toBeUndefined()
  })

  it('caps the complete text including the marker and keeps all refs', () => {
    const pieces = [PERSONA('global', 'A long persona text about preferences.')]
    const built = buildInjectionText(pieces, 64)
    expect(built?.text.endsWith('(truncated: memory context exceeded the injection byte cap)')).toBe(true)
    expect(Buffer.byteLength(built?.text ?? '', 'utf8')).toBeLessThanOrEqual(64)
    expect(built?.refs).toHaveLength(1)
  })

  it('cuts multibyte text on a UTF-8 character boundary', () => {
    const pieces = [PERSONA('global', '你好世界'.repeat(8))]
    const built = buildInjectionText(pieces, 80)
    const text = built?.text ?? ''
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(80)
    expect(() => Buffer.from(text, 'utf8').toString('utf8')).not.toThrow()
    expect(text.includes('\uFFFD')).toBe(false)
  })
})
