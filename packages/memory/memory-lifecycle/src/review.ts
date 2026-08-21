/**
 * The `/memory-review` promotion flow: one auxiliary model call over the
 * project vault's note catalog proposing project→global upgrade candidates,
 * bounded by the configured cap, landed as the log-only `memory/review` event
 * the conversation node renders and `memoryReview.decide` settles.
 * @module @deepseek-ai/dsh-memory-lifecycle/review
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { MemoryListedNote } from '@deepseek-ai/dsh-memory'
import type { Session } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { ResolvedConfig } from './config.ts'
import { resolveDistillRoute, streamTextOnly } from './distill.ts'
import { parseReviewOutput } from './parse.ts'
import { MemoryReviewId } from './types.ts'
import type { MemoryReviewCandidate } from './types.ts'

/** Capability-owned timeout code for one auxiliary review call. */
export const MEMORY_REVIEW_TIMEOUT_CODE = 'MEMORY_REVIEW_TIMEOUT'

/**
 * The review directive, delivered with the project catalog as one user
 * message. Pinned verbatim: the proposal contract the model must satisfy.
 */
export const REVIEW_INSTRUCTION = [
  'Act as the memory promotion reviewer for this AI coding assistant. The PROJECT memory vault of the current workspace holds the notes listed below. Some notes may hold durable facts about the user that apply across projects — identity, standing preferences, cross-project rules — which belong in the GLOBAL vault instead.',
  '',
  'Propose the notes worth promoting from project to global. Output a single JSON object, nothing else, with exactly this schema:',
  '{"candidates":[{"id":"<note id>","reason":"<one sentence: why this note is cross-project user knowledge>"}]}',
  '',
  'Use the exact note id shown in the catalog. Propose only notes that clearly belong to the user, not to this project. Return {"candidates":[]} when nothing qualifies.',
  'Do NOT mention this request or take any other action. Output only the JSON object.',
].join('\n')

/** Finished-session facts one review pass consumes. */
export interface ReviewTarget {
  readonly session: Session
  readonly cwd: string | undefined
  readonly signal: AbortSignal
}

/**
 * Render the project note catalog for the review call: every topic note's id,
 * title, tags, updated date, and excerpt. Pinned by test: the model reads
 * exact ids from this text.
 * @param notes - the project vault's listed topic notes, newest first.
 * @returns the complete catalog text.
 */
export function renderReviewCatalog(notes: readonly MemoryListedNote[]): string {
  const lines: string[] = ['Project memory catalog']
  for (const note of notes) {
    lines.push(
      '',
      `### id: ${note.id}`,
      `title: ${note.title}`,
      `tags: ${note.tags.join(', ') || '(none)'}`,
      `updated: ${new Date(note.updated).toISOString().slice(0, 10)}`,
      note.excerpt,
    )
  }
  return lines.join('\n')
}

/**
 * Run one review pass: load the project catalog, ask the auxiliary model for
 * promotion candidates, validate them against the catalog, bound the set by
 * the configured cap, and append the `memory/review` event. An empty catalog
 * still lands a proposal with no candidates, so the conversation node always
 * has something to render.
 * @param ctx - context carrying the memory and LLM services.
 * @param config - resolved lifecycle parameters.
 * @param target - session facts and cancellation.
 * @returns the seq of the appended `memory/review` event.
 */
export async function runReview(ctx: Context, config: ResolvedConfig, target: ReviewTarget): Promise<number> {
  target.signal.throwIfAborted()
  const route = resolveDistillRoute(config, target.session)
  if (route === undefined) {
    throw new Error('memory-lifecycle: no auxiliary route for review; configure provider and model or route one request')
  }
  const workspaceDir = target.cwd
  if (workspaceDir === undefined) {
    throw new Error('memory-lifecycle: review requires a project workspace')
  }
  const listed = await ctx.memory.list('project', workspaceDir)
  const pool = listed.notes.filter(note => !note.persona)
  const candidates: MemoryReviewCandidate[] = []
  if (pool.length > 0) {
    const proposals = await streamProposals(ctx, config, target, route, pool)
    const seen = new Set<string>()
    for (const proposal of proposals) {
      if (seen.has(proposal.id)) continue
      const note = pool.find(entry => entry.id === proposal.id)
      if (note === undefined) {
        throw new Error(`memory-lifecycle: review proposed unknown note id ${JSON.stringify(proposal.id)}`)
      }
      seen.add(proposal.id)
      candidates.push({ id: note.id, title: note.title, snippet: note.excerpt, reason: proposal.reason })
      if (candidates.length >= config.maxReviewCandidates) break
    }
  }
  const event = target.session.append('memory/review', {
    reviewId: MemoryReviewId(randomUUID()),
    candidates,
    workspaceDir,
  })
  return event.seq
}

/** Ask the auxiliary model once and validate its proposals. */
async function streamProposals(
  ctx: Context,
  config: ResolvedConfig,
  target: ReviewTarget,
  route: { provider: string; model: string },
  pool: readonly MemoryListedNote[],
): Promise<readonly { id: string; reason: string }[]> {
  const header = target.session.requestHeader()
  const message = createUserMessage({
    content: [{ type: 'text', text: `${REVIEW_INSTRUCTION}\n\n${renderReviewCatalog(pool)}` }],
    source: { kind: 'plugin', plugin: 'dsh-memory-lifecycle' },
  })
  using callDeadline = deadline(target.signal, config.distillTimeoutMs, MEMORY_REVIEW_TIMEOUT_CODE)
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [message],
    ...header?.system === undefined ? {} : { system: header.system },
    ...header?.tools === undefined ? {} : { tools: [...header.tools] },
    maxTokens: config.maxDistillTokens,
    sessionId: target.session.id,
    purpose: 'memory-review',
    signal: callDeadline.signal,
  }
  const text = await streamTextOnly(ctx, options, callDeadline.signal, 'review')
  const output = parseReviewOutput(text)
  if (output === undefined) {
    throw new Error('memory-lifecycle: review output contains no JSON object')
  }
  return output.candidates
}
