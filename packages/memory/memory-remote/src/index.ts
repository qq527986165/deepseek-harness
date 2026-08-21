/**
 * Browser-facing memory transport: the session-independent `memory` Remote
 * namespace (list/read/search/write/delete/info over the memory capability
 * seam) and the session-addressed `memoryReview` namespace whose `decide`
 * validates a review against the session log and promotes accepted notes from
 * the project vault to the global vault. Mounted only in web compositions;
 * the service itself stays UI-free.
 * @module @deepseek-ai/dsh-memory-remote
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryError } from '@deepseek-ai/dsh-memory'
import type {
  MemoryDeleteResult,
  MemoryInfo,
  MemoryListResult,
  MemoryNote,
  MemoryNoteId,
  MemorySearchHit,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory'
import type { MemoryReviewDecidedEventData, MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { Session } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MemoryReviewDecideFailure,
  MemoryReviewDecideResult,
  MemoryReviewDecisions,
  MemoryRemoteDeleteRequest,
  MemoryRemoteListRequest,
  MemoryRemoteReadRequest,
  MemoryRemoteSearchRequest,
  MemoryRemoteWriteRequest,
} from './types.ts'

export type * from './types.ts'

/** Freeze one decide business failure branch. */
function failure(error: MemoryReviewDecideFailure): MemoryReviewDecideResult {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

/** Freeze one decide success branch. */
function success(value: MemoryReviewDecidedEventData): MemoryReviewDecideResult {
  return Object.freeze({ ok: true, value: Object.freeze(value) })
}

/**
 * Session-addressed review settlement: `decide(sessionId, reviewId,
 * decisions)` validates the review against the live session log, promotes
 * every accepted note (read project → write global → delete project, so a
 * failure never leaves a missing note), and appends `memory/review-decided`.
 */
export class MemoryReviewRemoteService extends TypertRemoteService {
  /** Per-session mutation chains: one decide at a time per session. */
  private readonly tails = new Map<Session, Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'memoryReview', { namespace: 'memoryReview' })
  }

  /**
   * Settle one review. Requires the exact live agent, a `memory/review` event
   * with that id, an exact partition of its candidate set, and every accepted
   * note still present in the project vault.
   * @param agent - the live agent whose session logged the review.
   * @param reviewId - the review being decided.
   * @param decisions - accepted and rejected candidate ids.
   * @returns the appended settlement payload, or an explicit business failure.
   */
  @Remote('decide')
  decide(agent: Agent, reviewId: MemoryReviewId, decisions: MemoryReviewDecisions): Promise<MemoryReviewDecideResult> {
    return this.enqueue(agent.session, () => this.settle(agent, reviewId, decisions))
  }

  /** Run one decide behind the session's prior decision. */
  private async settle(agent: Agent, reviewId: MemoryReviewId, decisions: MemoryReviewDecisions): Promise<MemoryReviewDecideResult> {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new Error(`memory-review: agent "${agent.id}" is not live in this registry`)
    }
    const session = agent.session
    const review = session.events.findLast(event => event.type === 'memory/review' && event.data.reviewId === reviewId)
    if (review === undefined || review.type !== 'memory/review') {
      return failure({ code: 'review-not-found', reviewId })
    }
    if (session.events.some(event => event.type === 'memory/review-decided' && event.data.reviewId === reviewId)) {
      return failure({ code: 'review-decided', reviewId })
    }
    const candidates = review.data.candidates
    const ids = new Set(candidates.map(candidate => candidate.id))
    const all = [...decisions.accepted, ...decisions.rejected]
    const seen = new Set<string>()
    for (const id of all) {
      if (seen.has(id)) {
        return failure({ code: 'duplicate-candidate', reviewId, id })
      }
      seen.add(id)
      if (!ids.has(id)) {
        return failure({ code: 'unknown-candidate', reviewId, id })
      }
    }
    const undecided = candidates.map(candidate => candidate.id).filter(id => !seen.has(id))
    if (undecided.length > 0) {
      return failure({ code: 'undecided-candidates', reviewId, ids: Object.freeze(undecided) })
    }
    const cwd = session.header.cwd
    const accepted: Array<{ id: MemoryNoteId; title: string; globalId: MemoryNoteId }> = []
    for (const id of decisions.accepted) {
      const note = await this.readProject(id, cwd)
      if (note === undefined) return failure({ code: 'note-missing', reviewId, id })
      const written = await this.ctx.memory.write({
        scope: 'global',
        title: note.title,
        content: note.body,
        tags: note.tags,
        related: note.related.map(link => link.title),
      }, undefined)
      // Promotion is a move: the global write commits first, then the project
      // file is removed outright — a failure in between never loses content.
      await this.ctx.memory.delete(id, 'project', cwd, undefined, { mode: 'permanent' })
      accepted.push({ id, title: note.title, globalId: written.id })
    }
    const payload = {
      reviewId,
      accepted: Object.freeze(accepted),
      rejected: Object.freeze([...decisions.rejected]),
    }
    session.append('memory/review-decided', payload)
    return success(payload)
  }

  /** Read one candidate within the project vault, mapping absence to `undefined`. */
  private async readProject(id: MemoryNoteId, cwd: string | undefined): Promise<MemoryNote | undefined> {
    try {
      return await this.ctx.memory.readInScope(id, 'project', cwd)
    } catch (error: unknown) {
      if (error instanceof MemoryError && error.code === 'NOT_FOUND') return undefined
      throw error
    }
  }

  /** Queue one decision behind the session's prior decision. */
  private enqueue<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(session) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(session, tail)
    return result.finally(() => {
      if (this.tails.get(session) === tail) this.tails.delete(session)
    })
  }
}

