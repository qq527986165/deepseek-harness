/**
 * Every-turn distillation: one non-blocking auxiliary LLM call over the
 * finished turn, scope classification, a verified whole-turn memory commit,
 * and the memory/distill receipt.
 * @module @deepseek-ai/dsh-memory-lifecycle/distill
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, assertNever, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { MemoryDistillCommitGroupInput, MemoryScope } from '@deepseek-ai/dsh-memory'
import type { Session } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { DistillMode, ResolvedConfig } from './config.ts'
import { parseDistillOutput } from './parse.ts'
import type { DistillOutput } from './parse.ts'

/** Capability-owned timeout code for one auxiliary distillation call. */
export const MEMORY_DISTILL_TIMEOUT_CODE = 'MEMORY_DISTILL_TIMEOUT'

/**
 * The `concise` distillation directive, delivered as the final user message
 * after the replayed turn so the call is a genuine prefix of the last routed
 * request and reuses the provider's KV cache. One pass emits candidate topic
 * notes, each classified `project` or `global`, plus one journal narrative.
 * The host creates final node ids, paths, journal anchors, and links after the
 * files commit.
 */
export const CONCISE_INSTRUCTION = [
  'Act as the memory distillation engine for this AI coding assistant. Review the conversation ABOVE and extract only durable facts worth remembering across sessions.',
  '',
  'Output a single JSON object, nothing else, with exactly this schema:',
  '{"notes":[{"scope":"project","title":"...","content":"...","tags":[],"related":[]}],"journal":{"title":"...","body":"..."}}',
  '',
  'notes: one candidate per new durable fact cluster — user identity and standing preferences, project decisions, constraints. Classify each candidate: scope "global" ONLY for facts about the user that apply across projects (identity, preferences, cross-project rules); scope "project" for project-specific facts.',
  'content: 1-3 plain sentences stating new facts. Do not write wikilinks; the host will add final links after real files exist. Never restate facts already captured elsewhere: emit a candidate only when it adds something not already written.',
  'journal: one short task narrative for the finished turn. title is the narrative heading; body is markdown bullets stating what happened, without wikilinks and without restating node facts.',
  'Return {"notes":[],"journal":{"title":"...","body":"..."}} when nothing new is worth remembering.',
  'Do NOT mention this request or take any other action. Output only the JSON object.',
].join('\n')

/**
 * The `detailed` distillation directive: the same JSON contract with a more
 * thorough extraction policy — fuller fact coverage and related-note hints.
 */
export const DETAILED_INSTRUCTION = [
  'Act as the memory distillation engine for this AI coding assistant. Review the conversation ABOVE thoroughly and extract every durable fact worth remembering across sessions, including fine-grained decisions, preferences, and constraints.',
  '',
  'Output a single JSON object, nothing else, with exactly this schema:',
  '{"notes":[{"scope":"project","title":"...","content":"...","tags":[],"related":[]}],"journal":{"title":"...","body":"..."}}',
  '',
  'notes: one candidate per durable fact cluster — user identity and standing preferences, project decisions, constraints, and agreed tradeoffs. When a fact extends an existing topic, reuse a concise title and state only the NEW facts, never restating what is stored. Classify each candidate: scope "global" ONLY for facts about the user that apply across projects (identity, preferences, cross-project rules); scope "project" for project-specific facts.',
  'content: 1-3 plain sentences stating new facts. Do not write wikilinks; the host will add final links after real files exist. Put same-scope related note titles in "related" where the facts connect.',
  'journal: one short task narrative for the finished turn. title is the narrative heading; body is markdown bullets stating what happened, without wikilinks and without restating node facts.',
  'Return {"notes":[],"journal":{"title":"...","body":"..."}} when nothing new is worth remembering.',
  'Do NOT mention this request or take any other action. Output only the JSON object.',
].join('\n')

/**
 * The fixed distillation instruction one mode selects. Both texts are pinned
 * verbatim by tests: they are model-visible output, and the mode only selects
 * between them.
 * @param mode - the configured distillation mode.
 * @returns the exact instruction text.
 */
