// @vitest-environment jsdom
/**
 * Local DOM snapshots of the memory panel through the real assembly path:
 * SlotTestRuntime mounts the package apply, the shared store opens the drawer,
 * and the snapshot captures the shell.overlay entry's output (CSS-module
 * classes folded to their semantic locals by the runtime's serializer). The
 * fake remote supplies one vault with a persona row, a topic row, and one
 * note body, so the list, the read view, the review badge, and the
 * provider-missing banner all pin their shipped copy.
 */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate, SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-memory/client'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory/types'
import { MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { MemoryRemote } from '@deepseek-ai/dsh-client-ui-memory/src/client/contract/remote.ts'
import { MemoryPanel } from '../src/client/panel/MemoryPanel.tsx'
import { createMemoryPanelStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locales.ts'
import type { MemoryPanelSnapshot } from '../src/client/panel/controller.ts'
import type { MemoryDraft, MemoryPanelOpenRequest, SaveOutcome } from '../src/client/contract/slots.ts'
import type { MemoryListedNote, MemoryNote, MemoryRemoteReadRequest } from '@deepseek-ai/dsh-memory-remote/types'

// These specs assert the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)

const NOTE_A: MemoryNote = {
  id: MemoryNoteId('n1'),
  scope: 'global',
  title: '咖啡偏好',
  path: 'notes/coffee.md',
  tags: ['身份', '偏好'],
  body: '用户偏好手冲咖啡。\n\n参见 [[咖啡设备]]。',
  updated: 1,
  related: [{ title: '咖啡设备', id: MemoryNoteId('n2') }],
  backlinks: [{ title: '咖啡设备', id: MemoryNoteId('n2') }],
}

const ROW_PERSONA: MemoryListedNote = {
  id: MemoryNoteId('persona'),
  path: 'MEMORY.md',
  title: '关于用户',
  tags: [],
  updated: Date.now(),
  excerpt: '用户是后端工程师。',
  persona: true,
}

const ROW_NOTE: MemoryListedNote = {
  id: MemoryNoteId('n1'),
  path: 'notes/coffee.md',
  title: '咖啡偏好',
  tags: ['身份', '偏好'],
  updated: Date.now(),
  excerpt: '用户偏好手冲咖啡。',
  persona: false,
}

/** A fake remote over one static vault. */
function remote(overrides: Partial<MemoryRemote> = {}) {
  return {
    info: vi.fn(() => Promise.resolve({ ok: true as const, value: { globalDir: 'G:/vault' } })),
    list: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { dir: 'G:/vault', scope: 'global' as const, notes: [ROW_PERSONA, ROW_NOTE] },
    })),
    read: vi.fn((request: MemoryRemoteReadRequest) => {
      const ref = request.ref
      if (ref === 'n1') return Promise.resolve({ ok: true as const, value: NOTE_A })
      if (ref === '咖啡设备') return Promise.resolve({
        ok: true as const,
        value: { ...NOTE_A, id: MemoryNoteId('n2'), title: '咖啡设备', body: '设备清单。' },
      })
      if (ref === 'persona') return Promise.resolve({
        ok: true as const,
        value: { ...NOTE_A, id: MemoryNoteId('persona'), title: '关于用户', body: '用户是后端工程师。', path: 'MEMORY.md' },
      })
      return Promise.resolve({ ok: false as const, error: { code: 'internal', message: `no memory note matches "${ref}"`, details: {} } })
    }),
    search: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{ id: MemoryNoteId('n2'), scope: 'global' as const, title: '咖啡设备', snippet: '设备清单。', tags: [] }],
    })),
    write: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { id: MemoryNoteId('n1'), scope: 'global' as const, title: '咖啡偏好', path: 'notes/coffee.md', created: 'c', updated: 'u' },
    })),
    delete: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { id: MemoryNoteId('n1'), scope: 'global' as const, title: '咖啡偏好', path: 'notes/coffee.md' },
    })),
    ...overrides,
  }
}

/** The review namespace the plugin injects but the panel spec never exercises. */
function reviewRemote() {
  return {
    decide: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { reviewId: MemoryReviewId('r1'), accepted: [], rejected: [] },
    })),
  }
}

async function bench(overrides: Partial<MemoryRemote> = {}) {
  const runtime = await SlotTestRuntime.create()
  const memoryRemote = remote(overrides)
  runtime.provide('remote.memory', memoryRemote)
  runtime.provide('remote.memoryReview', reviewRemote())
  runtime.provide('remote', {
    $on: () => () => {},
    $mount: () => Promise.reject(new Error('unused')),
    memory: memoryRemote,
  })
  const settings = stubSettingsScope<{ reviewAfterDays?: number }>()
  settings.publish({ status: 'ready', writable: true, revision: 1, value: { reviewAfterDays: 30 } })
  runtime.provide('settingsScope', {
    bind: <T,>() => settings.scope as unknown as SettingsScope<T>,
  })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'settings.plugin.item': { kind: 'keyed', scope: 'root' },
  })
  await runtime.mount({ inject: [...inject], apply })
  await waitFor(() => { expect(runtime.slots.entries('shell.overlay')).toHaveLength(1) })
  return { runtime, memoryRemote, settings }
}

