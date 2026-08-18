import { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryError } from '@deepseek-ai/dsh-memory'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index.ts'

const GLOBAL_DIR = 'C:/vaults/global'

function createSession(id: string, cwd?: string): SessionType {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
    ...(cwd === undefined ? {} : { cwd }),
  })
}

/** A fake agent whose inject() records messages and whose session is the given one. */
function fakeAgent(ctx: Context, session: SessionType): Agent & { injected: UserMessage[] } {
  const scope = ctx.plugin(() => {})
  const injected: UserMessage[] = []
  const value: Agent & { injected: UserMessage[] } = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    send: () => {},
    inject: (message: UserMessage) => { injected.push(message) },
    injected,
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return value
}

/** Scripted memory service the lifecycle consumes. */
function fakeMemory(overrides: Record<string, unknown> = {}) {
  return {
    resolveScopes: vi.fn(async () => ['global']),
    readPersona: vi.fn(async () => ({ dir: GLOBAL_DIR, path: 'MEMORY.md', text: 'Global persona text.' })),
    recent: vi.fn(async () => ({ dir: 'C:/vaults/project', notes: [] })),
    readInScope: vi.fn(async () => {
      throw new MemoryError('no match', 'NOT_FOUND')
    }),
    write: vi.fn(async (input: { id?: string; scope: string; title: string }) => ({
      id: input.id ?? 'n1',
      scope: input.scope as 'project' | 'global',
      title: input.title,
      path: `notes/${input.title.toLowerCase().replaceAll(' ', '-')}.md`,
      created: 'c',
      updated: 'u',
    })),
    appendJournal: vi.fn(async () => ({ path: 'journal/2026-08-18.md', date: '2026-08-18' })),
    ...overrides,
  }
}

/** Scripted auxiliary LLM yielding one distillation JSON reply. */
function fakeLlm() {
  return {
    stream: vi.fn(async function* () {
      yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
      yield {
        type: 'block-end' as const,
        index: 0,
        block: {
          type: 'text' as const,
          text: JSON.stringify({
            notes: [{ scope: 'global', title: 'Learned fact', content: 'A new durable fact.', tags: [], related: [] }],
            journal: { title: 'Turn summary', body: '- Did work touching [[Learned fact]].' },
          }),
        },
      }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }),
  }
}

async function harness(
  config: Record<string, unknown> = {},
  overrides: { memory?: Record<string, unknown>; llm?: Record<string, unknown> } = {},
) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  const memory = fakeMemory(overrides.memory ?? {})
  const llm = overrides.llm === undefined ? fakeLlm() : overrides.llm
  ctx.provide('memory', memory)
  ctx.provide('llm', llm)
  const fiber = ctx.plugin({ name, inject, apply }, config)
  await fiber
  return { ctx, memory, llm, fiber }
}

