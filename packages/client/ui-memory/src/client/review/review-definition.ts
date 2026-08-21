/**
 * The `memory-review` conversation node: one `/memory-review` proposal folded
 * into a keyed Chat row, settled by the user's exact partition of its
 * candidate set. Match is an identity extractor over the current event only —
 * `memory/review` starts the Context under the branded `reviewId`, and
 * `memory/review-decided` closes it with the settlement. Replayable from the
 * two log-only events alone.
 * @module @deepseek-ai/dsh-client-ui-memory/client/review/review-definition
 */
import type {
  ChatConversationViewNode,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  MemoryReviewCandidate,
  MemoryReviewDecidedEventData,
  MemoryReviewId,
} from '@deepseek-ai/dsh-memory-lifecycle/types'

/** Final keyed Chat payload for one review. */
export interface MemoryReviewChatData {
  /** The review every decision addresses. */
  readonly reviewId: MemoryReviewId
  /** The registered workspace whose project vault the candidates came from. */
  readonly workspaceDir: string
  /** The bounded candidate set; empty when nothing was proposed. */
  readonly candidates: readonly MemoryReviewCandidate[]
  /** The settlement, or null while the review is still open. */
  readonly settled: MemoryReviewDecidedEventData | null
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One `/memory-review` proposal with its candidate set and settlement. */
    'memory-review': MemoryReviewChatData
  }
}

/** Definition-internal State: the start payload plus the folded settlement. */
type MemoryReviewState = MemoryReviewChatData

/**
 * The review node Definition: `memory/review` starts one Context per
 * `reviewId`; `memory/review-decided` settles it. Both publications are
 * structural, so `immediate`.
 */
export const memoryReviewDefinition: ConversationNodeDefinition<MemoryReviewState> = {
  kind: 'memory-review',
  target: 'chat',
  match: (event) => {
    if (event.type === 'memory/review') return { id: String(event.data.reviewId), role: 'start' }
    if (event.type === 'memory/review-decided') return { id: String(event.data.reviewId), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'memory/review') {
      throw new Error('memory-review start requires memory/review')
    }
    return {
      reviewId: match.event.data.reviewId,
      candidates: match.event.data.candidates,
      workspaceDir: match.event.data.workspaceDir,
      settled: null,
    }
  },
  update: (context, match) => {
    if (match.event.type === 'memory/review-decided') {
      return { ...context.state, settled: match.event.data }
    }
    return context.state
  },
  publication: () => 'immediate',
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'memory-review',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