describe('memory panel snapshots', () => {
  it('renders the closed drawer as nothing and the open drawer with the vault listing', async () => {
    const { runtime } = await bench()
    const slot = runtime.renderSlot('shell.overlay', {})
    expect(slot.container).toMatchSnapshot('memory-panel-closed')

    const store = runtime.storeOf('shell.overlay')
    store.actions.openPanel?.()
    await waitFor(() => { expect(slot.view.getByRole('heading', { name: '记忆' })).toBeTruthy() })
    await waitFor(() => { expect(slot.view.getByRole('button', { name: /咖啡偏好/ })).toBeTruthy() })
    expect(slot.view.getByText('个人档案')).toBeTruthy()
    expect(slot.container).toMatchSnapshot('memory-panel-list')
    await runtime.dispose()
  })

  it('renders the read view with backlinks and wikilink mentions', async () => {
    const { runtime } = await bench()
    const slot = runtime.renderSlot('shell.overlay', {})
    const store = runtime.storeOf('shell.overlay')
    store.actions.openPanel?.()
    await waitFor(() => { expect(slot.view.getByRole('button', { name: /咖啡偏好/ })).toBeTruthy() })
    slot.view.getByRole('button', { name: /咖啡偏好/ }).click()
    await waitFor(() => { expect(slot.view.getByText('用户偏好手冲咖啡。')).toBeTruthy() })
    expect(slot.view.getByRole('heading', { name: '反向链接' })).toBeTruthy()
    expect(slot.container).toMatchSnapshot('memory-panel-note')
    await runtime.dispose()
  })

  it('shows the provider-missing banner when the host has no storage provider', async () => {
    const { runtime } = await bench({
      list: vi.fn(() => Promise.resolve({ ok: false as const, error: { code: 'internal', message: 'no memory provider is registered', details: {} } })),
    })
    const slot = runtime.renderSlot('shell.overlay', {})
    const store = runtime.storeOf('shell.overlay')
    store.actions.openPanel?.()
    await waitFor(() => { expect(slot.view.getByText(/未挂载记忆存储提供方/)).toBeTruthy() })
    expect(slot.container).toMatchSnapshot('memory-panel-provider-missing')
    await runtime.dispose()
  })

  it('marks a note past the review threshold with the review badge', async () => {
    const stale = { ...ROW_NOTE, updated: Date.now() - 40 * 24 * 60 * 60 * 1000 }
    const { runtime } = await bench({
      list: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { dir: 'G:/vault', scope: 'global' as const, notes: [stale] },
      })),
    })
    const slot = runtime.renderSlot('shell.overlay', {})
    const store = runtime.storeOf('shell.overlay')
    store.actions.openPanel?.()
    await waitFor(() => { expect(slot.view.getByText('待回顾')).toBeTruthy() })
    await runtime.dispose()
  })

  it('the search box drives ranked hits', async () => {
    const { runtime, memoryRemote } = await bench()
    const slot = runtime.renderSlot('shell.overlay', {})
    const store = runtime.storeOf('shell.overlay')
    store.actions.openPanel?.()
    await waitFor(() => { expect(slot.view.getByRole('button', { name: /咖啡偏好/ })).toBeTruthy() })
    fireEvent.change(slot.view.getByPlaceholderText('搜索当前记忆库'), { target: { value: '咖啡' } })
    await waitFor(() => {
      expect(memoryRemote.search).toHaveBeenCalledWith({ query: '咖啡', scope: 'global' })
    })
    await waitFor(() => { expect(slot.view.getByRole('button', { name: /咖啡设备/ })).toBeTruthy() })
    expect(slot.view.queryByRole('button', { name: /咖啡偏好/ })).toBeNull()
    await runtime.dispose()
  })

  it('renders the settings card through the keyed plugin-item slot', async () => {
    // The card renders inside ui-settings-plugins' keyed tab, whose dispatch
    // site passes one entryKey per served namespace; the auto frame cannot
    // express that, so this bench declares a custom frame doing exactly it.
    const runtime = await SlotTestRuntime.create()
    const memoryRemote = remote()
    runtime.provide('remote.memory', memoryRemote)
    runtime.provide('remote.memoryReview', reviewRemote())
    runtime.provide('remote', {
      $on: () => () => {},
      $mount: () => Promise.reject(new Error('unused')),
      memory: memoryRemote,
    })
    const settings = stubSettingsScope<{ reviewAfterDays?: number }>()
    settings.publish({ status: 'ready', writable: true, revision: 1, value: { reviewAfterDays: 30 } })
    runtime.provide('settingsScope', {
      bind: <T,>() => settings.scope as unknown as SettingsScope<T>,
    })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const CardFrame = ({ renderSlot }: PropsRenderSlots<'settings.plugin.item'>) =>
      renderSlot('settings.plugin.item', {}, { entryKey: 'memory-lifecycle' })
    await runtime.root.declare(
      { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
      CardFrame,
    )
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()
    await waitFor(() => { expect(view.getByRole('heading', { name: '记忆' })).toBeTruthy() })
    expect(view.getByText('G:/vault')).toBeTruthy()
    expect(view.container).toMatchSnapshot('memory-settings-card')
    await runtime.dispose()
  })
})

