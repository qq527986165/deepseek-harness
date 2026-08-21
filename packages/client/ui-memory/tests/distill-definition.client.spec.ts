/** The memory-distill conversation node Definition: match identity, start fold, and replay invariants. */
import { describe, expect, it } from 'vitest'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatConversationViewNode, ConversationEventInput, ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  MemoryDistillEventData, MemoryDistillJournalWrite, MemoryDistillNoteWrite,
} from '@deepseek-ai/dsh-memory-lifecycle/types'
import { memoryDistillDefinition } from '../src/client/distill/distill-definition.ts'

const WRITE_A: MemoryDistillNoteWrite = {
  id: 'w1', scope: 'global', title: 'A', path: 'notes/a-1a2b3c4d.md', journalAnchor: '^memory-1a2b3c4d-global',
}
const WRITE_B: MemoryDistillNoteWrite = {
  id: 'w2', scope: 'project', title: 'B', path: 'notes/b-4d5e6f7a.md', journalAnchor: '^memory-4d5e6f7a-project',
}
const JOURNAL_A: MemoryDistillJournalWrite = {
  scope: 'global', path: 'journal/2024-01-01.md', date: '2024-01-01', title: '2024-01-01', anchor: '^memory-1a2b3c4d-global',
}
const JOURNAL_B: MemoryDistillJournalWrite = {
  scope: 'project', path: 'journal/2024-01-02.md', date: '2024-01-02', title: '2024-01-02', anchor: '^memory-4d5e6f7a-project',
}

const DATA_A: MemoryDistillEventData = { turn: 1, notes: [WRITE_A], journals: [JOURNAL_A], model: { provider: 'p', model: 'm' } }
const DATA_B: MemoryDistillEventData = { turn: 2, notes: [WRITE_B], journals: [JOURNAL_B], model: { provider: 'p', model: 'm' } }

/** One folded State for a full pass: the start fold is the complete State. */
function stateOf(data: MemoryDistillEventData) {
  return { notes: data.notes }
}

/** Minimal 'chat' target snapshot the assembler can materialize the distill node into. */
interface DistillSnapshot {
  readonly order: readonly string[]
  readonly nodes: ReadonlyMap<string, ChatConversationViewNode>
}

function distillView(): ConversationViewDefinition<ChatConversationViewNode, DistillSnapshot> {
  return {
    target: 'chat',
    create: () => {
      let current: DistillSnapshot = { order: [], nodes: new Map() }
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

class DistillDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [memoryDistillDefinition] }

  fallbackEntry(): undefined { return undefined }
}

class DistillViews {
  entries(): readonly ConversationViewDefinition[] { return [distillView()] }
}

function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: 1_700_000_000_000 + seq, type, data } as unknown as ConversationEventInput['event'], view: undefined }
}

function matchOf(data: MemoryDistillEventData, type = 'memory/distill') {
  return { event: { seq: 1, time: 2, type, data }, view: undefined, role: 'start' as const, location: { kind: 'session' as const } }
}

function assembler(entries: readonly ConversationEventInput[] = [], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new DistillDefinitions(), new DistillViews())
  value.replaceWindow(entries, hasMore)
  value.flush()
  return value
}

function nodes(value: ConversationNodeAssembler): readonly ChatConversationViewNode[] {
  return [...((value.snapshot('chat') as DistillSnapshot | undefined)?.nodes.values() ?? [])]
}

function onlyNode(value: ConversationNodeAssembler): ChatConversationViewNode {
  const list = nodes(value)
  if (list.length !== 1) throw new Error(`expected exactly one distill node, got ${list.length}`)
  return list[0] as ChatConversationViewNode
}

describe('memoryDistillDefinition', () => {
  it('extracts the event seq as the business id and returns null for unrelated events', () => {
    expect(memoryDistillDefinition.match({ seq: 7, time: 2, type: 'memory/distill', data: DATA_A } as never))
      .toEqual({ id: '7', role: 'start' })
    expect(memoryDistillDefinition.match({ seq: 1, time: 2, type: 'memory/review', data: {} } as never)).toBeNull()
    expect(memoryDistillDefinition.match({ seq: 1, time: 2, type: 'turn/start', data: {} } as never)).toBeNull()
  })

  it('folds only committed topic nodes from the receipt', () => {
    expect(memoryDistillDefinition.start(undefined as never, matchOf(DATA_A) as never, undefined as never))
      .toEqual({ notes: DATA_A.notes })
  })

  it('throws from start without a memory/distill match', () => {
    expect(() => memoryDistillDefinition.start(
      undefined as never,
      matchOf(DATA_A, 'memory/review') as never,
      undefined as never,
    )).toThrow('memory-distill start requires memory/distill')
  })

  it('passes an update through unchanged', () => {
    const state = stateOf(DATA_A)
    const result = memoryDistillDefinition.update({ state } as never, undefined as never)
    expect(result).toBe(state)
  })

  it('publishes immediately', () => {
    expect(memoryDistillDefinition.publication?.(undefined as never)).toBe('immediate')
  })

  it('buildViewNode returns null without a start and the projected node anchored on the start seq otherwise', () => {
    expect(memoryDistillDefinition.buildViewNode?.({ start: undefined } as never)).toBeNull()

    const node = memoryDistillDefinition.buildViewNode?.({
      key: 'memory-distill:1',
      kind: 'memory-distill',
      id: '1',
      start: matchOf(DATA_A) as never,
      state: stateOf(DATA_A),
    } as never)
    expect(node).toEqual({
      key: 'memory-distill:1',
      kind: 'memory-distill',
      id: '1',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'session' },
      visibility: 'visible',
      data: stateOf(DATA_A),
    })
  })

  it('replays a window with two distill events into two distinct keyed nodes', () => {
    const value = assembler([at(1, 'memory/distill', DATA_A), at(2, 'memory/distill', DATA_B)])
    const list = nodes(value)
    expect(list).toHaveLength(2)
    expect(list[0]?.id).toBe('1')
    expect(list[0]?.kind).toBe('memory-distill')
    expect(list[0]?.target).toBe('chat')
    expect(list[0]?.visibility).toBe('visible')
    expect(list[0]?.anchorSeq).toBe(1)
    expect(list[0]?.data).toEqual(stateOf(DATA_A))
    expect(list[1]?.id).toBe('2')
    expect(list[1]?.anchorSeq).toBe(2)
    expect(list[1]?.data).toEqual(stateOf(DATA_B))
    expect(list[0]?.key).not.toBe(list[1]?.key)
  })

  it('equals a complete replace when a live distill event appends', () => {
    const live = assembler([at(1, 'memory/distill', DATA_A)], true)
    expect(onlyNode(live).data).toEqual(stateOf(DATA_A))

    live.append(at(2, 'memory/distill', DATA_B))
    live.flush()
    expect(nodes(live).map(node => node.data)).toEqual([stateOf(DATA_A), stateOf(DATA_B)])

    const replayed = assembler([at(1, 'memory/distill', DATA_A), at(2, 'memory/distill', DATA_B)])
    expect(nodes(replayed).map(node => node.data)).toEqual(nodes(live).map(node => node.data))
  })
})
