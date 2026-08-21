import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { REVIEW_INSTRUCTION, renderReviewCatalog, runReview } from '../src/review.ts'

const PROVIDER = 'deepseek'
const MODEL = 'main-model'

const POOL = [
  { id: MemoryNoteId('p1'), path: 'notes/coffee.md', title: 'Coffee preference', tags: ['identity'], updated: 1_754_006_400_000, excerpt: 'Prefers green tea.', persona: false },
  { id: MemoryNoteId('p2'), path: 'notes/setup.md', title: 'Vitest setup', tags: [], updated: 1_754_006_400_000, excerpt: 'We use vitest.', persona: false },
]

const captured: GenerateOptions[] = []

function fakeLlm(reply: string) {
  return {
    stream: vi.fn(async function* (options: GenerateOptions) {
      captured.push(options)
      yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
      yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: reply } }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }),
  }
}

function fakeMemory(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async () => ({ dir: 'C:/vaults/project', scope: 'project', notes: POOL })),
    ...overrides,
  }
}

function session() {
  const id = SessionId('review-session')
  const value = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd: 'C:/work/proj',
  })
  value.append('request/header', { header: { config: { provider: PROVIDER, model: MODEL } }, reason: 'initial' })
  value.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Initial message.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return value
}

beforeEach(() => {
  captured.length = 0
})

describe('renderReviewCatalog', () => {
  it('renders the exact catalog the model reads ids from', () => {
    expect(renderReviewCatalog(POOL)).toBe([
      'Project memory catalog',
      '',
      '### id: p1',
      'title: Coffee preference',
      'tags: identity',
      'updated: 2025-08-01',
      'Prefers green tea.',
      '',
      '### id: p2',
      'title: Vitest setup',
      'tags: (none)',
      'updated: 2025-08-01',
      'We use vitest.',
    ].join('\n'))
  })

  it('renders an empty catalog heading for an empty pool', () => {
    expect(renderReviewCatalog([])).toBe('Project memory catalog')
  })
})