/** A live selector hook over a store/observable source (test-side stub). */
function selectorHook<T>(source: { getSnapshot(): T; subscribe(fn: () => void): () => void }) {
  return function useSelect<S>(selector: (snapshot: T) => S): S {
    return useSyncExternalStore(listener => source.subscribe(listener), () => selector(source.getSnapshot()))
  }
}

/** A selector hook over one fixed snapshot. */
function staticHook<T>(snapshot: T) {
  return <S,>(selector: (current: T) => S): S => selector(snapshot)
}

function panelSnapshot(overrides: Partial<MemoryPanelSnapshot> = {}): MemoryPanelSnapshot {
  return {
    status: 'ready',
    error: null,
    providerMissing: false,
    globalDir: 'G:/vault',
    reviewAfterDays: 30,
    scope: 'global',
    workspaceDir: undefined,
    vaultDir: 'G:/vault',
    rows: [ROW_PERSONA, ROW_NOTE],
    searchHits: null,
    selection: null,
    selectionLoading: false,
    selectionError: null,
    ...overrides,
  }
}

function panelSelection() {
  return {
    note: NOTE_A,
    outbound: [{ title: '咖啡设备', id: MemoryNoteId('n2') }],
    readOnly: false,
    conflict: null,
  }
}

function benchPanel(opts: {
  view?: MemoryPanelSnapshot
  openRequest?: MemoryPanelOpenRequest | null
  workspaces?: readonly { path: string; title: string }[]
  save?: (draft: MemoryDraft) => Promise<SaveOutcome>
  deleteSelected?: () => Promise<boolean>
} = {}) {
  const store = createMemoryPanelStore().create()
  const view = opts.view ?? panelSnapshot()
  const openRequest = opts.openRequest === undefined ? null : opts.openRequest
  const workspaces = opts.workspaces ?? []
  const reload = vi.fn()
  const noteOpenRequest = vi.fn()
  const acknowledge = vi.fn()
  const props = {
    useStore: selectorHook(store),
    actions: store.actions,
    t: makeTranslate(zh) as never,
    usePanel: staticHook(view),
    usePanelOpen: staticHook(openRequest),
    useWorkspaces: staticHook({ items: workspaces }),
    setView: vi.fn(),
    setQuery: vi.fn(),
    select: vi.fn(),
    clearSelection: vi.fn(),
    noteOpenRequest,
    acknowledge,
    save: opts.save ?? (vi.fn(async () => ({ outcome: 'committed' as const }))),
    deleteSelected: opts.deleteSelected ?? (vi.fn(async () => true)),
    reload,
  } as unknown as Parameters<typeof MemoryPanel>[0]
  return { store, props, reload, noteOpenRequest, acknowledge }
}

