import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory'
import { describe, expect, it, vi } from 'vitest'
import { MemoryReviewId } from '../src/types.ts'
import type { MemoryDistillEventData, MemoryDistillJournalWrite, MemoryDistillNoteWrite, MemoryReviewDecidedEventData, MemoryReviewEventData } from '../src/types.ts'
import { apply, inject, name } from '../src/invariant.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin({ name, inject, apply })
  return ctx
}

const validNote = (overrides: Record<string, unknown> = {}): MemoryDistillNoteWrite => ({
  id: 'n1', scope: 'project', title: 'T', path: 'notes/t-a1b2c3d4.md', journalAnchor: '^memory-a1b2c3d4-project', ...overrides,
})

const validJournal = (overrides: Record<string, unknown> = {}): MemoryDistillJournalWrite => ({
  scope: 'project', path: 'journal/2026-08-18.md', date: '2026-08-18', title: 'Day', anchor: '^memory-a1b2c3d4-project', ...overrides,
})

/** A well-formed memory/distill commit receipt. */
const valid = (overrides: Record<string, unknown> = {}): MemoryDistillEventData => ({
  turn: 1,
  notes: [validNote()],
  journals: [validJournal()],
  model: { provider: 'deepseek', model: 'm' },
  ...overrides,
})

/** A well-formed memory/review proposal. */
const validReview = (overrides: Record<string, unknown> = {}): MemoryReviewEventData => ({
  reviewId: MemoryReviewId('review-1'),
  candidates: [{ id: MemoryNoteId('p1'), title: 'Coffee', snippet: 'Prefers tea.', reason: 'User-wide.' }],
  workspaceDir: 'C:/work/proj',
  ...overrides,
})

