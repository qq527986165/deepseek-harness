import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MemoryError, MemoryNoteId } from '@deepseek-ai/dsh-memory'
import type { MemoryNote } from '@deepseek-ai/dsh-memory'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { DISTILL_INSTRUCTION, runDistill, resolveDistillRoute, turnMessages, turnTextLength, mergeNote } from '../src/distill.ts'
import type { DistillTarget } from '../src/distill.ts'

const PROVIDER = 'deepseek'
const MODEL = 'aux-model'

/** One finished turn in a fresh session: request header, prompt, and answer. */
function finishedTurnSession(turn = 1, prompt = 'Please set up vitest for this project.'): { session: Session; end: SessionEvent<'turn/end'> } {
  const session = Session.create(SessionId(`distill-${turn}-${prompt.length}`))
  session.append('turn/start', { turn })
  session.append('request/header', { header: { config: { provider: PROVIDER, model: MODEL } }, reason: 'initial' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Done: vitest is configured.' }],
      source: { provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  const end = session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { session, end }
}

/** A scripted auxiliary stream yielding one JSON reply. */
function fakeLlm(reply: string, error?: Error) {
  return {
    stream: vi.fn(async function* (options: GenerateOptions) {
      captured.push(options)
      if (error !== undefined) {
        yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { message: error.message, code: 'FAKE' } } }
        return
      }
      yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
      yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: reply } }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }),
  }
}

const captured: GenerateOptions[] = []

const NOTE: MemoryNote = {
  id: MemoryNoteId('n1'),
  scope: 'project',
  title: 'Existing',
  path: 'notes/existing.md',
  tags: ['old'],
  body: 'Old facts.',
  related: [{ title: 'Old link' }],
  backlinks: [],
}

function fakeMemory(overrides: Record<string, unknown> = {}) {
  return {
    resolveScopes: vi.fn(async () => ['project', 'global']),
    readInScope: vi.fn(async () => {
      throw new MemoryError('no match', 'NOT_FOUND')
    }),
    write: vi.fn(async (input: { id?: string; scope: string; title: string }) => ({
      id: input.id ?? MemoryNoteId('fresh'),
      scope: input.scope as 'project' | 'global',
      title: input.title,
      path: `notes/${input.title.toLowerCase().replaceAll(' ', '-')}.md`,
      created: 't0',
      updated: 't1',
    })),
    appendJournal: vi.fn(async (input: { title: string }) => ({ path: 'journal/2026-08-18.md', date: '2026-08-18', title: input.title })),
    ...overrides,
  }
}

function target(session: Session, end: SessionEvent<'turn/end'>, signal: AbortSignal = new AbortController().signal): DistillTarget {
  return { session, cwd: undefined, turn: end.data.turn, endSeq: end.seq, signal }
}

beforeEach(() => {
  captured.length = 0
})

describe('turnMessages and turnTextLength', () => {
  it('collects one turn surface messages between its boundaries', () => {
    const { session, end } = finishedTurnSession()
    const messages = turnMessages(session, end.seq)
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(turnTextLength(messages)).toBeGreaterThan(10)
  })

  it('returns an empty list when no turn/start precedes the end seq', () => {
    const session = Session.create(SessionId('no-turn-start'))
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(turnMessages(session, end.seq)).toEqual([])
  })

  it('counts only text blocks toward the minimum turn length', () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'thinking that must not count' },
        { type: 'text', text: 'ab cd' },
      ],
      source: { provider: PROVIDER, model: MODEL },
    })
    expect(turnTextLength([assistant])).toBe(4)
    expect(turnTextLength([])).toBe(0)
  })
})

describe('resolveDistillRoute', () => {
  it('prefers the explicit config pair and falls back to the logged request route', () => {
    const { session } = finishedTurnSession()
    expect(resolveDistillRoute(resolveConfig({ provider: 'x', model: 'y' }), session)).toEqual({ provider: 'x', model: 'y' })
    expect(resolveDistillRoute(resolveConfig(), session)).toEqual({ provider: PROVIDER, model: MODEL })
  })

  it('returns undefined without either source or with an empty header route', () => {
    const session = Session.create(SessionId('routeless'))
    expect(resolveDistillRoute(resolveConfig(), session)).toBeUndefined()
    session.append('request/header', { header: { config: { provider: '', model: '' } }, reason: 'initial' })
    expect(resolveDistillRoute(resolveConfig(), session)).toBeUndefined()
  })
})

describe('mergeNote', () => {
  it('appends new facts and unions tags and related links', () => {
    const merged = mergeNote(NOTE, { scope: 'project', title: 'Existing', content: 'New fact.', tags: ['new', 'old'], related: ['Fresh'] })
    expect(merged?.body).toBe('Old facts.\n\nNew fact.')
    expect(merged?.tags).toEqual(['old', 'new'])
    expect(merged?.related).toEqual(['Old link', 'Fresh'])
  })

  it('skips related links and tags that already exist', () => {
    const merged = mergeNote(NOTE, {
      scope: 'project',
      title: 'Existing',
      content: 'New fact.',
      tags: ['old', 'another'],
      related: ['Old link', 'Fresh'],
    })
    expect(merged?.tags).toEqual(['old', 'another'])
    expect(merged?.related).toEqual(['Old link', 'Fresh'])
  })

  it('writes nothing for a pure restatement', () => {
    expect(mergeNote(NOTE, { scope: 'project', title: 'Existing', content: ' Old facts. ', tags: [], related: [] })).toBeUndefined()
  })
})