describe('runReview', () => {
  it('proposes candidates from one auxiliary call and lands memory/review', async () => {
    const ctx = new Context()
    const memory = fakeMemory()
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(JSON.stringify({ candidates: [{ id: 'p1', reason: 'User-wide preference.' }] })))
    const value = session()

    const seq = await runReview(ctx, resolveConfig(), { session: value, cwd: 'C:/work/proj', signal: new AbortController().signal })

    const options = captured[0]!
    expect(options.purpose).toBe('memory-review')
    expect(options.maxTokens).toBe(2048)
    expect(options.messages).toHaveLength(1)
    const text = options.messages[0]!.content.find(block => block.type === 'text')
    expect(text?.type === 'text' && text.text).toBe(`${REVIEW_INSTRUCTION}\n\n${renderReviewCatalog(POOL)}`)

    const event = value.events[seq]
    expect(event?.type === 'memory/review' && event.data).toMatchObject({
      candidates: [{ id: 'p1', title: 'Coffee preference', snippet: 'Prefers green tea.', reason: 'User-wide preference.' }],
      workspaceDir: 'C:/work/proj',
    })
    expect(event?.type === 'memory/review' && typeof event.data.reviewId === 'string' && event.data.reviewId.length).toBeGreaterThan(0)
    await ctx.fiber.dispose()
  })

  it('bounds the candidate set by maxReviewCandidates and deduplicates ids', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    ctx.provide('llm', fakeLlm(JSON.stringify({
      candidates: [
        { id: 'p1', reason: 'First.' },
        { id: 'p1', reason: 'Duplicate.' },
        { id: 'p2', reason: 'Second.' },
      ],
    })))
    const value = session()

    await runReview(ctx, resolveConfig(), { session: value, cwd: 'C:/work/proj', signal: new AbortController().signal })
    let event = value.events.findLast(item => item.type === 'memory/review')
    expect(event?.type === 'memory/review' && event.data.candidates.map(candidate => candidate.id)).toEqual(['p1', 'p2'])
    await ctx.fiber.dispose()

    const capped = new Context()
    capped.provide('memory', fakeMemory())
    capped.provide('llm', fakeLlm(JSON.stringify({
      candidates: [
        { id: 'p1', reason: 'First.' },
        { id: 'p2', reason: 'Second.' },
        { id: 'p2', reason: 'Third.' },
      ],
    })))
    const cappedSession = session()
    await runReview(capped, resolveConfig({ maxReviewCandidates: 2 }), { session: cappedSession, cwd: 'C:/work/proj', signal: new AbortController().signal })
    event = cappedSession.events.findLast(item => item.type === 'memory/review')
    expect(event?.type === 'memory/review' && event.data.candidates.map(candidate => candidate.id)).toEqual(['p1', 'p2'])
    await capped.fiber.dispose()
  })

  it('passes the session system prompt and tools through to the review call', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    ctx.provide('llm', fakeLlm(JSON.stringify({ candidates: [] })))
    const value = Session.create(SessionId('review-header'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('review-header'),
      createdAt: 0,
      cwd: 'C:/work/proj',
    })
    value.append('request/header', {
      header: {
        config: { provider: PROVIDER, model: MODEL },
        system: 'system text',
        tools: [{ name: 'memory_search', description: 'Search memory.', parameters: {} }],
      },
      reason: 'initial',
    })
    value.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Initial message.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await runReview(ctx, resolveConfig(), { session: value, cwd: 'C:/work/proj', signal: new AbortController().signal })

    expect(captured[0]?.system).toBe('system text')
    expect(captured[0]?.tools).toEqual([{ name: 'memory_search', description: 'Search memory.', parameters: {} }])
    await ctx.fiber.dispose()
  })

  it('rejects a reply without a JSON object', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    ctx.provide('llm', fakeLlm('nothing to promote here'))
    const value = session()

    await expect(runReview(ctx, resolveConfig(), { session: value, cwd: 'C:/work/proj', signal: new AbortController().signal }))
      .rejects.toThrow('review output contains no JSON object')
    await ctx.fiber.dispose()
  })

  it('lands an empty proposal when the vault has no topic notes', async () => {
    const ctx = new Context()
    const memory = fakeMemory({ list: vi.fn(async () => ({ dir: 'C:/vaults/project', scope: 'project', notes: [] })) })
    const llm = fakeLlm('unused')
    ctx.provide('memory', memory)
    ctx.provide('llm', llm)
    const value = session()

    await runReview(ctx, resolveConfig(), { session: value, cwd: 'C:/work/proj', signal: new AbortController().signal })

    expect(llm.stream).not.toHaveBeenCalled()
    const event = value.events.findLast(item => item.type === 'memory/review')
    expect(event?.type === 'memory/review' && event.data.candidates).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects a proposed id that is not in the catalog', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    ctx.provide('llm', fakeLlm(JSON.stringify({ candidates: [{ id: 'ghost', reason: 'Unknown.' }] })))
    const value = session()

    await expect(runReview(ctx, resolveConfig(), { session: value, cwd: 'C:/work/proj', signal: new AbortController().signal }))
      .rejects.toThrow('review proposed unknown note id "ghost"')
    expect(value.events.some(event => event.type === 'memory/review')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('fails loudly without an auxiliary route', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    ctx.provide('llm', fakeLlm('unused'))
    const value = Session.create(SessionId('routeless-review'))

    await expect(runReview(ctx, resolveConfig(), { session: value, cwd: undefined, signal: new AbortController().signal }))
      .rejects.toThrow('no auxiliary route for review')
    await ctx.fiber.dispose()
  })

  it('fails loudly without a project workspace once the route resolves', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    ctx.provide('llm', fakeLlm('unused'))
    const value = Session.create(SessionId('workspaceless-review'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('workspaceless-review'),
      createdAt: 0,
    })
    value.append('request/header', { header: { config: { provider: PROVIDER, model: MODEL } }, reason: 'initial' })

    await expect(runReview(ctx, resolveConfig(), { session: value, cwd: undefined, signal: new AbortController().signal }))
      .rejects.toThrow('review requires a project workspace')
    expect(value.events.some(event => event.type === 'memory/review')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('honors an aborted caller signal before any call', async () => {
    const ctx = new Context()
    const memory = fakeMemory()
    const llm = fakeLlm('unused')
    ctx.provide('memory', memory)
    ctx.provide('llm', llm)
    const value = session()
    const controller = new AbortController()
    controller.abort(new Error('caller aborted'))

    await expect(runReview(ctx, resolveConfig(), { session: value, cwd: 'C:/work/proj', signal: controller.signal }))
      .rejects.toThrow('caller aborted')
    expect(memory.list).not.toHaveBeenCalled()
    expect(llm.stream).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