describe('memory panel props', () => {
  it('switches scope tabs and picks a project workspace', () => {
    const b = benchPanel({ workspaces: [{ path: 'G:/proj', title: '项目A' }] })
    b.store.actions.openPanel()
    const view = render(<MemoryPanel {...b.props} />)
    fireEvent.click(view.getByRole('tab', { name: '项目' }))
    expect(b.store.getSnapshot().scope).toBe('project')
    fireEvent.change(view.getByLabelText('选择工作区'), { target: { value: 'G:/proj' } })
    expect(b.store.getSnapshot().workspaceDir).toBe('G:/proj')
    fireEvent.click(view.getByRole('tab', { name: '全局' }))
    expect(b.store.getSnapshot().scope).toBe('global')
  })

  it('shows the no-workspaces empty state on the project tab', () => {
    const b = benchPanel()
    b.store.actions.openPanel()
    const view = render(<MemoryPanel {...b.props} />)
    fireEvent.click(view.getByRole('tab', { name: '项目' }))
    expect(view.getByText('暂无工作区')).toBeTruthy()
  })

  it('treats an empty workspace dir as unselected', () => {
    const b = benchPanel()
    b.store.actions.openPanel()
    b.store.actions.setScope('project')
    b.store.actions.setWorkspaceDir('')
    const view = render(<MemoryPanel {...b.props} />)
    expect(view.getByText('暂无工作区')).toBeTruthy()
  })

  it('renders the load-failed banner with the error message', () => {
    const b = benchPanel({ view: panelSnapshot({ status: 'error', error: 'boom' }) })
    b.store.actions.openPanel()
    const view = render(<MemoryPanel {...b.props} />)
    expect(view.getByText('笔记加载失败: boom')).toBeTruthy()
  })

  it('falls back to an empty message when the error is null', () => {
    const b = benchPanel({ view: panelSnapshot({ status: 'error', error: null }) })
    b.store.actions.openPanel()
    const view = render(<MemoryPanel {...b.props} />)
    expect(view.getByText(/笔记加载失败/)).toBeTruthy()
  })

  it('collapses extra tags into a +N badge', () => {
    const tagged: MemoryListedNote = { ...ROW_NOTE, tags: ['a', 'b', 'c', 'd'] }
    const b = benchPanel({ view: panelSnapshot({ rows: [tagged] }) })
    b.store.actions.openPanel()
    const view = render(<MemoryPanel {...b.props} />)
    expect(view.getByText('+1')).toBeTruthy()
  })

  it('returns to the list from the note view', () => {
    const b = benchPanel({ view: panelSnapshot({ selection: panelSelection() }) })
    b.store.actions.openPanel()
    b.store.actions.select('n1')
    const view = render(<MemoryPanel {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '返回列表' }))
    expect(b.store.getSnapshot().selection).toBeNull()
  })

  it('edits a note through the store actions', () => {
    const b = benchPanel({ view: panelSnapshot({ selection: panelSelection() }) })
    b.store.actions.openPanel()
    b.store.actions.select('n1')
    const view = render(<MemoryPanel {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '编辑' }))
    expect(b.store.getSnapshot().editing).toBe(true)
    fireEvent.change(view.getByLabelText('标题'), { target: { value: '新标题' } })
    expect(b.store.getSnapshot().draft?.title).toBe('新标题')
    fireEvent.click(view.getByRole('button', { name: '取消' }))
    expect(b.store.getSnapshot().editing).toBe(false)
  })

  it('saves a note and leaves edit mode on success', async () => {
    const b = benchPanel({ view: panelSnapshot({ selection: panelSelection() }) })
    b.store.actions.openPanel()
    b.store.actions.select('n1')
    const view = render(<MemoryPanel {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '编辑' }))
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.store.getSnapshot().editing).toBe(false) })
  })

  it('deletes a note and returns to the list on confirm', async () => {
    const b = benchPanel({ view: panelSnapshot({ selection: panelSelection() }) })
    b.store.actions.openPanel()
    b.store.actions.select('n1')
    const view = render(<MemoryPanel {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '删除' }))
    const dialog = view.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(b.store.getSnapshot().selection).toBeNull() })
  })

  it('opens a linked note from the read view', () => {
    const b = benchPanel({ view: panelSnapshot({ selection: panelSelection() }) })
    b.store.actions.openPanel()
    b.store.actions.select('n1')
    const view = render(<MemoryPanel {...b.props} />)
    const backlinks = view.getByRole('heading', { name: '反向链接' }).closest('section')!
    fireEvent.click(within(backlinks).getByRole('button', { name: '咖啡设备' }))
    expect(b.store.getSnapshot().selection).toBe('n2')
  })

  it('closes the drawer from the backdrop', () => {
    const b = benchPanel()
    b.store.actions.openPanel()
    const view = render(<MemoryPanel {...b.props} />)
    const backdrop = view.container.querySelector('[aria-hidden="true"]')
    fireEvent.click(backdrop!)
    expect(b.store.getSnapshot().open).toBe(false)
  })

  it('closes the drawer from the close button', () => {
    const b = benchPanel()
    b.store.actions.openPanel()
    const view = render(<MemoryPanel {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '关闭记忆面板' }))
    expect(b.store.getSnapshot().open).toBe(false)
  })

  it('refreshes the vault listing', () => {
    const b = benchPanel()
    b.store.actions.openPanel()
    const view = render(<MemoryPanel {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    expect(b.reload).toHaveBeenCalled()
  })

  it('handles a node open request', async () => {
    const request: MemoryPanelOpenRequest = { ref: 'n1', scope: 'global' }
    const b = benchPanel({ openRequest: request })
    render(<MemoryPanel {...b.props} />)
    await waitFor(() => { expect(b.noteOpenRequest).toHaveBeenCalledWith(request) })
    expect(b.acknowledge).toHaveBeenCalled()
    expect(b.store.getSnapshot().open).toBe(true)
    expect(b.store.getSnapshot().selection).toBe('n1')
  })
})