describe('runDistill', () => {
  it('writes candidates, appends the journal, and records the write in memory/distill', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({
      notes: [
        { scope: 'project', title: 'Vitest setup', content: 'We use vitest for tests.', tags: ['testing'], related: ['User prefers tea'] },
        { scope: 'global', title: 'User prefers tea', content: 'Drinks green tea.', tags: [], related: [] },
      ],
      journal: { title: 'Set up tests', body: '- Configured [[Vitest setup]].' },
    })
    const memory = fakeMemory()
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()

    await runDistill(ctx, resolveConfig(), target(session, end))

    expect(memory.write).toHaveBeenCalledTimes(2)
    expect(memory.write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scope: 'project', title: 'Vitest setup', content: 'We use vitest for tests.', tags: ['testing'],
    }), undefined)
    expect(memory.write).toHaveBeenNthCalledWith(2, expect.objectContaining({ scope: 'global', title: 'User prefers tea' }), undefined)
    expect(memory.appendJournal).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'project', title: 'Set up tests', body: '- Configured [[Vitest setup]].',
    }), undefined)

    const replay = captured[0]!
    expect(replay.purpose).toBe('memory-distill')
    expect(replay.maxTokens).toBe(1024)
    expect(replay.messages.at(-1)?.content[0]).toMatchObject({ type: 'text', text: DISTILL_INSTRUCTION })

    const distill = session.events.findLast(event => event.type === 'memory/distill')
    expect(distill?.type === 'memory/distill' && distill.data).toMatchObject({
      turn: 1,
      model: { provider: PROVIDER, model: MODEL },
      notes: [
        { action: 'create', scope: 'project', title: 'Vitest setup', path: 'notes/vitest-setup.md' },
        { action: 'create', scope: 'global', title: 'User prefers tea' },
      ],
      journal: { scope: 'project', path: 'journal/2026-08-18.md', date: '2026-08-18', title: 'Set up tests' },
    })
    await ctx.fiber.dispose()
  })

  it('routes a project-classified candidate to the global vault without a project scope', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({
      notes: [{ scope: 'project', title: 'Personal fact', content: 'Lives in Beijing.', tags: [], related: [] }],
      journal: { title: 'Day', body: '- b' },
    })
    const memory = fakeMemory({ resolveScopes: vi.fn(async () => ['global']) })
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()

    await runDistill(ctx, resolveConfig(), target(session, end))

    expect(memory.write).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }), undefined)
    expect(memory.appendJournal).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }), undefined)
    await ctx.fiber.dispose()
  })

  it('merges into an existing note and skips pure restatements', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({
      notes: [
        { scope: 'project', title: 'Existing', content: 'New fact.', tags: ['new'], related: [] },
        { scope: 'project', title: 'Existing', content: 'Old facts.', tags: [], related: [] },
      ],
      journal: { title: 'Day', body: '- b' },
    })
    const memory = fakeMemory({
      readInScope: vi.fn(async (title: string) => title === 'Existing' ? NOTE : Promise.reject(new MemoryError('no', 'NOT_FOUND'))),
    })
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()

    await runDistill(ctx, resolveConfig(), target(session, end))

    expect(memory.write).toHaveBeenCalledTimes(1)
    expect(memory.write).toHaveBeenCalledWith(expect.objectContaining({
      id: MemoryNoteId('n1'), scope: 'project', content: 'Old facts.\n\nNew fact.',
    }), undefined)
    const distill = session.events.findLast(event => event.type === 'memory/distill')
    expect(distill?.type === 'memory/distill' && distill.data.notes).toEqual([
      expect.objectContaining({ action: 'merge', id: 'n1' }),
    ])
    await ctx.fiber.dispose()
  })

  it('records committed notes with the error when the journal append fails', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({
      notes: [{ scope: 'global', title: 'Fact', content: 'Something.', tags: [], related: [] }],
      journal: { title: 'Day', body: '- b' },
    })
    const memory = fakeMemory({ appendJournal: vi.fn(async () => { throw new Error('disk full') }) })
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()

    await runDistill(ctx, resolveConfig(), target(session, end))

    const distill = session.events.findLast(event => event.type === 'memory/distill')
    expect(distill?.type === 'memory/distill' && distill.data).toMatchObject({
      notes: [{ action: 'create', title: 'Fact' }],
      error: 'Error: disk full',
    })
    expect(distill?.type === 'memory/distill' && distill.data.journal).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('throws without writing when the auxiliary route is unresolvable', async () => {
    const ctx = new Context()
    const memory = fakeMemory()
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm('{}'))
    const session = Session.create(SessionId('routeless'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a prompt with enough characters' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await expect(runDistill(ctx, resolveConfig(), target(session, end))).rejects.toThrow('no auxiliary route')
    expect(memory.write).not.toHaveBeenCalled()
    expect(session.events.some(event => event.type === 'memory/distill')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('skips too-short turns without calling the model', async () => {
    const ctx = new Context()
    const memory = fakeMemory()
    ctx.provide('memory', memory)
    const llm = fakeLlm('{}')
    ctx.provide('llm', llm)
    const { session, end } = finishedTurnSession(1, 'hi')

    await runDistill(ctx, resolveConfig(), target(session, end))

    expect(llm.stream).not.toHaveBeenCalled()
    expect(session.events.some(event => event.type === 'memory/distill')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('propagates an aborted signal and a failing auxiliary call without an event', async () => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    ctx.provide('llm', fakeLlm('{}', new Error('provider down')))
    const { session, end } = finishedTurnSession()

    await expect(runDistill(ctx, resolveConfig(), target(session, end))).rejects.toThrow('provider down')
    expect(session.events.some(event => event.type === 'memory/distill')).toBe(false)

    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(runDistill(ctx, resolveConfig(), target(session, end, controller.signal))).rejects.toThrow('stopped')
    await ctx.fiber.dispose()
  })

  it('rejects invalid model output before writing anything', async () => {
    const ctx = new Context()
    const memory = fakeMemory()
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm('{"notes":"wrong"}'))
    const { session, end } = finishedTurnSession()

    await expect(runDistill(ctx, resolveConfig(), target(session, end))).rejects.toThrow('requires a notes array')
    expect(memory.write).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('throws when nothing committed and the journal append fails', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({ notes: [], journal: { title: 'Day', body: '- b' } })
    const memory = fakeMemory({ appendJournal: vi.fn(async () => { throw new Error('disk full') }) })
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()

    await expect(runDistill(ctx, resolveConfig(), target(session, end))).rejects.toThrow('disk full')
    expect(session.events.some(event => event.type === 'memory/distill')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('rejects a reply with no JSON value and tool-call blocks', async () => {
    const noJson = new Context()
    noJson.provide('memory', fakeMemory())
    noJson.provide('llm', fakeLlm('nothing to extract here'))
    const first = finishedTurnSession()
    await expect(runDistill(noJson, resolveConfig(), target(first.session, first.end))).rejects.toThrow('contains no JSON object')
    await noJson.fiber.dispose()

    const toolCall = new Context()
    toolCall.provide('memory', fakeMemory())
    toolCall.provide('llm', {
      stream: vi.fn(async function* () {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'memory_read', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }),
    })
    const second = finishedTurnSession()
    await expect(runDistill(toolCall, resolveConfig(), target(second.session, second.end))).rejects.toThrow('text only')
    await toolCall.fiber.dispose()
  })

  it.each([
    [{ kind: 'max-tokens' }, 'reached maxDistillTokens'],
    [{ kind: 'tool-calls' }, 'unexpectedly requested a tool'],
    [{ kind: 'unknown' }, 'unsupported finish reason "unknown"'],
  ])('translates the %s finish reason into a loud failure', async (finish, message) => {
    const ctx = new Context()
    ctx.provide('memory', fakeMemory())
    ctx.provide('llm', {
      stream: vi.fn(async function* () {
        yield { type: 'finish', reason: finish }
      }),
    })
    const { session, end } = finishedTurnSession()
    await expect(runDistill(ctx, resolveConfig(), target(session, end))).rejects.toThrow(message)
    expect(session.events.some(event => event.type === 'memory/distill')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('replays the routed system and tool prefix for cache reuse', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({ notes: [], journal: { title: 'Day', body: '- b' } })
    const memory = fakeMemory()
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()
    session.append('request/header', {
      header: {
        config: { provider: PROVIDER, model: MODEL },
        system: 'the session system prompt',
        tools: [{ name: 'memory_search', description: 'Search memory.', parameters: {} }],
      },
      reason: 'change',
    })

    await runDistill(ctx, resolveConfig(), target(session, end))

    const replay = captured[0]!
    expect(replay.system).toBe('the session system prompt')
    expect(replay.tools).toEqual([{ name: 'memory_search', description: 'Search memory.', parameters: {} }])
    await ctx.fiber.dispose()
  })

  it('propagates non-NOT_FOUND lookup failures', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({
      notes: [{ scope: 'global', title: 'Fact', content: 'Something.', tags: [], related: [] }],
      journal: { title: 'Day', body: '- b' },
    })
    const memory = fakeMemory({
      readInScope: vi.fn(async () => { throw new MemoryError('no memory provider is registered', 'NO_PROVIDER') }),
    })
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()

    await expect(runDistill(ctx, resolveConfig(), target(session, end))).rejects.toThrow('no memory provider')
    expect(session.events.some(event => event.type === 'memory/distill')).toBe(false)
    await ctx.fiber.dispose()
  })
})
