import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { buildInjectionText, loadInjectionPieces, renderInjection } from '../src/inject.ts'
import type { InjectedPiece } from '../src/inject.ts'

const PERSONA = (scope: 'project' | 'global', text: string): InjectedPiece => ({
  scope,
  dir: `C:/vaults/${scope}`,
  path: 'MEMORY.md',
  text,
})

const NOTE = (title: string, body: string): InjectedPiece => ({
  scope: 'project',
  dir: 'C:/vaults/project',
  path: `notes/${title.toLowerCase().replaceAll(' ', '-')}.md`,
  title,
  text: body,
})

function fakeMemory(overrides: Record<string, unknown> = {}) {
  return {
    resolveScopes: vi.fn(async () => ['project', 'global']),
    readPersona: vi.fn(async (scope: 'project' | 'global') => PERSONA(scope, `Persona of ${scope}.`)),
    recent: vi.fn(async () => ({ dir: 'C:/vaults/project', notes: [{ path: 'notes/recent.md', title: 'Recent', body: 'Body.', updated: 1 }] })),
    ...overrides,
  }
}

describe('loadInjectionPieces', () => {
  it('loads both personas in scope order plus the project recency window', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    const pieces = await loadInjectionPieces(ctx, 'C:/work/proj', resolveConfig())
    expect(pieces?.map(piece => piece.path)).toEqual(['MEMORY.md', 'MEMORY.md', 'notes/recent.md'])
    expect(pieces?.map(piece => piece.scope)).toEqual(['project', 'global', 'project'])
    await ctx.fiber.dispose()
  })

  it('skips empty persona files and global-only sessions skip recency', async () => {
    const ctx = new Context()
    const memory = fakeMemory({
      resolveScopes: vi.fn(async () => ['global']),
      readPersona: vi.fn(async (scope: 'project' | 'global') => scope === 'global' ? PERSONA('global', 'Global.') : PERSONA('project', '   ')),
    })
    ctx.provide('memory', memory)
    const pieces = await loadInjectionPieces(ctx, undefined, resolveConfig())
    expect(pieces?.map(piece => piece.scope)).toEqual(['global'])
    expect(memory.recent).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('returns undefined when nothing exists to inject', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory({ readPersona: vi.fn(async () => undefined), recent: vi.fn(async () => ({ dir: 'd', notes: [] })) }))
    await expect(loadInjectionPieces(ctx, 'C:/work/proj', resolveConfig())).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('renderInjection', () => {
  it('renders personas then a recency section, journal never included', () => {
    const text = renderInjection([
      PERSONA('project', 'Project rules.'),
      PERSONA('global', 'Global identity.'),
      NOTE('Vitest setup', 'We use vitest.'),
      NOTE('Other', 'More facts.'),
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
      '## Recent project notes',
      '',
      '### Vitest setup',
      'We use vitest.',
      '',
      '### Other',
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

  it('carries topic-note titles in refs', () => {
    const built = buildInjectionText([PERSONA('global', 'P.'), NOTE('Vitest', 'Body.')], 10_000)
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
