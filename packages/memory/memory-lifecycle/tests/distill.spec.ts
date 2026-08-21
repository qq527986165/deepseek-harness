import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONCISE_INSTRUCTION, DETAILED_INSTRUCTION, distillInstruction, journalDate, runDistill, resolveDistillRoute, turnMessages, turnTextLength } from '../src/distill.ts'
import { resolveConfig } from '../src/config.ts'
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

function fakeMemory(overrides: Record<string, unknown> = {}) {
  return {
    resolveScopes: vi.fn(async () => ['project', 'global']),
    commitDistill: vi.fn(async (groups: Array<{ scope: 'project' | 'global'; date: string; journalTitle: string; notes: Array<{ title: string }> }>) => ({
      notes: groups.flatMap(group => group.notes.map((note, index) => {
        const suffix = `${group.scope}-${index}`
        return {
          id: MemoryNoteId(`${group.scope}-${index}`),
          scope: group.scope,
          title: note.title,
          path: `notes/${note.title.toLowerCase().replaceAll(' ', '-')}-${suffix}.md`,
          created: 't0',
          updated: 't1',
          journalAnchor: `^memory-${suffix}`,
        }
      })),
      journals: groups.map(group => ({
        scope: group.scope,
        path: `journal/${group.date}.md`,
        date: group.date,
        title: group.journalTitle,
        anchor: `^memory-${group.scope}-0`,
      })),
    })),
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

describe('distillInstruction', () => {
  it('pins both fixed instruction texts and selects by mode', () => {
    expect(distillInstruction('concise')).toBe(CONCISE_INSTRUCTION)
    expect(distillInstruction('detailed')).toBe(DETAILED_INSTRUCTION)
    expect(CONCISE_INSTRUCTION).toContain('extract only durable facts')
    expect(DETAILED_INSTRUCTION).toContain('reuse a concise title')
    expect(CONCISE_INSTRUCTION).not.toBe(DETAILED_INSTRUCTION)
    expect(() => distillInstruction('verbose' as never)).toThrow()
  })
})

describe('journalDate', () => {
  it('uses the configured local calendar day across a UTC boundary', () => {
    const epoch = Date.parse('2026-08-20T23:30:00.000Z')
    expect(journalDate(epoch, 'UTC')).toBe('2026-08-20')
    expect(journalDate(epoch, 'Asia/Shanghai')).toBe('2026-08-21')
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

    expect(memory.commitDistill).toHaveBeenCalledWith([
      expect.objectContaining({
        scope: 'project', journalTitle: 'Set up tests',
        notes: [expect.objectContaining({ title: 'Vitest setup', content: 'We use vitest for tests.', tags: ['testing'] })],
      }),
      expect.objectContaining({
        scope: 'global', notes: [expect.objectContaining({ title: 'User prefers tea' })],
      }),
    ], undefined, expect.any(AbortSignal))
    expect(memory.commitDistill.mock.calls[0]?.[0][0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const replay = captured[0]!
    expect(replay.purpose).toBe('memory-distill')
    expect(replay.maxTokens).toBe(2048)
    expect(replay.messages.at(-1)?.content[0]).toMatchObject({ type: 'text', text: CONCISE_INSTRUCTION })

    const distill = session.events.findLast(event => event.type === 'memory/distill')
    expect(distill?.type === 'memory/distill' && distill.data).toMatchObject({
      turn: 1,
      model: { provider: PROVIDER, model: MODEL },
      notes: [
        { scope: 'project', title: 'Vitest setup' },
        { scope: 'global', title: 'User prefers tea' },
      ],
      journals: [
        { scope: 'project', title: 'Set up tests' },
        { scope: 'global', title: 'Set up tests' },
      ],
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

    expect(memory.commitDistill).toHaveBeenCalledWith([
      expect.objectContaining({ scope: 'global', notes: [expect.objectContaining({ title: 'Personal fact' })] }),
    ], undefined, expect.any(AbortSignal))
    await ctx.fiber.dispose()
  })

  it('passes repeated titles as additive candidates instead of reading or merging old nodes', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({
      notes: [
        { scope: 'project', title: 'Existing', content: 'New fact.', tags: ['new'], related: [] },
        { scope: 'project', title: 'Existing', content: 'Old facts.', tags: [], related: [] },
      ],
      journal: { title: 'Day', body: '- b' },
    })
    const memory = fakeMemory()
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()

    await runDistill(ctx, resolveConfig(), target(session, end))

    expect(memory.commitDistill).toHaveBeenCalledWith([
      expect.objectContaining({ notes: [
        expect.objectContaining({ title: 'Existing', content: 'New fact.' }),
        expect.objectContaining({ title: 'Existing', content: 'Old facts.' }),
      ] }),
    ], undefined, expect.any(AbortSignal))
    const distill = session.events.findLast(event => event.type === 'memory/distill')
    expect(distill?.type === 'memory/distill' && distill.data.notes).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('publishes no receipt when the whole-turn commit fails', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({
      notes: [{ scope: 'global', title: 'Fact', content: 'Something.', tags: [], related: [] }],
      journal: { title: 'Day', body: '- b' },
    })
    const memory = fakeMemory({ commitDistill: vi.fn(async () => { throw new Error('disk full') }) })
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()

    await expect(runDistill(ctx, resolveConfig(), target(session, end))).rejects.toThrow('disk full')
    expect(session.events.some(event => event.type === 'memory/distill')).toBe(false)
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
    expect(memory.commitDistill).not.toHaveBeenCalled()
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
    expect(memory.commitDistill).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('writes no node, journal, or receipt when the model returns zero candidates', async () => {
    const ctx = new Context()
    const reply = JSON.stringify({ notes: [], journal: { title: 'Day', body: '- b' } })
    const memory = fakeMemory()
    ctx.provide('memory', memory)
    ctx.provide('llm', fakeLlm(reply))
    const { session, end } = finishedTurnSession()

    await runDistill(ctx, resolveConfig(), target(session, end))
    expect(memory.commitDistill).not.toHaveBeenCalled()
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
})