/** A well-formed memory/review-decided settlement. */
const validDecided = (overrides: Record<string, unknown> = {}): MemoryReviewDecidedEventData => ({
  reviewId: MemoryReviewId('review-1'),
  accepted: [{ id: MemoryNoteId('p1'), title: 'Coffee', globalId: MemoryNoteId('g1') }],
  rejected: [MemoryNoteId('p2')],
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

  it('accepts well-formed commit receipts and ignores other event types', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('memory/distill', valid())
    session.append('memory/distill', {
      turn: 2,
      notes: [{
        id: 'n2', scope: 'global', title: 'T2', path: 'notes/t2-a1b2c3d4.md', journalAnchor: '^memory-deadbeef-global',
        previous: { id: 'n1', title: 'T1', path: 'notes/t1-a1b2c3d4.md' },
      }],
      journals: [{ scope: 'global', path: 'journal/2026-08-19.md', date: '2026-08-19', title: 'Global day', anchor: '^memory-deadbeef-global' }],
      model: { provider: 'deepseek', model: 'm' },
    })
    await ctx.fiber.dispose()
  })

  it.each([
    ['a non-object payload', 'payload must be an object', 'nope'],
    ['a non-positive turn', 'turn must be a positive safe integer', valid({ turn: 0 })],
    ['a non-array notes field', 'notes must be an array', valid({ notes: 'x' })],
    ['an empty notes field', 'notes must be non-empty', valid({ notes: [] })],
    ['a non-object note write', 'each memory/distill note write must be an object', valid({ notes: ['x'] })],
    ['an empty note id', 'note id must be a non-empty string', valid({ notes: [validNote({ id: '' })] })],
    ['an invalid note scope', 'note scope must be project or global', valid({ notes: [validNote({ scope: 'local' })] })],
    ['an empty note title', 'note title must be a non-empty string', valid({ notes: [validNote({ title: '' })] })],
    ['a note path outside the distill format', 'note path must be notes/<summary>-<short-id>.md', valid({ notes: [validNote({ path: 'notes/t.md' })] })],
    ['a note anchor with the wrong scope', 'journalAnchor must name its scope', valid({ notes: [validNote({ journalAnchor: '^memory-a1b2c3d4-global' })] })],
    ['a malformed journal anchor', 'journal anchor must name its scope', valid({ journals: [validJournal({ anchor: '^memory-a' })] })],
    ['a legacy note action', 'note action is not part', valid({ notes: [validNote({ action: 'create' })] })],
    ['a non-object previous note', 'previous must be an object', valid({ notes: [validNote({ previous: null })] })],
    ['a non-string previous path', 'previous path must live under notes/', valid({ notes: [validNote({ previous: { id: 'p', title: 'P', path: 1 } })] })],
    ['a malformed previous note', 'previous path must live under notes/', valid({ notes: [validNote({ previous: { id: 'p', title: 'P', path: 'journal/p.md' } })] })],
    ['a non-array journals field', 'journals must be an array', valid({ journals: 'x' })],
    ['an empty journals field', 'journals must be non-empty', valid({ journals: [] })],
    ['a non-object journal', 'journal must be an object', valid({ journals: ['x'] })],
    ['an invalid journal scope', 'journal scope must be project or global', valid({ journals: [validJournal({ scope: 'local' })] })],
    ['a malformed journal path', 'journal path must be journal/<date>.md', valid({ journals: [validJournal({ path: 'notes/t.md' })] })],
    ['a malformed journal date', 'journal date must be YYYY-MM-DD', valid({ journals: [validJournal({ date: '' })] })],
    ['a mismatched journal date', 'journal path must match its date', valid({ journals: [validJournal({ date: '2026-08-19' })] })],
    ['an empty journal title', 'journal title must be a non-empty string', valid({ journals: [validJournal({ title: '' })] })],
    ['a mismatched note anchor', 'journalAnchor must match', valid({ notes: [validNote({ journalAnchor: '^memory-deadbeef-project' })] })],
    ['duplicate note ids', 'note ids must be unique', valid({ notes: [validNote(), validNote({ path: 'notes/other-deadbeef.md' })] })],
    ['duplicate note paths', 'note paths must be unique', valid({ notes: [validNote(), validNote({ id: 'n2' })] })],
    ['duplicate journal scopes', 'journals must contain one entry per scope', valid({ journals: [validJournal(), validJournal()] })],
    ['mismatched journal scopes', 'journal scopes must match note scopes', valid({ journals: [validJournal({ scope: 'global', anchor: '^memory-a1b2c3d4-global' })] })],
    ['a legacy partial field', 'legacy partial fields are not allowed', valid({ error: 'partial' })],
    ['a non-object model route', 'model must be an object', valid({ model: 'x' })],
    ['an empty model route', 'model must name a non-empty provider and model', valid({ model: { provider: '', model: 'm' } })],
  ])('rejects %s', async (_label, message, data) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    expect(() => { session.append('memory/distill', data as never) }).toThrow(message)
    await ctx.fiber.dispose()
  })

  it('accepts well-formed review proposals and settlements', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('memory/review', validReview())
    session.append('memory/review', validReview({ candidates: [] }))
    session.append('memory/review-decided', validDecided())
    session.append('memory/review-decided', validDecided({ accepted: [], rejected: [] }))
    await ctx.fiber.dispose()
  })

  it.each([
    ['a non-object proposal', 'memory/review payload must be an object', 'nope'],
    ['an empty reviewId', 'memory/review reviewId must be a non-empty string', validReview({ reviewId: '' })],
    ['a non-array candidates field', 'memory/review candidates must be an array', validReview({ candidates: 'x' })],
    ['an empty workspaceDir', 'memory/review workspaceDir must be a non-empty string', validReview({ workspaceDir: '' })],
    ['a non-object candidate', 'each memory/review candidate must be an object', validReview({ candidates: ['x'] })],
    ['an empty candidate id', 'memory/review candidate id must be a non-empty string', validReview({ candidates: [{ id: '', title: 'T', snippet: 's', reason: 'r' }] })],
    ['an empty candidate title', 'memory/review candidate title must be a non-empty string', validReview({ candidates: [{ id: 'p1', title: '', snippet: 's', reason: 'r' }] })],
    ['a non-string snippet', 'memory/review candidate snippet must be a string', validReview({ candidates: [{ id: 'p1', title: 'T', snippet: 3, reason: 'r' }] })],
    ['an empty candidate reason', 'memory/review candidate reason must be a non-empty string', validReview({ candidates: [{ id: 'p1', title: 'T', snippet: 's', reason: '' }] })],
  ])('rejects a malformed review proposal: %s', async (_label, message, data) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => { session.append('memory/review', data as never) }).toThrow(message)
    await ctx.fiber.dispose()
  })

  it.each([
    ['a non-object settlement', 'memory/review-decided payload must be an object', 'nope'],
    ['an empty settlement reviewId', 'memory/review-decided reviewId must be a non-empty string', validDecided({ reviewId: '' })],
    ['a non-array accepted field', 'memory/review-decided accepted must be an array', validDecided({ accepted: 'x' })],
    ['a non-object accepted entry', 'each memory/review-decided accepted entry must be an object', validDecided({ accepted: ['x'] })],
    ['a malformed accepted entry', 'memory/review-decided accepted globalId must be a non-empty string', validDecided({ accepted: [{ id: 'p1', title: 'T', globalId: '' }] })],
    ['a non-array rejected field', 'memory/review-decided rejected must be an array', validDecided({ rejected: 'x' })],
    ['an empty rejected id', 'memory/review-decided rejected id must be a non-empty string', validDecided({ rejected: [''] })],
  ])('rejects a malformed review settlement: %s', async (_label, message, data) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => { session.append('memory/review-decided', data as never) }).toThrow(message)
    await ctx.fiber.dispose()
  })
})