export function distillInstruction(mode: DistillMode): string {
  switch (mode) {
    case 'concise': return CONCISE_INSTRUCTION
    case 'detailed': return DETAILED_INSTRUCTION
    default: return assertNever(mode, 'DistillMode')
  }
}

/** Exact auxiliary route for one distillation call. */
export interface DistillRoute {
  readonly provider: string
  readonly model: string
}

/** Finished-turn facts one distillation pass consumes. */
export interface DistillTarget {
  readonly session: Session
  readonly cwd: string | undefined
  readonly turn: number
  /** Seq of the `turn/end` event closing the finished turn. */
  readonly endSeq: number
  readonly signal: AbortSignal
}

/**
 * Resolve the auxiliary route: the explicit config pair first, then the exact
 * route logged for the session's latest request.
 * @param config - resolved lifecycle parameters.
 * @param session - session whose routed request supplies the fallback.
 * @returns the route, or `undefined` when neither source names one.
 */
export function resolveDistillRoute(config: ResolvedConfig, session: Session): DistillRoute | undefined {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const header = session.requestHeader()?.config
  if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
    return { provider: header.provider, model: header.model }
  }
  return undefined
}

/**
 * Collect one finished turn's model-visible messages in surface order.
 * @param session - session log the turn lives in.
 * @param endSeq - seq of the turn's `turn/end` event.
 * @returns derived messages between the turn's `turn/start` and its end.
 */
export function turnMessages(session: Session, endSeq: number): Message[] {
  let startSeq = -1
  for (let seq = endSeq; seq >= 0; seq -= 1) {
    if (session.events[seq]?.type === 'turn/start') {
      startSeq = seq
      break
    }
  }
  if (startSeq === -1) return []
  const messages: Message[] = []
  for (const seq of session.surface.nodes) {
    if (seq < startSeq || seq > endSeq) continue
    const event = session.events[seq]
    /* v8 ignore next -- surface nodes always index a live log entry. */
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    /* v8 ignore next -- every surface node derives a message by construction. */
    if (message !== null) messages.push(message)
  }
  return messages
}

/**
 * Count the non-whitespace characters across one turn's text content — the
 * length measure the minimum-turn gate applies.
 * @param messages - the turn's derived messages.
 * @returns the non-whitespace character count.
 */
export function turnTextLength(messages: readonly Message[]): number {
  let count = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') count += block.text.replace(/\s+/g, '').length
    }
  }
  return count
}

/**
 * Run one distillation pass over the finished turn and append its committed
 * receipt only after the provider verifies every created node, journal entry,
 * index row, readback, and link. A pass with no route, a too-short turn, no
 * durable candidates, or any commit failure appends no `memory/distill` event.
 * @param ctx - context carrying the memory and LLM services.
 * @param config - resolved lifecycle parameters.
 * @param target - finished-turn facts and cancellation.
 * @returns after the `memory/distill` event landed, when anything committed.
 */
export async function runDistill(ctx: Context, config: ResolvedConfig, target: DistillTarget): Promise<void> {
  target.signal.throwIfAborted()
  const route = resolveDistillRoute(config, target.session)
  if (route === undefined) {
    throw new Error('memory-lifecycle: no auxiliary route for distillation; configure provider and model or route one request')
  }
  const messages = turnMessages(target.session, target.endSeq)
  if (turnTextLength(messages) < config.minTurnChars) return
  const header = target.session.requestHeader()
  const instruction = createUserMessage({
    content: [{ type: 'text', text: distillInstruction(config.distillMode) }],
    source: { kind: 'plugin', plugin: 'dsh-memory-lifecycle' },
  })
  using callDeadline = deadline(target.signal, config.distillTimeoutMs, MEMORY_DISTILL_TIMEOUT_CODE)
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [...messages, instruction],
    ...header?.system === undefined ? {} : { system: header.system },
    ...header?.tools === undefined ? {} : { tools: [...header.tools] },
    maxTokens: config.maxDistillTokens,
    sessionId: target.session.id,
    purpose: 'memory-distill',
    signal: callDeadline.signal,
  }
  const output = await streamDistill(ctx, options, callDeadline.signal)
  callDeadline.signal.throwIfAborted()
  const committed = await commitDistill(ctx, target, output, config)
  if (committed === undefined) return
  target.session.append('memory/distill', {
    turn: target.turn,
    notes: committed.notes.map(note => ({
      id: note.id,
      scope: note.scope,
      title: note.title,
      path: note.path,
      journalAnchor: note.journalAnchor,
      ...(note.previous === undefined ? {} : { previous: note.previous }),
    })),
    journals: committed.journals,
    model: route,
  })
}

