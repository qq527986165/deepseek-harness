// @vitest-environment jsdom
/** The note detail surface: read view links/dangling, edit conflict, delete confirm. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory/types'
import type { MemoryNote } from '@deepseek-ai/dsh-memory/types'
import { MemoryNoteView } from '../src/client/panel/MemoryNoteView.tsx'
import type { MemoryPanelSnapshot } from '../src/client/panel/controller.ts'
import type { MemoryDraft } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const NOTE: MemoryNote = {
  id: MemoryNoteId('n1'),
  scope: 'global',
  title: '咖啡偏好',
  path: 'notes/coffee.md',
  tags: ['偏好'],
  body: '用户偏好手冲咖啡。\n\n参见 [[咖啡设备]]。',
  updated: 1,
  related: [{ title: '咖啡设备', id: MemoryNoteId('n2') }],
  backlinks: [{ title: '咖啡设备', id: MemoryNoteId('n2') }],
}

function snapshot(overrides: Partial<MemoryPanelSnapshot> = {}): MemoryPanelSnapshot {
  return {
    status: 'ready',
    error: null,
    providerMissing: false,
    globalDir: 'G:/vault',
    reviewAfterDays: 30,
    scope: 'global',
    workspaceDir: undefined,
    vaultDir: 'G:/vault',
    rows: [],
    searchHits: null,
    selection: {
      note: NOTE,
      outbound: [{ title: '咖啡设备', id: MemoryNoteId('n2') }],
      readOnly: false,
      conflict: null,
    },
    selectionLoading: false,
    selectionError: null,
    ...overrides,
  }
}

function props(overrides: Partial<Parameters<typeof MemoryNoteView>[0]> = {}) {
  const t = makeTranslate(zh)
  return {
    view: snapshot(),
    draft: null as MemoryDraft | null,
    editing: false,
    onBack: vi.fn(),
    onBeginEdit: vi.fn(),
    onDraft: vi.fn(),
    onCancelEdit: vi.fn(),
    onSave: vi.fn(async () => ({ outcome: 'committed' as const })),
    onSaved: vi.fn(),
    onDelete: vi.fn(async () => true),
    onDeleted: vi.fn(),
    onOpenLink: vi.fn(),
    t: t as never,
    ...overrides,
  }
}

describe('MemoryNoteView', () => {
  it('renders the read view with backlinks, related targets, and the edit affordances', () => {
    const p = props()
    const view = render(<MemoryNoteView {...p} />)
    expect(view.getByRole('heading', { name: '咖啡偏好' })).toBeTruthy()
    expect(view.getByText('用户偏好手冲咖啡。')).toBeTruthy()
    expect(view.getByRole('heading', { name: '反向链接' })).toBeTruthy()
    expect(view.getByRole('heading', { name: '相关笔记' })).toBeTruthy()
    expect(view.getAllByRole('button', { name: '咖啡设备' }).length).toBeGreaterThan(0)
    view.getAllByRole('button', { name: '咖啡设备' })[0]?.click()
    expect(p.onOpenLink).toHaveBeenCalledWith('n2')
  })

  it('a wikilink click navigates through the body mention', () => {
    const p = props()
    const view = render(<MemoryNoteView {...p} />)
    const mentions = view.getAllByTitle('咖啡设备')
    expect(mentions.length).toBeGreaterThan(0)
    mentions[0]?.click()
    expect(p.onOpenLink).toHaveBeenCalledWith('n2')
  })

  it('dangling targets keep their marks and stay out of the body mentions', () => {
    const p = props({
      view: snapshot({
        selection: {
          note: { ...NOTE, body: '参见 [[丢失的笔记]]。' },
          outbound: [{ title: '丢失的笔记' }],
          readOnly: false,
          conflict: null,
        },
      }),
    })
    const view = render(<MemoryNoteView {...p} />)
    expect(view.getByText(/\[\[丢失的笔记\]\]/)).toBeTruthy()
    expect(view.getByRole('heading', { name: '悬空链接' })).toBeTruthy()
    expect(view.getByText('丢失的笔记')).toBeTruthy()
  })

  it('read-only selections hide the edit and delete affordances', () => {
    const p = props({
      view: snapshot({
        selection: {
          note: { ...NOTE, id: MemoryNoteId('adopted:journal/2026-08-19.md') },
          outbound: [],
          readOnly: true,
          conflict: null,
        },
      }),
    })
    const view = render(<MemoryNoteView {...p} />)
    expect(view.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(view.queryByRole('button', { name: '删除' })).toBeNull()
    expect(view.getByText(/只读视图/)).toBeTruthy()
  })

  it('the edit form requires a title and saves the trimmed draft', async () => {
    const base = props({
      editing: true,
      draft: { title: '', body: 'b', tags: [] },
    })
    const view = render(<MemoryNoteView {...base} />)
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    expect(view.getByText('标题不能为空')).toBeTruthy()
    expect(base.onSave).not.toHaveBeenCalled()

    // The component is controlled: each change re-renders with the draft the
    // parent stored from the callback.
    const drafts: MemoryDraft[] = [{ title: '', body: 'b', tags: [] }]
    fireEvent.change(view.getByLabelText('标题'), { target: { value: '  新标题 ' } })
    drafts[0] = { title: '  新标题 ', body: 'b', tags: [] }
    view.rerender(<MemoryNoteView {...props({ editing: true, draft: drafts[0] })} />)
    fireEvent.change(view.getByLabelText(/标签/), { target: { value: 'a, b, ' } })
    drafts[0] = { title: '  新标题 ', body: 'b', tags: ['a', 'b'] }
    view.rerender(<MemoryNoteView {...props({ editing: true, draft: drafts[0] })} />)

    const p = props({ editing: true, draft: drafts[0] })
    view.rerender(<MemoryNoteView {...p} />)
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(p.onSave).toHaveBeenCalledWith({ title: '新标题', body: 'b', tags: ['a', 'b'] })
    })
  })

  it('a save conflict keeps the form and shows the changed-elsewhere notice', async () => {
    const p = props({
      editing: true,
      draft: { title: '咖啡偏好', body: 'b', tags: [] },
      view: snapshot({
        selection: {
          note: NOTE,
          outbound: [],
          readOnly: false,
          conflict: { updated: 2 },
        },
      }),
      onSave: vi.fn(async () => ({ outcome: 'conflict' as const, updated: 2 })),
    })
    const view = render(<MemoryNoteView {...p} />)
    expect(view.getByText(/被修改/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(p.onSaved).not.toHaveBeenCalled() })
  })

  it('delete confirms first and only removes on confirm', async () => {
    const p = props()
    const view = render(<MemoryNoteView {...p} />)
    fireEvent.click(view.getByRole('button', { name: '删除' }))
    const dialog = view.getByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(p.onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(p.onDelete).toHaveBeenCalled() })
    await waitFor(() => { expect(p.onDeleted).toHaveBeenCalled() })
  })

  it('opens a resolved backlink target from the link column', () => {
    const p = props()
    const view = render(<MemoryNoteView {...p} />)
    const backlinks = view.getByRole('heading', { name: '反向链接' }).closest('section')!
    fireEvent.click(within(backlinks).getByRole('button', { name: '咖啡设备' }))
    expect(p.onOpenLink).toHaveBeenCalledWith('n2')
  })

  it('keeps plain inline code and unknown wl tokens inert', () => {
    const p = props({
      view: snapshot({
        selection: {
          note: { ...NOTE, body: '片段 `run.sh` 与 `wl:ghost`。' },
          outbound: [],
          readOnly: false,
          conflict: null,
        },
      }),
    })
    const view = render(<MemoryNoteView {...p} />)
    expect(view.getByText('run.sh')).toBeTruthy()
    expect(view.getByText('wl:ghost')).toBeTruthy()
    expect(view.queryAllByRole('button', { name: 'run.sh' })).toHaveLength(0)
  })

  it('renders only the backlinks column when links resolve there', () => {
    const p = props({
      view: snapshot({
        selection: {
          note: { ...NOTE, related: [], backlinks: [{ title: '咖啡设备', id: MemoryNoteId('n2') }] },
          outbound: [],
          readOnly: false,
          conflict: null,
        },
      }),
    })
    const view = render(<MemoryNoteView {...p} />)
    expect(view.getByRole('heading', { name: '反向链接' })).toBeTruthy()
    expect(view.queryByRole('heading', { name: '相关笔记' })).toBeNull()
    expect(view.queryByRole('heading', { name: '悬空链接' })).toBeNull()
  })

  it('starts editing from the read view edit affordance', () => {
    const p = props()
    const view = render(<MemoryNoteView {...p} />)
    fireEvent.click(view.getByRole('button', { name: '编辑' }))
    expect(p.onBeginEdit).toHaveBeenCalledWith({ title: '咖啡偏好', body: NOTE.body, tags: ['偏好'] })
  })

  it('edits the body through the textarea', () => {
    const p = props({ editing: true, draft: { title: '咖啡偏好', body: '旧', tags: [] } })
    const view = render(<MemoryNoteView {...p} />)
    fireEvent.change(view.getByLabelText('正文'), { target: { value: '新正文' } })
    expect(p.onDraft).toHaveBeenCalledWith({ title: '咖啡偏好', body: '新正文', tags: [] })
  })

  it('surfaces a failed save', async () => {
    const p = props({
      editing: true,
      draft: { title: '咖啡偏好', body: 'b', tags: [] },
      onSave: vi.fn(async () => ({ outcome: 'failed' as const, message: 'disk full' })),
    })
    const view = render(<MemoryNoteView {...p} />)
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(view.getByText('保存失败')).toBeTruthy() })
    expect(p.onSaved).not.toHaveBeenCalled()
  })

  it('surfaces a failed delete and keeps the dialog open', async () => {
    const p = props({ onDelete: vi.fn(async () => false) })
    const view = render(<MemoryNoteView {...p} />)
    fireEvent.click(view.getByRole('button', { name: '删除' }))
    const dialog = view.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(within(dialog).getByText('删除失败')).toBeTruthy() })
    expect(p.onDeleted).not.toHaveBeenCalled()
  })

  it('closes the delete dialog with Escape', () => {
    const p = props()
    const view = render(<MemoryNoteView {...p} />)
    fireEvent.click(view.getByRole('button', { name: '删除' }))
    expect(view.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(p.onDelete).not.toHaveBeenCalled()
  })

  it('cancels the delete dialog from the footer', () => {
    const p = props()
    const view = render(<MemoryNoteView {...p} />)
    fireEvent.click(view.getByRole('button', { name: '删除' }))
    const dialog = view.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(view.queryByRole('dialog')).toBeNull()
    expect(p.onDelete).not.toHaveBeenCalled()
  })
})
