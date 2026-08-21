// @vitest-environment jsdom
/** The memory settings card: six knobs, save/discard staging, directory row. */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MemorySettingsCard } from '../src/client/settings/MemorySettingsCard.tsx'
import type { MemorySettingsCardState } from '../src/client/settings/settings-card-controller.ts'
import { settingsZh } from '../src/client/locales.ts'

afterEach(cleanup)

function state(overrides: Partial<MemorySettingsCardState> = {}): MemorySettingsCardState {
  return {
    status: 'ready',
    writable: true,
    dirty: false,
    saving: false,
    saved: false,
    error: null,
    fields: {
      distill: { value: true, overridden: false },
      distillMode: { value: 'concise', overridden: false },
      minTurnChars: { value: 40, text: '40', invalid: false, overridden: false },
      maxInjectBytes: { value: 16_384, text: '16384', invalid: false, overridden: false },
      maxReviewCandidates: { value: 5, text: '5', invalid: false, overridden: false },
      reviewAfterDays: { value: 30, text: '30', invalid: false, overridden: false },
    },
    globalDir: { kind: 'dir', dir: 'G:/vault' },
    ...overrides,
  }
}

/** Test-side selector-hook stub over one stable controller snapshot. */
function selectorHook<T>(snapshot: T) {
  return function useSelect<S>(selector: (current: T) => S): S {
    return useSyncExternalStore(
      () => () => {},
      () => selector(snapshot),
    )
  }
}

function props(overrides: Partial<Parameters<typeof MemorySettingsCard>[0]> = {}) {
  const t = makeTranslate(settingsZh)
  const inert = (() => undefined) as never
  return {
    t: t as never,
    useMemorySettingsCard: selectorHook(state()),
    useSessions: inert,
    useWorkspaces: inert,
    editNumber: vi.fn(),
    editMode: vi.fn(),
    toggleDistill: vi.fn(),
    save: vi.fn(async () => {}),
    discard: vi.fn(),
    ...overrides,
  }
}

describe('MemorySettingsCard', () => {
  it('renders the six knobs and the read-only directory', () => {
    const p = props()
    const view = render(<MemorySettingsCard {...p} />)
    expect(view.getByRole('heading', { name: '记忆' })).toBeTruthy()
    expect(view.getByLabelText(/自动蒸馏/)).toBeTruthy()
    expect(view.getByLabelText(/蒸馏模式/)).toBeTruthy()
    expect(view.getByLabelText(/最少轮次字符数/)).toBeTruthy()
    expect(view.getByLabelText(/注入上限/)).toBeTruthy()
    expect(view.getByLabelText(/回顾候选上限/)).toBeTruthy()
    expect(view.getByLabelText(/回顾天数/)).toBeTruthy()
    expect(view.getByText('G:/vault')).toBeTruthy()
    expect(view.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('a dirty stage reveals save and discard, and save commits', () => {
    const p = props({ useMemorySettingsCard: selectorHook(state({ dirty: true })) })
    const view = render(<MemorySettingsCard {...p} />)
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    expect(p.save).toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '放弃修改' }))
    expect(p.discard).toHaveBeenCalled()
  })

  it('edits route to the staged-form callbacks', () => {
    const p = props()
    const view = render(<MemorySettingsCard {...p} />)
    fireEvent.change(view.getByLabelText(/最少轮次字符数/), { target: { value: '99' } })
    expect(p.editNumber).toHaveBeenCalledWith('minTurnChars', '99')
    fireEvent.change(view.getByLabelText(/蒸馏模式/), { target: { value: 'detailed' } })
    expect(p.editMode).toHaveBeenCalledWith('detailed')
    fireEvent.click(view.getByLabelText(/自动蒸馏/))
    expect(p.toggleDistill).toHaveBeenCalled()
  })

  it('invalid numeric input shows the invalid label', () => {
    const base = state()
    const invalid = state({
      fields: {
        ...base.fields,
        minTurnChars: { value: 40, text: 'x', invalid: true, overridden: false },
      },
    })
    const p = props({ useMemorySettingsCard: selectorHook(invalid) })
    const view = render(<MemorySettingsCard {...p} />)
    expect(view.getByText('请输入正整数')).toBeTruthy()
  })

  it('a save failure shows the failure line beside the actions', () => {
    const p = props({ useMemorySettingsCard: selectorHook(state({ dirty: true, error: 'revision mismatch' })) })
    const view = render(<MemorySettingsCard {...p} />)
    expect(view.getByText(/保存失败/)).toBeTruthy()
  })

  it('the unavailable directory and the unwritable state render their copy', () => {
    const p = props({
      useMemorySettingsCard: selectorHook(state({ writable: false, globalDir: { kind: 'unavailable' } })),
    })
    const view = render(<MemorySettingsCard {...p} />)
    expect(view.getByText('主机未挂载记忆远程接口')).toBeTruthy()
    expect((view.getByLabelText(/自动蒸馏/) as HTMLInputElement).disabled).toBe(true)
  })

  it('routes the remaining numeric knobs through editNumber', () => {
    const p = props()
    const view = render(<MemorySettingsCard {...p} />)
    fireEvent.change(view.getByLabelText(/注入上限/), { target: { value: '2048' } })
    expect(p.editNumber).toHaveBeenCalledWith('maxInjectBytes', '2048')
    fireEvent.change(view.getByLabelText(/回顾候选上限/), { target: { value: '9' } })
    expect(p.editNumber).toHaveBeenCalledWith('maxReviewCandidates', '9')
    fireEvent.change(view.getByLabelText(/回顾天数/), { target: { value: '60' } })
    expect(p.editNumber).toHaveBeenCalledWith('reviewAfterDays', '60')
  })

  it('renders the loading directory copy while info is pending', () => {
    const p = props({
      useMemorySettingsCard: selectorHook(state({ globalDir: { kind: 'loading' } })),
    })
    const view = render(<MemorySettingsCard {...p} />)
    expect(view.getByText('读取中…')).toBeTruthy()
  })

  it('marks overridden fields with the overridden label', () => {
    const base = state()
    const overridden = state({
      fields: {
        ...base.fields,
        distill: { value: true, overridden: true },
        minTurnChars: { value: 40, text: '40', invalid: false, overridden: true },
      },
    })
    const p = props({ useMemorySettingsCard: selectorHook(overridden) })
    const view = render(<MemorySettingsCard {...p} />)
    expect(view.getAllByText('已覆盖')).toHaveLength(2)
  })

  it('routes a switch back to the concise mode through editMode', () => {
    const base = state()
    const detailed = state({
      fields: { ...base.fields, distillMode: { value: 'detailed', overridden: false } },
    })
    const p = props({ useMemorySettingsCard: selectorHook(detailed) })
    const view = render(<MemorySettingsCard {...p} />)
    fireEvent.change(view.getByLabelText(/蒸馏模式/), { target: { value: 'concise' } })
    expect(p.editMode).toHaveBeenCalledWith('concise')
  })

  it('renders the saved flash after a successful save', () => {
    const p = props({ useMemorySettingsCard: selectorHook(state({ saved: true })) })
    const view = render(<MemorySettingsCard {...p} />)
    expect(view.getByText('已保存')).toBeTruthy()
  })
})
