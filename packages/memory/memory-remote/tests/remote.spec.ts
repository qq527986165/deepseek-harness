import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryError, MemoryNoteId } from '@deepseek-ai/dsh-memory'
import type { MemoryNote } from '@deepseek-ai/dsh-memory'
import { MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import MemoryRemoteService, { MemoryReviewRemoteService } from '../src/index.ts'

const CWD = 'C:/work/proj'

function fakeMemory(overrides: Record<string, unknown> = {}) {
  return {
    info: vi.fn(() => ({ globalDir: 'C:/home/memory' })),
    list: vi.fn(async () => ({ dir: 'C:/home/memory', scope: 'global', notes: [] })),
    readInScope: vi.fn(async () => {
      throw new MemoryError('no match', 'NOT_FOUND')
    }),
    searchInScope: vi.fn(async () => []),
    write: vi.fn(async () => ({ id: MemoryNoteId('w1'), scope: 'global', title: 'T', path: 'notes/t.md', created: 'c', updated: 'u' })),
    delete: vi.fn(async () => ({ id: MemoryNoteId('d1'), scope: 'project', title: 'T', path: 'notes/t.md', trashPath: 'C:/trash/t.md' })),
    ...overrides,
  }
}

function note(id: string, title: string, body: string): MemoryNote {
  return {
    id: MemoryNoteId(id),
    scope: 'project',
    title,
    path: `notes/${id}.md`,
    tags: ['a'],
    body,
    updated: 1,
    related: [{ title: 'Other' }],
    backlinks: [],
  }
}

/** A live-session agent paired with a registry that knows only it. */
function agentWith(events: (session: Session) => void = () => {}): { agent: Agent; registry: (id: unknown) => Agent | undefined } {
  const id = SessionId('remote-session')
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd: CWD,
  })
  events(session)
  const agent = { id, session } as unknown as Agent
  const registry = (candidate: unknown): Agent | undefined => candidate === id ? agent : undefined
  return { agent, registry }
}

async function mounted(memory = fakeMemory()): Promise<{ ctx: Context; memory: ReturnType<typeof fakeMemory> }> {
  const ctx = new Context()
  ctx.provide('memory', memory)
  ctx.provide('agents', { get: () => undefined })
  await ctx.plugin(MemoryRemoteService)
  return { ctx, memory }
}

/** Read one mounted service instance from the test context. */
function remoteOf(ctx: Context): MemoryRemoteService {
  return ctx.get('memoryRemote') as MemoryRemoteService
}

