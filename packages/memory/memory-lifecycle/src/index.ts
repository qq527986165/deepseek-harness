/**
 * Automatic memory lifecycle consumer over the memory capability seam:
 * session-start context injection, every-turn distillation with scope
 * classification and journal appends, the memory/* session events, and the
 * model guidance section. All contributions are effects, so disposing the
 * plugin fiber removes every listener and section registration.
 * @module @deepseek-ai/dsh-memory-lifecycle
 */

import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: the systemPrompt section registration resolves through the seam.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config, resolveConfig } from './config.ts'
import { runDistill } from './distill.ts'
import { buildInjectionText, loadInjectionPieces } from './inject.ts'
import type { InjectedPiece } from './inject.ts'
import type { MemoryInjectReason } from './types.ts'

export { Config, resolveConfig }
export type * from './types.ts'

/** Cordis plugin name, matching the npm package. */
export const name = '@deepseek-ai/dsh-memory-lifecycle'

/** Capability services the lifecycle consumes. */
export const inject = ['memory', 'llm', 'systemPrompt']

/** Guidance section order: the tool guidance band (100-199). */
const SECTION_ORDER = 114

/**
 * The guidance section: when the model should consult memory and when it
 * should write it explicitly, beyond the automatic distillation.
 */
const PROMPT_TEXT =
  'Memory notes hold durable facts, decisions, and preferences across sessions, in project and global vaults. '
  + 'Before assuming you remember past work with this user, call memory_search; use memory_read to load one note. '
  + 'Call memory_write when the user asks you to remember something or a durable fact, decision, or preference lands '
  + 'and has not been written yet. The harness also distills finished turns automatically — do not restate what is '
  + 'already stored.'

/** Per-session state of the last injection, for watcher-driven reloads. */
interface InjectionEntry {
  readonly agent: Agent
  readonly pieces: readonly InjectedPiece[]
  readonly text: string
}

/**
 * Mount the automatic memory lifecycle: the guidance section, session-start
 * injection, watcher-driven reloads of injected files, and every-turn
 * distillation. All asynchronous work is tracked and aborted on disposal.
 * @param ctx - Cordis context carrying the memory, LLM, and system-prompt services.
 * @param config - optional cost and noise controls.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const ownerFiber: Fiber = ctx.fiber
  const lifetime = new AbortController()
  const inFlight = new Set<Promise<unknown>>()
  const injections = new Map<Session, InjectionEntry>()

  const active = (): boolean => !lifetime.signal.aborted
    && ownerFiber.uid !== null
    && ownerFiber.state === FiberState.ACTIVE

  ctx.effect(() => async () => {
    lifetime.abort(new Error('memory-lifecycle disposed'))
    while (inFlight.size > 0) await Promise.allSettled([...inFlight])
  }, 'memory-lifecycle lifecycle')

  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: SECTION_ORDER,
    text: PROMPT_TEXT,
  })

  const defer = (task: () => Promise<void>): void => {
    const run = Promise.resolve().then(async () => {
      if (!active()) return
      await task()
    })
    inFlight.add(run)
    void run.then(
      () => inFlight.delete(run),
      () => inFlight.delete(run),
    )
  }

  const inject = (agent: Agent, reason: MemoryInjectReason): void => {
    const cwd = agent.session.header.cwd
    defer(async () => {
      const pieces = await loadInjectionPieces(ctx, cwd, resolved)
      if (!active()) return
      if (pieces === undefined) {
        injections.delete(agent.session)
        return
      }
      const built = buildInjectionText(pieces, resolved.maxInjectBytes)
      /* v8 ignore next -- a non-empty piece list always renders non-empty text. */
      if (built === undefined) {
        injections.delete(agent.session)
        return
      }
      const previous = injections.get(agent.session)
      if (previous !== undefined && previous.text === built.text) return
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: built.text }],
        source: { kind: 'plugin', plugin: 'dsh-memory-lifecycle' },
      }))
      agent.session.append('memory/inject', {
        reason,
        notes: [...built.refs],
        bytes: Buffer.byteLength(built.text, 'utf8'),
      })
      injections.set(agent.session, { agent, pieces, text: built.text })
    })
  }

  ctx.on('agent/session-start', ({ agent }) => {
    inject(agent, 'start')
  })

  ctx.on('memory/change', ({ dir, paths }) => {
    for (const [, entry] of injections) {
      const touched = entry.pieces.some(piece => piece.dir === dir
        && (paths.length === 0 || paths.includes(piece.path)))
      if (touched) inject(entry.agent, 'change')
    }
  })

  ctx.on('session/disposed', (session) => {
    injections.delete(session)
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || !resolved.distill) return
    const finished = event
    defer(async () => {
      try {
        await runDistill(ctx, resolved, {
          session,
          cwd: session.header.cwd,
          turn: finished.data.turn,
          endSeq: finished.seq,
          signal: lifetime.signal,
        })
      } catch (error: unknown) {
        if (!active()) return
        ctx.logger.warn(`session "${String(session.id)}": memory distillation failed: ${String(error)}`)
      }
    })
  })
}