/** Run the auxiliary call and validate its reply into candidates. */
async function streamDistill(ctx: Context, options: GenerateOptions, signal: AbortSignal): Promise<DistillOutput> {
  const text = await streamTextOnly(ctx, options, signal, 'distillation')
  const output = parseDistillOutput(text)
  if (output === undefined) {
    throw new Error('memory-lifecycle: distillation output contains no JSON object')
  }
  return output
}

/**
 * Stream one auxiliary text-only reply and fail on any non-text content or
 * terminal failure. Shared by the distillation and review calls, whose only
 * difference is the contract the parsed text must satisfy.
 * @param ctx - context carrying the LLM service.
 * @param options - complete auxiliary generate options.
 * @param signal - caller cancellation.
 * @param kind - which auxiliary call streams, for diagnostics.
 * @returns the assembled plain text.
 */
export async function streamTextOnly(
  ctx: Context,
  options: GenerateOptions,
  signal: AbortSignal,
  kind: 'distillation' | 'review',
): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  signal.throwIfAborted()
  const terminal = finishError(assembler.finish, kind)
  if (terminal !== undefined) throw terminal
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new LlmError(`memory ${kind} output must contain text only`, 'UNSUPPORTED_CONTENT')
  }
  return blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason, kind: 'distillation' | 'review'): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'max-tokens':
      return new Error(`memory-lifecycle: ${kind} output reached maxDistillTokens`)
    case 'tool-calls':
      return new Error(`memory-lifecycle: ${kind} model unexpectedly requested a tool`)
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    default:
      return new Error(`memory-lifecycle: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/** Commit one pass's candidates through the provider-owned whole-turn writer. */
async function commitDistill(
  ctx: Context,
  target: DistillTarget,
  output: DistillOutput,
  config: ResolvedConfig,
): Promise<Awaited<ReturnType<typeof ctx.memory.commitDistill>> | undefined> {
  if (output.notes.length === 0) return undefined
  const scopes = await ctx.memory.resolveScopes(target.cwd)
  const project = scopes.includes('project')
  const date = journalDate(Date.now(), config.timeZone)
  const groups = new Map<MemoryScope, MemoryDistillCommitGroupInput>()
  for (const candidate of output.notes) {
    const scope: MemoryScope = candidate.scope === 'project' && !project ? 'global' : candidate.scope
    const current = groups.get(scope) ?? {
      scope,
      date,
      journalTitle: output.journal.title,
      journalBody: output.journal.body,
      notes: [],
    }
    groups.set(scope, {
      ...current,
      notes: [
        ...current.notes,
        {
          title: candidate.title,
          content: candidate.content,
          ...(candidate.tags.length > 0 ? { tags: candidate.tags } : {}),
          ...(candidate.related.length > 0 ? { related: candidate.related } : {}),
        },
      ],
    })
  }
  return await ctx.memory.commitDistill([...groups.values()], target.cwd, target.signal)
}

/**
 * Format one epoch millisecond as `YYYY-MM-DD` in a configured timezone.
 * @param epoch - timestamp in epoch milliseconds.
 * @param timeZone - IANA timezone used for the calendar day.
 * @returns ISO calendar date for that timezone.
 */
export function journalDate(epoch: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(epoch)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values['year']}-${values['month']}-${values['day']}`
}