/**
 * Session-independent memory panel namespace. Project-scope requests address
 * the vault through an explicit `workspaceDir` resolved by the service's
 * scope chain; a non-registered path fails with `NO_PROJECT_SCOPE`.
 */
export class MemoryRemoteService extends TypertRemoteService {
  static inject = ['memory', 'agents']

  /** The review namespace instance, registered beside this service. */
  readonly review: MemoryReviewRemoteService

  constructor(ctx: Context) {
    super(ctx, 'memoryRemote', { namespace: 'memory' })
    this.review = new MemoryReviewRemoteService(ctx)
  }

  /**
   * Read-only service facts: the configured global vault directory.
   * @returns the global vault directory.
   */
  @Remote('info')
  info(): MemoryInfo {
    return this.ctx.memory.info()
  }

  /**
   * One vault's listable rows (persona pinned first, journal excluded).
   * @param request - scope, optional workspace directory, and optional limit.
   * @returns the vault's listable rows.
   */
  @Remote('list')
  list(request: MemoryRemoteListRequest): Promise<MemoryListResult> {
    return this.ctx.memory.list(request.scope, request.workspaceDir, request.limit === undefined ? undefined : { limit: request.limit })
  }

  /**
   * One note within exactly one vault.
   * @param request - ref, scope, and optional workspace directory.
   * @returns the resolved note with both link directions.
   */
  @Remote('read')
  read(request: MemoryRemoteReadRequest): Promise<MemoryNote> {
    return this.ctx.memory.readInScope(request.ref, request.scope, request.workspaceDir)
  }

  /**
   * Ranked full-text search within exactly one vault.
   * @param request - query, scope, optional workspace directory, and optional limit.
   * @returns ranked hits with snippets and tags.
   */
  @Remote('search')
  search(request: MemoryRemoteSearchRequest): Promise<MemorySearchHit[]> {
    return this.ctx.memory.searchInScope(
      request.query,
      request.limit === undefined ? undefined : { limit: request.limit },
      request.scope,
      request.workspaceDir,
    )
  }

  /**
   * Create or replace one note.
   * @param request - note content and scope; `id` present replaces that note.
   * @returns the committed note reference.
   */
  @Remote('write')
  write(request: MemoryRemoteWriteRequest): Promise<MemoryWriteResult> {
    return this.ctx.memory.write({
      ...(request.id === undefined ? {} : { id: request.id }),
      scope: request.scope,
      title: request.title,
      content: request.content,
      ...(request.tags === undefined ? {} : { tags: request.tags }),
      ...(request.related === undefined ? {} : { related: request.related }),
    }, request.workspaceDir)
  }

  /**
   * Soft-delete one note, resolved by id or exact title.
   * @param request - ref, optional scope, and optional workspace directory.
   * @returns the deleted note reference and the trash path when moved.
   */
  @Remote('delete')
  delete(request: MemoryRemoteDeleteRequest): Promise<MemoryDeleteResult> {
    return this.ctx.memory.delete(request.ref, request.scope, request.workspaceDir)
  }
}

export default MemoryRemoteService