describe('MemoryRemoteService', () => {
  it('exposes both namespaces and registers the review service beside itself', async () => {
    const { ctx } = await mounted()
    expect(remoteOf(ctx)).toBeInstanceOf(MemoryRemoteService)
    expect(ctx.get('memoryReview')).toBeInstanceOf(MemoryReviewRemoteService)
    await ctx.fiber.dispose()
  })

  it('serves info straight from the memory service', async () => {
    const { ctx, memory } = await mounted()
    expect(remoteOf(ctx).info()).toEqual({ globalDir: 'C:/home/memory' })
    expect(memory.info).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('maps list requests onto the service with optional limits', async () => {
    const { ctx, memory } = await mounted()
    const remote = remoteOf(ctx)
    await remote.list({ scope: 'global' })
    expect(memory.list).toHaveBeenCalledWith('global', undefined, undefined)
    await remote.list({ scope: 'project', workspaceDir: CWD, limit: 3 })
    expect(memory.list).toHaveBeenLastCalledWith('project', CWD, { limit: 3 })
    await ctx.fiber.dispose()
  })

  it('maps read and search requests onto the single-vault primitives', async () => {
    const { ctx, memory } = await mounted(fakeMemory({ readInScope: vi.fn(async () => note('n1', 'N', 'B')) }))
    const remote = remoteOf(ctx)
    await remote.read({ ref: 'n1', scope: 'project', workspaceDir: CWD })
    expect(memory.readInScope).toHaveBeenCalledWith('n1', 'project', CWD)
    await remote.search({ query: 'tea', scope: 'global' })
    expect(memory.searchInScope).toHaveBeenCalledWith('tea', undefined, 'global', undefined)
    await remote.search({ query: 'tea', scope: 'project', workspaceDir: CWD, limit: 5 })
    expect(memory.searchInScope).toHaveBeenLastCalledWith('tea', { limit: 5 }, 'project', CWD)
    await ctx.fiber.dispose()
  })

  it('maps write requests with and without optional fields', async () => {
    const { ctx, memory } = await mounted()
    const remote = remoteOf(ctx)
    await remote.write({ scope: 'project', title: 'T', content: 'C', workspaceDir: CWD })
    expect(memory.write).toHaveBeenCalledWith({ scope: 'project', title: 'T', content: 'C' }, CWD)
    await remote.write({
      id: MemoryNoteId('n1'), scope: 'global', title: 'T', content: 'C',
      tags: ['a'], related: ['B'],
    })
    expect(memory.write).toHaveBeenLastCalledWith({
      id: MemoryNoteId('n1'), scope: 'global', title: 'T', content: 'C', tags: ['a'], related: ['B'],
    }, undefined)
    await ctx.fiber.dispose()
  })

  it('maps delete requests onto the service', async () => {
    const { ctx, memory } = await mounted()
    await remoteOf(ctx).delete({ ref: 'n1', scope: 'project', workspaceDir: CWD })
    expect(memory.delete).toHaveBeenCalledWith('n1', 'project', CWD)
    await ctx.fiber.dispose()
  })
})

describe('MemoryReviewRemoteService.decide', () => {
  const review = (session: Session) => {
    session.append('request/header', { header: { config: { provider: 'deepseek', model: 'm' } }, reason: 'initial' })
    session.append('memory/review', {
      reviewId: MemoryReviewId('review-1'),
      candidates: [
        { id: MemoryNoteId('p1'), title: 'Coffee', snippet: 'Prefers tea.', reason: 'User-wide.' },
        { id: MemoryNoteId('p2'), title: 'Setup', snippet: 'Vitest.', reason: 'Project.' },
      ],
      workspaceDir: CWD,
    })
  }

  async function reviewService(memory = fakeMemory()) {
    const ctx = new Context()
    ctx.provide('memory', memory)
    const service = new MemoryReviewRemoteService(ctx)
    return { ctx, service, memory }
  }

  it('requires the exact live agent before touching the log', async () => {
    const { ctx, service } = await reviewService()
    const { agent, registry } = agentWith()
    ctx.provide('agents', { get: vi.fn((id: unknown) => registry(id)) })
    const stranger = { id: SessionId('other'), session: agent.session } as unknown as Agent
    await expect(service.decide(stranger, MemoryReviewId('review-1'), { accepted: [], rejected: [] }))
      .rejects.toThrow('is not live in this registry')
    await ctx.fiber.dispose()
  })

  it('fails review-not-found when the session log has no matching review', async () => {
    const { ctx, service } = await reviewService()
    const { agent, registry } = agentWith()
    ctx.provide('agents', { get: (id: unknown) => registry(id) })
    const result = await service.decide(agent, MemoryReviewId('ghost'), { accepted: [], rejected: [] })
    expect(result).toEqual({ ok: false, error: { code: 'review-not-found', reviewId: 'ghost' } })
    await ctx.fiber.dispose()
  })

  it('fails review-decided when the review is already settled', async () => {
    const { ctx, service } = await reviewService()
    const { agent, registry } = agentWith((session) => {
      review(session)
      session.append('memory/review-decided', {
        reviewId: MemoryReviewId('review-1'),
        accepted: [],
        rejected: [MemoryNoteId('p1'), MemoryNoteId('p2')],
      })
    })
    ctx.provide('agents', { get: (id: unknown) => registry(id) })
    const result = await service.decide(agent, MemoryReviewId('review-1'), {
      accepted: [MemoryNoteId('p1')],
      rejected: [MemoryNoteId('p2')],
    })
    expect(result).toEqual({ ok: false, error: { code: 'review-decided', reviewId: 'review-1' } })
    await ctx.fiber.dispose()
  })

  it('rejects unknown, duplicate, and undecided candidate sets', async () => {
    const cases: Array<{ decisions: { accepted: string[]; rejected: string[] }; error: Record<string, unknown> }> = [
      {
        decisions: { accepted: ['ghost'], rejected: ['p1', 'p2'] },
        error: { code: 'unknown-candidate', reviewId: 'review-1', id: 'ghost' },
      },
      {
        decisions: { accepted: ['p1', 'p1'], rejected: ['p2'] },
        error: { code: 'duplicate-candidate', reviewId: 'review-1', id: 'p1' },
      },
      {
        decisions: { accepted: ['p1'], rejected: [] },
        error: { code: 'undecided-candidates', reviewId: 'review-1', ids: ['p2'] },
      },
    ]
    for (const entry of cases) {
      const { ctx, service } = await reviewService()
      const { agent, registry } = agentWith(review)
      ctx.provide('agents', { get: (id: unknown) => registry(id) })
      const result = await service.decide(agent, MemoryReviewId('review-1'), entry.decisions as never)
      expect(result).toEqual({ ok: false, error: entry.error })
      await ctx.fiber.dispose()
    }
  })

  it('promotes accepted notes write-first then removes the project file, and lands the settlement', async () => {
    const { ctx, service, memory } = await reviewService(fakeMemory({
      readInScope: vi.fn(async (id: string) => note(id, 'Coffee', 'Prefers tea.')),
    }))
    const { agent, registry } = agentWith(review)
    ctx.provide('agents', { get: (id: unknown) => registry(id) })

    const result = await service.decide(agent, MemoryReviewId('review-1'), {
      accepted: [MemoryNoteId('p1')],
      rejected: [MemoryNoteId('p2')],
    })
    expect(result).toEqual({
      ok: true,
      value: {
        reviewId: 'review-1',
        accepted: [{ id: 'p1', title: 'Coffee', globalId: 'w1' }],
        rejected: ['p2'],
      },
    })
    expect(memory.write).toHaveBeenCalledWith({
      scope: 'global',
      title: 'Coffee',
      content: 'Prefers tea.',
      tags: ['a'],
      related: ['Other'],
    }, undefined)
    expect(memory.delete).toHaveBeenCalledWith('p1', 'project', CWD, undefined, { mode: 'permanent' })

    const settled = agent.session.events.findLast(event => event.type === 'memory/review-decided')
    expect(settled?.type === 'memory/review-decided' && settled.data).toMatchObject({
      reviewId: 'review-1',
      accepted: [{ id: 'p1', title: 'Coffee', globalId: 'w1' }],
      rejected: ['p2'],
    })
    await ctx.fiber.dispose()
  })

  it('fails note-missing when an accepted note no longer resolves in the project vault', async () => {
    const { ctx, service } = await reviewService(fakeMemory({
      readInScope: vi.fn(async () => {
        throw new MemoryError('gone', 'NOT_FOUND')
      }),
    }))
    const { agent, registry } = agentWith(review)
    ctx.provide('agents', { get: (id: unknown) => registry(id) })
    const result = await service.decide(agent, MemoryReviewId('review-1'), {
      accepted: [MemoryNoteId('p1')],
      rejected: [MemoryNoteId('p2')],
    })
    expect(result).toEqual({ ok: false, error: { code: 'note-missing', reviewId: 'review-1', id: 'p1' } })
    expect(agent.session.events.some(event => event.type === 'memory/review-decided')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('propagates non-NOT_FOUND read failures instead of guessing', async () => {
    const { ctx, service } = await reviewService(fakeMemory({
      readInScope: vi.fn(async () => {
        throw new MemoryError('outside workspace', 'NO_PROJECT_SCOPE')
      }),
    }))
    const { agent, registry } = agentWith(review)
    ctx.provide('agents', { get: (id: unknown) => registry(id) })
    await expect(service.decide(agent, MemoryReviewId('review-1'), {
      accepted: [MemoryNoteId('p1')],
      rejected: [MemoryNoteId('p2')],
    })).rejects.toMatchObject({ code: 'NO_PROJECT_SCOPE' })
    await ctx.fiber.dispose()
  })

  it('serializes concurrent decisions per session', async () => {
    let releaseWrite: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const memory = fakeMemory({
      readInScope: vi.fn(async (id: string) => note(id, 'Coffee', 'Prefers tea.')),
      write: vi.fn(async () => {
        await gate
        return { id: MemoryNoteId('w1'), scope: 'global', title: 'T', path: 'notes/t.md', created: 'c', updated: 'u' }
      }),
    })
    const { ctx, service } = await reviewService(memory)
    const { agent, registry } = agentWith(review)
    ctx.provide('agents', { get: (id: unknown) => registry(id) })

    const first = service.decide(agent, MemoryReviewId('review-1'), {
      accepted: [MemoryNoteId('p1')],
      rejected: [MemoryNoteId('p2')],
    })
    const second = service.decide(agent, MemoryReviewId('review-1'), {
      accepted: [MemoryNoteId('p1')],
      rejected: [MemoryNoteId('p2')],
    })
    let secondSettled = false
    void second.then((result) => {
      secondSettled = true
      expect(result).toEqual({ ok: false, error: { code: 'review-decided', reviewId: 'review-1' } })
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(secondSettled).toBe(false)

    releaseWrite()
    await first
    await second
    expect(secondSettled).toBe(true)
    await ctx.fiber.dispose()
  })
})
