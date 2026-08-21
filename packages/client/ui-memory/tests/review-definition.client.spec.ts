/** The memory-review conversation node Definition: replay, pending tail, and the match/start/update guards. */
import { describe, expect, it } from 'vitest'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatConversationViewNode, ConversationEventInput, ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory/types'
import { MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { MemoryReviewDecidedEventData, MemoryReviewEventData } from '@deepseek-ai/dsh-memory-lifecycle/types'
import { memoryReviewDefinition } from '../src/client/review/review-definition.ts'

const REVIEW = MemoryReviewId('r1')
const CANDIDATES = [
  { id: MemoryNoteId('a'), title: 'A', snippet: 'snippet A', reason: 'reason A' },
  { id: MemoryNoteId('b'), title: 'B', snippet: 'snippet B', reason: 'reason B' },
]

const START: MemoryReviewEventData = { reviewId: REVIEW, candidates: CANDIDATES, workspaceDir: 'G:/proj' }
const DECIDED: MemoryReviewDecidedEventData = {
  reviewId: REVIEW,
  accepted: [{ id: MemoryNoteId('a'), title: 'A', globalId: MemoryNoteId('ga') }],
  rejected: [MemoryNoteId('b')],
}

const FINAL_STATE = { reviewId: REVIEW, candidates: CANDIDATES, workspaceDir: 'G:/proj', settled: DECIDED }

/** Minimal 'chat' target snapshot the assembler can materialize the review node into. */
interface ReviewSnapshot {
  readonly order: readonly string[]
  readonly nodes: ReadonlyMap<string, ChatConversationViewNode>
}

function reviewView(): ConversationViewDefinition<ChatConversationViewNode, ReviewSnapshot> {
  return {
    target: 'chat',
    create: () => {
      let current: ReviewSnapshot = { order: [], nodes: new Map() }
      return {
        empty: current,
        replace: ({ nodes }) => {
          current = { order: nodes.map(node => node.key), nodes: new Map(nodes.map(node => [node.key, node])) }
          return current
        },
        apply: ({ upserts }) => {
          const nodes = new Map(current.nodes)
          const order = [...current.order]
          for (const node of upserts) {
            if (!nodes.has(node.key)) order.push(node.key)
            nodes.set(node.key, node)
          }
          current = { order, nodes }
          return current
        },
      }
    },
  }
}

class ReviewDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [memoryReviewDefinition] }

  fallbackEntry(): undefined { return undefined }
}

class ReviewViews {
  entries(): readonly ConversationViewDefinition[] { return [reviewView()] }
}

function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: 1_700_000_000_000 + seq, type, data } as unknown as ConversationEventInput['event'], view: undefined }
}

function assembler(entries: readonly ConversationEventInput[] = [], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new ReviewDefinitions(), new ReviewViews())
  value.replaceWindow(entries, hasMore)
  value.flush()
  return value
}

function nodes(value: ConversationNodeAssembler): readonly ChatConversationViewNode[] {
  return [...((value.snapshot('chat') as ReviewSnapshot | undefined)?.nodes.values() ?? [])]
}

function onlyNode(value: ConversationNodeAssembler): ChatConversationViewNode {
  const list = nodes(value)
  if (list.length !== 1) throw new Error(`expected exactly one review node, got ${list.length}`)
  return list[0] as ChatConversationViewNode
}

describe('memoryReviewDefinition', () => {
  it('replays a complete window into the settled node anchored on the start seq', () => {
    const value = assembler([
      at(1, 'memory/review', START),
      at(2, 'memory/review-decided', DECIDED),
    ])
    const node = onlyNode(value)
    expect(node.kind).toBe('memory-review')
    expect(node.id).toBe(String(REVIEW))
    expect(node.target).toBe('chat')
    expect(node.visibility).toBe('visible')
    expect(node.anchorSeq).toBe(1)
    expect(node.data).toEqual(FINAL_STATE)
  })

  it('keeps an update-only tail pending and resolves it once the start is prepended', () => {
    const value = assembler([at(2, 'memory/review-decided', DECIDED)], true)
    expect(nodes(value)).toHaveLength(0)

    value.prepend([at(1, 'memory/review', START)], false)
    value.flush()
    expect(onlyNode(value).data).toEqual(FINAL_STATE)
  })

  it('equals a complete replace when the settled tail arrives as a live append', () => {
    const live = assembler([at(1, 'memory/review', START)], true)
    expect(onlyNode(live).data).toEqual({ reviewId: REVIEW, candidates: CANDIDATES, workspaceDir: 'G:/proj', settled: null })

    live.append(at(2, 'memory/review-decided', DECIDED))
    live.flush()
    expect(onlyNode(live).data).toEqual(FINAL_STATE)

    const replayed = assembler([at(1, 'memory/review', START), at(2, 'memory/review-decided', DECIDED)])
    expect(onlyNode(replayed).data).toEqual(onlyNode(live).data)
  })

  it('extracts the branded review id as the business id for both event roles', () => {
    expect(memoryReviewDefinition.match({ seq: 1, time: 2, type: 'memory/review', data: START } as never))
      .toEqual({ id: String(REVIEW), role: 'start' })
    expect(memoryReviewDefinition.match({ seq: 2, time: 3, type: 'memory/review-decided', data: DECIDED } as never))
      .toEqual({ id: String(REVIEW), role: 'update' })
  })

  it('returns null for unrelated events', () => {
    expect(memoryReviewDefinition.match({ seq: 1, time: 2, type: 'memory/distill', data: {} } as never)).toBeNull()
    expect(memoryReviewDefinition.match({ seq: 1, time: 2, type: 'turn/start', data: {} } as never)).toBeNull()
  })

  it('throws from start without a memory/review match', () => {
    expect(() => memoryReviewDefinition.start(
      undefined as never,
      { event: { seq: 1, time: 2, type: 'memory/review-decided', data: DECIDED }, view: undefined, role: 'update', location: { kind: 'session' } } as never,
      undefined as never,
    )).toThrow('memory-review start requires memory/review')
  })

  it('passes a non-decided update through unchanged', () => {
    const result = memoryReviewDefinition.update(
      { state: FINAL_STATE } as never,
      { event: { seq: 3, time: 4, type: 'memory/review', data: START }, view: undefined, role: 'update', location: { kind: 'session' } } as never,
    )
    expect(result).toBe(FINAL_STATE)
  })
})
