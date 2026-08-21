// @vitest-environment jsdom
/** The memory-review node: candidate cards, staging, confirm gating, decide routing, and settled marks. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory/types'
import { MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemoryReviewCandidate } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { MemoryReviewDecideFailure } from '@deepseek-ai/dsh-memory-remote/types'
import { zh } from '../src/client/locales.ts'
import { MemoryReviewNode } from '../src/client/review/MemoryReviewNode.tsx'
import type { MemoryReviewChatData } from '../src/client/review/review-definition.ts'

afterEach(cleanup)

const SESSION = SessionId('s1')
const REVIEW = MemoryReviewId('r1')

function candidate(id: string, title: string): MemoryReviewCandidate {
  return { id: MemoryNoteId(id), title, snippet: `${title} 摘要`, reason: `${title} 理由` }
}

const CANDIDATES = [candidate('a', '笔记A'), candidate('b', '笔记B')]

function openData(): MemoryReviewChatData {
  return { reviewId: REVIEW, workspaceDir: 'G:/proj', candidates: CANDIDATES, settled: null }
}

function settledData(): MemoryReviewChatData {
  return {
    reviewId: REVIEW,
    workspaceDir: 'G:/proj',
    candidates: CANDIDATES,
    settled: {
      reviewId: REVIEW,
      accepted: [{ id: MemoryNoteId('a'), title: '笔记A', globalId: MemoryNoteId('ga') }],
      rejected: [MemoryNoteId('b')],
    },
  }
}

function failure(code: MemoryReviewDecideFailure['code']): MemoryReviewDecideFailure {
  switch (code) {
    case 'review-not-found': return { code, reviewId: REVIEW }
    case 'review-decided': return { code, reviewId: REVIEW }
    case 'unknown-candidate': return { code, reviewId: REVIEW, id: MemoryNoteId('a') }
    case 'duplicate-candidate': return { code, reviewId: REVIEW, id: MemoryNoteId('a') }
    case 'undecided-candidates': return { code, reviewId: REVIEW, ids: [MemoryNoteId('a')] }
    case 'note-missing': return { code, reviewId: REVIEW, id: MemoryNoteId('a') }
  }
}

function bench(data: MemoryReviewChatData, decideImpl?: () => Promise<unknown>) {
  const openCandidate = vi.fn()
  const decide = vi.fn(decideImpl ?? (() => Promise.resolve({
    ok: true as const,
    value: { ok: true as const, value: { reviewId: REVIEW, accepted: [], rejected: [] } },
  })))
  const t = makeTranslate(zh)
  const props = {
    node: { key: 'k', kind: 'memory-review', id: String(REVIEW), data },
    sessionId: SESSION,
    openCandidate,
    decide,
    t: t as never,
  } as unknown as Parameters<typeof MemoryReviewNode>[0]
  return { props, openCandidate, decide }
}

describe('MemoryReviewNode', () => {
  it('renders each candidate card with its title, snippet, and reason', () => {
    const { props } = bench(openData())
    const view = render(<MemoryReviewNode {...props} />)
    expect(view.getByRole('heading', { name: '记忆升级回顾' })).toBeTruthy()
    expect(view.getByText('笔记A')).toBeTruthy()
    expect(view.getByText('笔记A 摘要')).toBeTruthy()
    expect(view.getByText('笔记A 理由')).toBeTruthy()
    expect(view.getByText('笔记B')).toBeTruthy()
  })

  it('keeps confirm disabled until every candidate is decided and accept-all stages the full set', async () => {
    const { props, decide } = bench(openData())
    const view = render(<MemoryReviewNode {...props} />)
    const confirm = view.getByRole('button', { name: '确认升级' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.click(view.getByRole('button', { name: '全部接受' }))
    expect(confirm.disabled).toBe(false)

    fireEvent.click(confirm)
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(SESSION, REVIEW, {
        accepted: [MemoryNoteId('a'), MemoryNoteId('b')],
        rejected: [],
      })
    })
  })

  it('decides with the exact per-card accept/reject partition in proposal order', async () => {
    const { props, decide } = bench(openData())
    const view = render(<MemoryReviewNode {...props} />)
    fireEvent.click(view.getAllByRole('button', { name: '接受' })[0] as HTMLElement)
    fireEvent.click(view.getAllByRole('button', { name: '拒绝' })[1] as HTMLElement)
    fireEvent.click(view.getByRole('button', { name: '确认升级' }))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(SESSION, REVIEW, {
        accepted: [MemoryNoteId('a')],
        rejected: [MemoryNoteId('b')],
      })
    })
  })

  it('shows the wire error message when decide fails at the transport', async () => {
    const { props } = bench(openData(), () => Promise.resolve({
      ok: false as const,
      error: { code: 'internal', message: '连接中断', details: {} },
    }))
    const view = render(<MemoryReviewNode {...props} />)
    fireEvent.click(view.getByRole('button', { name: '全部接受' }))
    fireEvent.click(view.getByRole('button', { name: '确认升级' }))
    await waitFor(() => { expect(view.getByText('连接中断')).toBeTruthy() })
  })

  it.each([
    ['review-not-found', '回顾不存在，无法升级'],
    ['review-decided', '该回顾已处理'],
    ['unknown-candidate', '候选笔记不在本次回顾中'],
    ['duplicate-candidate', '候选笔记重复'],
    ['undecided-candidates', '还有候选未决定'],
    ['note-missing', '候选笔记已不存在，无法升级'],
  ] as const)('shows the localized line for the %s business failure', async (code, message) => {
    const { props } = bench(openData(), () => Promise.resolve({
      ok: true as const,
      value: { ok: false as const, error: failure(code) },
    }))
    const view = render(<MemoryReviewNode {...props} />)
    fireEvent.click(view.getByRole('button', { name: '全部接受' }))
    fireEvent.click(view.getByRole('button', { name: '确认升级' }))
    await waitFor(() => { expect(view.getByText(message)).toBeTruthy() })
  })

  it('shows the submitting label and disables confirm while decide is in flight', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise((r) => { resolve = r })
    const { props } = bench(openData(), () => pending)
    const view = render(<MemoryReviewNode {...props} />)
    fireEvent.click(view.getByRole('button', { name: '全部接受' }))
    fireEvent.click(view.getByRole('button', { name: '确认升级' }))
    await waitFor(() => { expect(view.getByText('提交中…')).toBeTruthy() })
    expect((view.getByRole('button', { name: '提交中…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolve({ ok: true as const, value: { ok: true as const, value: { reviewId: REVIEW, accepted: [], rejected: [] } } })
    })
    await waitFor(() => { expect(view.queryByText('提交中…')).toBeNull() })
  })

  it('renders settled marks and hides the decision chips once settled', () => {
    const { props } = bench(settledData())
    const view = render(<MemoryReviewNode {...props} />)
    expect(view.getByText('已处理')).toBeTruthy()
    expect(view.getByText('已升级到全局')).toBeTruthy()
    expect(view.getByText('已拒绝')).toBeTruthy()
    expect(view.queryByRole('button', { name: '接受' })).toBeNull()
    expect(view.queryByRole('button', { name: '拒绝' })).toBeNull()
    expect(view.queryByRole('button', { name: '打开笔记' })).toBeNull()
    expect(view.queryByRole('button', { name: '全部接受' })).toBeNull()
    expect(view.queryByRole('button', { name: '确认升级' })).toBeNull()
  })

  it('renders the empty line for a candidate-less review', () => {
    const { props } = bench({ reviewId: REVIEW, workspaceDir: 'G:/proj', candidates: [], settled: null })
    const view = render(<MemoryReviewNode {...props} />)
    expect(view.getByText('没有可升级的候选笔记')).toBeTruthy()
  })

  it('opens a candidate in the project vault with the review workspace', () => {
    const { props, openCandidate } = bench(openData())
    const view = render(<MemoryReviewNode {...props} />)
    fireEvent.click(view.getAllByRole('button', { name: '打开笔记' })[0] as HTMLElement)
    expect(openCandidate).toHaveBeenCalledWith({ ref: String(MemoryNoteId('a')), scope: 'project', workspaceDir: 'G:/proj' })
  })
})
