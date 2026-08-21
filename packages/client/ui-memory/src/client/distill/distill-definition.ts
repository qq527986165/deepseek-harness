/**
 * The `memory-distill` conversation node: one committed turn's topic nodes
 * folded into a single-event Chat row. The receipt is one-shot per turn, so
 * `event.seq` is the Context identity and there is no update path. Replayable
 * from the log-only `memory/distill` event alone.
 * @module @deepseek-ai/dsh-client-ui-memory/client/distill/distill-definition
 */
import type {
  ChatConversationViewNode,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { MemoryDistillEventData } from '@deepseek-ai/dsh-memory-lifecycle/types'

/** Final keyed Chat payload for one committed distillation turn. */
export interface MemoryDistillChatData {
  /** Every committed topic node, in commit order. */
  readonly notes: MemoryDistillEventData['notes']
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One committed distillation turn's topic nodes. */
    'memory-distill': MemoryDistillChatData
  }
}

/**
 * The distill node Definition: `memory/distill` starts one Context per
 * `event.seq`; no event matches as an update. Structural publication, so
 * `immediate`.
 */
export const memoryDistillDefinition: ConversationNodeDefinition<MemoryDistillChatData> = {
  kind: 'memory-distill',
  target: 'chat',
  match: (event) => {
    if (event.type === 'memory/distill') return { id: String(event.seq), role: 'start' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'memory/distill') {
      throw new Error('memory-distill start requires memory/distill')
    }
    return { notes: match.event.data.notes }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'memory-distill',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