describe('memory-lifecycle plugin', () => {
  it('declares its identity and injects the memory, llm, and systemPrompt services', () => {
    expect(name).toBe('@deepseek-ai/dsh-memory-lifecycle')
    expect(inject).toEqual(['memory', 'llm', 'systemPrompt'])
  })

  it('registers the guidance section and removes it on disposal', async () => {
    const { ctx, fiber } = await harness()
    expect(() => ctx.systemPrompt.section({ name: 'tool:memory', order: 999, text: 'x' })).toThrow()
    await fiber.dispose()
    expect(() => ctx.systemPrompt.section({ name: 'tool:memory', order: 999, text: 'x' })).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('injects persona context on agent/session-start and logs memory/inject', async () => {
    const { ctx } = await harness()
    const session = createSession('inject-agent')
    const agent = fakeAgent(ctx, session)

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'startup' })
    await vi.waitFor(() => { expect(agent.injected).toHaveLength(1) })

    expect(agent.injected[0]?.content[0]).toMatchObject({ type: 'text' })
    const text = agent.injected[0]!.content.find(block => block.type === 'text')
    expect(text?.type === 'text' && text.text).toContain('## Persona (global)')
    expect(text?.type === 'text' && text.text).toContain('Global persona text.')

    const injectEvent = session.events.findLast(event => event.type === 'memory/inject')
    expect(injectEvent?.type === 'memory/inject' && injectEvent.data).toMatchObject({
      reason: 'start',
      notes: [{ scope: 'global', dir: GLOBAL_DIR, path: 'MEMORY.md' }],
    })
    expect(injectEvent?.type === 'memory/inject' && injectEvent.data.bytes).toBeGreaterThan(0)
    await ctx.fiber.dispose()
  })

  it('reloads injected context only when a loaded file changes', async () => {
    const { ctx, memory } = await harness()
    const session = createSession('reload-agent')
    const agent = fakeAgent(ctx, session)

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'startup' })
    await vi.waitFor(() => { expect(agent.injected).toHaveLength(1) })

    ctx.emit('memory/change', { dir: GLOBAL_DIR, paths: ['notes/unrelated.md'] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.injected).toHaveLength(1)

    memory.readPersona.mockResolvedValue({ dir: GLOBAL_DIR, path: 'MEMORY.md', text: 'Updated persona.' })
    ctx.emit('memory/change', { dir: GLOBAL_DIR, paths: ['MEMORY.md'] })
    await vi.waitFor(() => { expect(agent.injected).toHaveLength(2) })

    const second = agent.injected[1]!.content.find(block => block.type === 'text')
    expect(second?.type === 'text' && second.text).toContain('Updated persona.')
    const reloadEvent = session.events.findLast(event => event.type === 'memory/inject')
    expect(reloadEvent?.type === 'memory/inject' && reloadEvent.data.reason).toBe('change')
    await ctx.fiber.dispose()
  })

  it('treats an empty watcher batch as a full recheck and skips identical content', async () => {
    const { ctx } = await harness()
    const session = createSession('recheck-agent')
    const agent = fakeAgent(ctx, session)

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'startup' })
    await vi.waitFor(() => { expect(agent.injected).toHaveLength(1) })

    ctx.emit('memory/change', { dir: GLOBAL_DIR, paths: [] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.injected).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('forgets a session on disposal and stops reloading it', async () => {
    const { ctx } = await harness()
    const session = createSession('disposed-agent')
    const agent = fakeAgent(ctx, session)

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'startup' })
    await vi.waitFor(() => { expect(agent.injected).toHaveLength(1) })

    ctx.emit('session/disposed', session)
    ctx.emit('memory/change', { dir: GLOBAL_DIR, paths: ['MEMORY.md'] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.injected).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('distills every finished turn and logs the write record', async () => {
    const { ctx, memory } = await harness()
    const session = createSession('distill-agent')
    ctx.sessions.enter(session)

    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: { provider: 'deepseek', model: 'main-model' } }, reason: 'initial' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Please remember that I prefer green tea over coffee.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(session.events.some(event => event.type === 'memory/distill')).toBe(true) })

    expect(memory.write).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'global', title: 'Learned fact', content: 'A new durable fact.',
    }), undefined)
    expect(memory.appendJournal).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'global', title: 'Turn summary',
    }), undefined)

    const distill = session.events.findLast(event => event.type === 'memory/distill')
    expect(distill?.type === 'memory/distill' && distill.data).toMatchObject({
      turn: 1,
      model: { provider: 'deepseek', model: 'main-model' },
      notes: [{ action: 'create', scope: 'global', title: 'Learned fact' }],
      journal: { scope: 'global', path: 'journal/2026-08-18.md' },
    })
    expect(distill?.type === 'memory/distill' && distill.data.turn).toBe(end.data.turn)
    await ctx.fiber.dispose()
  })

  it('honors the distill off switch', async () => {
    const { ctx, llm } = await harness({ distill: false })
    const session = createSession('quiet-agent')
    ctx.sessions.enter(session)

    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: { provider: 'deepseek', model: 'main-model' } }, reason: 'initial' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'A turn with plenty of characters to distill.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(llm.stream).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('unloads every listener on plugin disposal', async () => {
    const { ctx, fiber, memory } = await harness()
    const session = createSession('unload-agent')
    const agent = fakeAgent(ctx, session)
    ctx.sessions.enter(session)

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'startup' })
    await vi.waitFor(() => { expect(agent.injected).toHaveLength(1) })
    await fiber.dispose()

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'resume' })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Another turn after disposal with plenty of text.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.injected).toHaveLength(1)
    expect(memory.write).not.toHaveBeenCalled()
    expect(session.events.some(event => event.type === 'memory/distill')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('skips injection entirely when nothing exists to load', async () => {
    const { ctx } = await harness({}, {
      memory: {
        readPersona: vi.fn(async () => undefined),
        recent: vi.fn(async () => ({ dir: 'C:/vaults/project', notes: [] })),
      },
    })
    const session = createSession('empty-agent')
    const agent = fakeAgent(ctx, session)

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'startup' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.injected).toHaveLength(0)
    expect(session.events.some(event => event.type === 'memory/inject')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('contains a failing session-start load without injecting', async () => {
    const { ctx } = await harness({}, {
      memory: { readPersona: vi.fn(async () => { throw new Error('vault unreadable') }) },
    })
    const session = createSession('failing-agent')
    const agent = fakeAgent(ctx, session)

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'startup' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.injected).toHaveLength(0)
    expect(session.events.some(event => event.type === 'memory/inject')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('skips queued work when disposal lands before it runs', async () => {
    const { ctx, fiber } = await harness()
    const session = createSession('queued-agent')
    const agent = fakeAgent(ctx, session)

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'startup' })
    await fiber.dispose()
    expect(agent.injected).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('drops an injection that resolves after disposal', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let atGate = false
    const { ctx, fiber } = await harness({}, {
      memory: {
        readPersona: vi.fn(async () => {
          atGate = true
          await gate
          return { dir: GLOBAL_DIR, path: 'MEMORY.md', text: 'Late persona.' }
        }),
      },
    })
    const session = createSession('late-agent')
    const agent = fakeAgent(ctx, session)

    emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'startup' })
    await vi.waitFor(() => { expect(atGate).toBe(true) })
    const disposal = fiber.dispose()
    release()
    await disposal
    expect(agent.injected).toHaveLength(0)
    expect(session.events.some(event => event.type === 'memory/inject')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('warns when a distillation pass fails while active', async () => {
    const warns: string[] = []
    const { ctx } = await harness({}, {
      llm: {
        stream: vi.fn(async function* () {
          throw new Error('provider down')
        }),
      },
    })
    vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')) })
    const session = createSession('warn-agent')
    ctx.sessions.enter(session)

    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: { provider: 'deepseek', model: 'main-model' } }, reason: 'initial' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'A turn long enough to attempt a full distillation pass.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(warns.some(message => message.includes('memory distillation failed'))).toBe(true) })
    await ctx.fiber.dispose()
  })

  it('drains in-flight distillation and stays silent after disposal', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let atGate = false
    const { ctx, fiber } = await harness({}, {
      memory: {
        appendJournal: vi.fn(async () => {
          atGate = true
          await gate
          throw new Error('late failure')
        }),
      },
    })
    const session = createSession('drain-agent')
    ctx.sessions.enter(session)

    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: { provider: 'deepseek', model: 'main-model' } }, reason: 'initial' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'A turn long enough to attempt a full distillation pass.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(atGate).toBe(true) })
    const disposal = fiber.dispose()
    release()
    await disposal
    expect(session.events.some(event => event.type === 'memory/distill')).toBe(false)
    await ctx.fiber.dispose()
  })
})
