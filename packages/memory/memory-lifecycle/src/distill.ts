/**
 * Every-turn distillation: one non-blocking auxiliary LLM call over the
 * finished turn, scope classification, merge-don't-restate writes, the journal
 * append, and the memory/distill write record.
 * @module @deepseek-ai/dsh-memory-lifecycle/distill
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemoryNote, MemoryScope } from '@deepseek-ai/dsh-memory'
import type { Session } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { ResolvedConfig } from './config.ts'
import { parseDistillOutput } from './parse.ts'
import type { DistillCandidate, DistillOutput } from './parse.ts'
import type { MemoryDistillJournalWrite, MemoryDistillNoteWrite } from './types.ts'

/** Capability-owned timeout code for one auxiliary distillation call. */
export const MEMORY_DISTILL_TIMEOUT_CODE = 'MEMORY_DISTILL_TIMEOUT'

/**
 * The distillation directive, delivered as the final user message after the
 * replayed turn so the call is a genuine prefix of the last routed request and
 * reuses the provider's KV cache. One pass emits candidate topic notes, each
 * classified `project` or `global`, plus one journal entry linking the notes
 * it touched.
 */
export const DISTILL_INSTRUCTION = [
  'Act as the memory distillation engine for this AI coding assistant. Review the conversation ABOVE and extract only durable facts worth remembering across sessions.',
  '',
  'Output a single JSON object, nothing else, with exactly this schema:',
  '{"notes":[{"scope":"project","title":"...","content":"...","tags":[],"related":[]}],"journal":{"title":"...","body":"..."}}',
  '',
  'notes: one candidate per new durable fact cluster — user identity and standing preferences, project decisions, constraints. Classify each candidate: scope "global" ONLY for facts about the user that apply across projects (identity, preferences, cross-project rules); scope "project" for project-specific facts.',
  'content: 1-3 plain sentences stating new facts; may use [[Note Title]] wikilinks to existing topics. Never restate facts already captured elsewhere: emit a candidate only when it adds something not already written.',
  'journal: one short task narrative for the finished turn. title is the narrative heading; body is markdown bullets stating what happened and [[linking]] the topic notes this turn touched, without restating their facts.',
  'Return {"notes":[],"journal":{"title":"...","body":"..."}} when nothing new is worth remembering.',
  'Do NOT mention this request or take any other action. Output only the JSON object.',
].join('\n')

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

/** One committed pass: every topic-note write plus the journal append. */
export interface CommittedDistill {
  readonly journal: MemoryDistillJournalWrite
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
 * Merge one candidate into an existing note: new facts append, tags and
 * related links union, and a candidate that only restates the existing body
 * writes nothing. The merged body keeps the existing text first, so reading a
 * note stays chronological.
 * @param existing - the note the candidate's title resolves to.
 * @param candidate - validated candidate facts.
 * @returns the merged body, tags, and related links, or `undefined` when the
 *   candidate adds nothing.
 */
export function mergeNote(
  existing: MemoryNote,
  candidate: DistillCandidate,
): { body: string; tags: string[]; related: string[] } | undefined {
  const incoming = candidate.content.trim()
  if (existing.body.includes(incoming)) return undefined
  const tags = [...existing.tags]
  for (const tag of candidate.tags) {
    if (!tags.includes(tag)) tags.push(tag)
  }
  const related = existing.related.map(link => link.title)
  for (const link of candidate.related) {
    if (!related.includes(link)) related.push(link)
  }
  return { body: `${existing.body.trimEnd()}\n\n${incoming}`, tags, related }
}

/**
 * Run one distillation pass over the finished turn and append its write
 * record. Commits each candidate write and the journal append in order; a
 * failure after earlier commits still lands a `memory/distill` event carrying
 * the committed prefix and the error, so the log reconstructs every mutation.
 * A pass with no route, a too-short turn, or no committed write appends
 * nothing and reports through the returned failure instead.
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
    content: [{ type: 'text', text: DISTILL_INSTRUCTION }],
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
  const notes: MemoryDistillNoteWrite[] = []
  let journal: MemoryDistillJournalWrite | undefined
  try {
    journal = await commitDistill(ctx, target, output, notes)
  } catch (error: unknown) {
    target.signal.throwIfAborted()
    // `journal` stays undefined on every commit failure: it is only assigned
    // once the journal append itself has succeeded.
    if (notes.length === 0) throw error
    target.session.append('memory/distill', {
      turn: target.turn,
      notes,
      model: route,
      error: String(error),
    })
    return
  }
  target.session.append('memory/distill', {
    turn: target.turn,
    notes,
    journal,
    model: route,
  })
}

/** Run the auxiliary call and validate its reply into candidates. */
async function streamDistill(ctx: Context, options: GenerateOptions, signal: AbortSignal): Promise<DistillOutput> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  signal.throwIfAborted()
  const terminal = finishError(assembler.finish)
  if (terminal !== undefined) throw terminal
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new LlmError('memory distillation output must contain text only', 'UNSUPPORTED_CONTENT')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  const output = parseDistillOutput(text)
  if (output === undefined) {
    throw new Error('memory-lifecycle: distillation output contains no JSON object')
  }
  return output
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'max-tokens':
      return new Error('memory-lifecycle: distillation output reached maxDistillTokens')
    case 'tool-calls':
      return new Error('memory-lifecycle: distillation model unexpectedly requested a tool')
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

/** Commit one pass's candidate writes and journal append in order. */
async function commitDistill(
  ctx: Context,
  target: DistillTarget,
  output: DistillOutput,
  notes: MemoryDistillNoteWrite[],
): Promise<MemoryDistillJournalWrite> {
  const scopes = await ctx.memory.resolveScopes(target.cwd)
  const project = scopes.includes('project')
  for (const candidate of output.notes) {
    const scope: MemoryScope = candidate.scope === 'project' && !project ? 'global' : candidate.scope
    const existing = await findInScope(ctx, target, candidate.title, scope)
    if (existing === undefined) {
      const written = await ctx.memory.write({
        scope,
        title: candidate.title,
        content: candidate.content,
        ...(candidate.tags.length > 0 ? { tags: candidate.tags } : {}),
        ...(candidate.related.length > 0 ? { related: candidate.related } : {}),
      }, target.cwd)
      notes.push({ id: written.id, scope, title: written.title, path: written.path, action: 'create' })
      continue
    }
    const merged = mergeNote(existing, candidate)
    if (merged === undefined) continue
    const written = await ctx.memory.write({
      id: existing.id,
      scope,
      title: candidate.title,
      content: merged.body,
      tags: merged.tags,
      related: merged.related,
    }, target.cwd)
    notes.push({ id: written.id, scope, title: written.title, path: written.path, action: 'merge' })
  }
  const journalScope: MemoryScope = project ? 'project' : 'global'
  const appended = await ctx.memory.appendJournal({
    scope: journalScope,
    title: output.journal.title,
    body: output.journal.body,
  }, target.cwd)
  return { scope: journalScope, path: appended.path, date: appended.date, title: output.journal.title }
}

/** Resolve an existing note by exact title within one scope's vault. */
async function findInScope(
  ctx: Context,
  target: DistillTarget,
  title: string,
  scope: MemoryScope,
): Promise<MemoryNote | undefined> {
  try {
    return await ctx.memory.readInScope(title, scope, target.cwd)
  } catch (error: unknown) {
    if (error instanceof MemoryError && error.code === 'NOT_FOUND') return undefined
    throw error
  }
}
