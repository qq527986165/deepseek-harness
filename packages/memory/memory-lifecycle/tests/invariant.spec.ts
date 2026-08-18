import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import type { MemoryDistillEventData } from '../src/types.ts'
import { apply, inject, name } from '../src/invariant.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin({ name, inject, apply })
  return ctx
}

/** A well-formed memory/distill write record. */
const valid = (overrides: Record<string, unknown> = {}): MemoryDistillEventData => ({
  turn: 1,
  notes: [{ id: 'n1', scope: 'project', title: 'T', path: 'notes/t.md', action: 'create' }],
  journal: { scope: 'project', path: 'journal/2026-08-18.md', date: '2026-08-18', title: 'Day' },
  model: { provider: 'deepseek', model: 'm' },
  ...overrides,
})

describe('memory-lifecycle invariant companion', () => {
  it('declares its identity and registers the package invariant', async () => {
    const disposer = vi.fn(() => {})
    const register = vi.fn(() => disposer)
    const ctx = new Context()
    ctx.provide('invariants', { register })
    const installed = await apply(ctx)
    expect(name).toBe('memory-lifecycle-invariant')
    expect(inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-memory-lifecycle', expect.any(Function))
    installed()
    expect(disposer).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('accepts well-formed write records and ignores other event types', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('memory/distill', valid())
    session.append('memory/distill', valid({
      notes: [],
      journal: { scope: 'global', path: 'journal/2026-08-19.md', date: '2026-08-19', title: 'Global day' },
    }))
    session.append('memory/distill', {
      turn: 2,
      notes: [{ id: 'n2', scope: 'global', title: 'T2', path: 'notes/t2.md', action: 'merge' }],
      model: { provider: 'deepseek', model: 'm' },
      error: 'partial commit',
    })
    await ctx.fiber.dispose()
  })

  it.each([
    ['a non-object payload', 'payload must be an object', 'nope'],
    ['a non-positive turn', 'turn must be a positive safe integer', valid({ turn: 0 })],
    ['a non-array notes field', 'notes must be an array', valid({ notes: 'x' })],
    ['a non-object note write', 'each memory/distill note write must be an object', valid({ notes: ['x'] })],
    ['an empty note id', 'note id must be a non-empty string', valid({ notes: [{ id: '', scope: 'project', title: 'T', path: 'notes/t.md', action: 'create' }] })],
    ['an invalid note scope', 'note scope must be project or global', valid({ notes: [{ id: 'n', scope: 'local', title: 'T', path: 'notes/t.md', action: 'create' }] })],
    ['an empty note title', 'note title must be a non-empty string', valid({ notes: [{ id: 'n', scope: 'project', title: '', path: 'notes/t.md', action: 'create' }] })],
    ['a note path outside notes/', 'note path must live under notes/', valid({ notes: [{ id: 'n', scope: 'project', title: 'T', path: 'journal/t.md', action: 'create' }] })],
    ['an invalid note action', 'note action must be create or merge', valid({ notes: [{ id: 'n', scope: 'project', title: 'T', path: 'notes/t.md', action: 'delete' }] })],
    ['a non-object journal', 'journal must be an object', valid({ journal: 'x' })],
    ['an invalid journal scope', 'journal scope must be project or global', valid({ journal: { scope: 'local', path: 'journal/2026-08-18.md', date: '2026-08-18', title: 'T' } })],
    ['a malformed journal path', 'journal path must be journal/<date>.md', valid({ journal: { scope: 'project', path: 'notes/t.md', date: '2026-08-18', title: 'T' } })],
    ['a malformed journal date', 'journal date must be YYYY-MM-DD', valid({ journal: { scope: 'project', path: 'journal/2026-08-18.md', date: 'yesterday', title: 'T' } })],
    ['an empty journal title', 'journal title must be a non-empty string', valid({ journal: { scope: 'project', path: 'journal/2026-08-18.md', date: '2026-08-18', title: '' } })],
    ['a non-object model route', 'model must be an object', valid({ model: 'x' })],
    ['an empty model route', 'model must name a non-empty provider and model', valid({ model: { provider: '', model: 'm' } })],
    ['a non-string error field', 'error must be a string', valid({ error: 42 })],
  ])('rejects %s', async (_label, message, data) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    expect(() => { session.append('memory/distill', data as never) }).toThrow(message)
    await ctx.fiber.dispose()
  })
})
