/**
 * The panel's narrow view of the generated `memory` Remote namespace: exactly
 * the six calls the panel and settings card controllers need, plus the
 * session-addressed `memoryReview` namespace whose `decide` settles one
 * `/memory-review` proposal. Shared contract between the panel, settings, and
 * review domains (all consume the same wire faces); the generated namespace
 * services satisfy them structurally.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MemoryDeleteResult,
  MemoryInfo,
  MemoryListResult,
  MemoryNote,
  MemoryRemoteDeleteRequest,
  MemoryRemoteListRequest,
  MemoryRemoteReadRequest,
  MemoryRemoteSearchRequest,
  MemoryRemoteWriteRequest,
  MemoryReviewDecideResult,
  MemoryReviewDecisions,
  MemorySearchHit,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory-remote/types'
import type { MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The memory Remote calls the memory UI consumes. */
export interface MemoryRemote {
  info(): Promise<RemoteResult<MemoryInfo>>
  list(request: MemoryRemoteListRequest): Promise<RemoteResult<MemoryListResult>>
  read(request: MemoryRemoteReadRequest): Promise<RemoteResult<MemoryNote>>
  search(request: MemoryRemoteSearchRequest): Promise<RemoteResult<MemorySearchHit[]>>
  write(request: MemoryRemoteWriteRequest): Promise<RemoteResult<MemoryWriteResult>>
  delete(request: MemoryRemoteDeleteRequest): Promise<RemoteResult<MemoryDeleteResult>>
}

/** The session-addressed review Remote call the review node consumes. */
export interface MemoryReviewRemote {
  decide(sessionId: SessionId, reviewId: MemoryReviewId, decisions: MemoryReviewDecisions): Promise<RemoteResult<MemoryReviewDecideResult>>
}
