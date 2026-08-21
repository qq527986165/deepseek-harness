// @vitest-environment jsdom
/**
 * ui-memory apply: dictionaries, the presence-gated footer + drawer
 * registrations, and the always-registered settings card.
 */
import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConversationEventRegistry, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-memory/client'
import type { MemoryDistillInjected, MemoryPanelInjected, MemoryReviewInjected, MemorySettingsCardInjected } from '@deepseek-ai/dsh-client-ui-memory/client'
import { MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemoryNote } from '@deepseek-ai/dsh-memory-remote/types'
import { memoryReviewDefinition } from '../src/client/review/review-definition.ts'
import { memoryDistillDefinition } from '../src/client/distill/distill-definition.ts'

/** One readable note the panel and settings face flows resolve. */
const NOTE: MemoryNote = {
  id: MemoryNoteId('n1'),
  scope: 'global',
  title: 'A',
  path: 'notes/a.md',
  tags: ['x'],
  body: 'body of A',
  updated: 1,
  related: [],
  backlinks: [],
}

function remote(infoOk: boolean) {
  return {
    info: vi.fn(() => Promise.resolve(infoOk
      ? { ok: true as const, value: { globalDir: 'G:/vault' } }
      : { ok: false as const, error: { code: 'internal', message: 'offline', details: {} } })),
    list: vi.fn(() => Promise.resolve({ ok: true as const, value: { dir: 'G:/vault', scope: 'global' as const, notes: [] } })),
    read: vi.fn((request: { ref: string }) => {
      if (request.ref === 'n1' || request.ref === 'A') return Promise.resolve({ ok: true as const, value: NOTE })
      return Promise.resolve({ ok: false as const, error: { code: 'internal', message: `no memory note matches "${request.ref}"`, details: {} } })
    }),
    search: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
    write: vi.fn(() => Promise.resolve({ ok: true as const, value: { id: MemoryNoteId('n1'), scope: 'global' as const, title: 'T', path: 'p', created: 'c', updated: 'u' } })),
    delete: vi.fn(() => Promise.resolve({ ok: true as const, value: { id: MemoryNoteId('n1'), scope: 'global' as const, title: 'T', path: 'p' } })),
  }
}

/** The session-addressed review namespace: settle one proposal through `decide`. */
function reviewRemote() {
  return {
    decide: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { reviewId: MemoryReviewId('r1'), accepted: [], rejected: [] },
    })),
  }
}

async function bench(infoOk: boolean) {
  const runtime = await SlotTestRuntime.create()
  const memoryRemote = remote(infoOk)
  const memoryReviewRemote = reviewRemote()
  let changeHandler: ((payload: { dir: string; paths: string[] }) => void) | undefined
  // The context proxy resolves `ctx.remote.memory` as a nested service key only
  // through the production gateway service's associate tracker; the test double
  // carries the namespace as a plain property instead (the established
  // ui-commands convention).
  runtime.provide('remote.memory', memoryRemote)
  runtime.provide('remote.memoryReview', memoryReviewRemote)
  runtime.provide('remote', {
    $on: (event: string, listener: (...args: never[]) => void) => {
      if (event === 'memory/change') {
        changeHandler = listener as unknown as (payload: { dir: string; paths: string[] }) => void
      }
      return () => {}
    },
    $mount: () => Promise.reject(new Error('unused')),
    memory: memoryRemote,
  })
  const settings = stubSettingsScope<Record<string, unknown>>()
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
    // The chat-node seat's full SlotSpec carries the ui-conversation inject
    // face, which this bench never renders; the declaration is a bare seat.
    'conversation.chat.node': { kind: 'keyed', scope: 'session' } as never,
  })
  const handle = await runtime.mount({ inject: [...inject], apply })
  return { runtime, handle, settings, memoryRemote, memoryReviewRemote, changeHandler }
}

describe('ui-memory apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.memory', 'remote.memoryReview', 'settingsScope', 'conversationEvents'])
  })

  it('registers the settings card keyed on the memory-lifecycle namespace', async () => {
    const { runtime, handle } = await bench(true)
    const entries = runtime.slots.entries('settings.plugin.item')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.options.key).toBe('memory-lifecycle')
    expect(entries[0]?.locale).toBe('settings.memory')
    await handle.dispose()
    await runtime.dispose()
  })

  it('mounts the footer action and the drawer once the remote answers', async () => {
    const { runtime, handle } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('shell.overlay')).toHaveLength(1) })
    const panel = runtime.slots.entries('shell.overlay')[0]
    expect(panel?.options.id).toBe('memory')
    expect(panel?.locale).toBe('memory')
    const footer = runtime.slots.entries('sidebar.footer.action')[0]
    expect(footer?.options.id).toBe('memory')
    expect(footer?.store).toBe(panel?.store)
    await handle.dispose()
    await runtime.dispose()
  })

  it('registers no trace while the remote is absent', async () => {
    const { runtime, handle } = await bench(false)
    await vi.waitFor(() => { expect(runtime.slots.entries('settings.plugin.item')).toHaveLength(1) })
    expect(runtime.slots.entries('shell.overlay')).toHaveLength(0)
    expect(runtime.slots.entries('sidebar.footer.action')).toHaveLength(0)
    await handle.dispose()
    await runtime.dispose()
  })

  it('a connection reset re-probes presence and reconciles both ways', async () => {
    const { runtime, handle } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('shell.overlay')).toHaveLength(1) })
    runtime.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(runtime.slots.entries('shell.overlay')).toHaveLength(1) })
    await handle.dispose()
    await runtime.dispose()
  })

  it('teardown removes every registration and dictionary', async () => {
    const { runtime, handle } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('shell.overlay')).toHaveLength(1) })
    await handle.dispose()
    expect(runtime.slots.entries('shell.overlay')).toHaveLength(0)
    expect(runtime.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(runtime.slots.entries('settings.plugin.item')).toHaveLength(0)
    await runtime.dispose()
  })

  it('the settings card inject face routes edits to the controller', async () => {
    const { runtime, handle, settings } = await bench(true)
    const entry = runtime.slots.entries('settings.plugin.item')[0]
    const face = entry?.inject?.() as unknown as MemorySettingsCardInjected
    expect(face.hooks.memorySettingsCard.getSnapshot().fields.minTurnChars.text).toBe('40')
    face.editNumber('minTurnChars', '60')
    expect(face.hooks.memorySettingsCard.getSnapshot().fields.minTurnChars.text).toBe('60')
    face.editMode('detailed')
    expect(face.hooks.memorySettingsCard.getSnapshot().fields.distillMode.value).toBe('detailed')
    face.toggleDistill()
    expect(face.hooks.memorySettingsCard.getSnapshot().fields.distill.value).toBe(false)
    face.discard()
    expect(face.hooks.memorySettingsCard.getSnapshot().dirty).toBe(false)
    face.editNumber('minTurnChars', '60')
    await face.save()
    expect(settings.set).toHaveBeenCalledWith('minTurnChars', 60)
    await handle.dispose()
    await runtime.dispose()
  })

  it('the panel inject face drives the shared controller', async () => {
    const { runtime, handle } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('shell.overlay')).toHaveLength(1) })
    const entry = runtime.slots.entries('shell.overlay')[0]
    const face = entry?.inject?.() as unknown as MemoryPanelInjected

    face.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(face.hooks.panel.getSnapshot().status).toBe('ready') })

    face.noteOpenRequest({ ref: 'n1', scope: 'global', readOnly: true })
    face.select('n1')
    await vi.waitFor(() => { expect(face.hooks.panel.getSnapshot().selection?.note.title).toBe('A') })
    expect(face.hooks.panel.getSnapshot().selection?.readOnly).toBe(true)

    face.acknowledge()

    await expect(face.save({ title: 'A', body: 'updated', tags: [] })).resolves.toEqual({ outcome: 'committed' })

    const deleted = await face.deleteSelected()
    expect(deleted).toBe(true)
    expect(face.hooks.panel.getSnapshot().selection).toBeNull()

    face.reload()
    await handle.dispose()
    await runtime.dispose()
  })

  it('a forwarded memory/change reloads the active vault', async () => {
    const { runtime, handle, memoryRemote, changeHandler } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('shell.overlay')).toHaveLength(1) })
    const entry = runtime.slots.entries('shell.overlay')[0]
    const face = entry?.inject?.() as unknown as MemoryPanelInjected
    face.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(memoryRemote.list).toHaveBeenCalledTimes(1) })
    const before = memoryRemote.list.mock.calls.length
    changeHandler?.({ dir: 'G:/vault', paths: [] })
    await vi.waitFor(() => { expect(memoryRemote.list.mock.calls.length).toBe(before + 1) })
    await handle.dispose()
    await runtime.dispose()
  })

  it('registers the review Definition and keyed renderer once presence arrives', async () => {
    const { runtime, handle } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(2) })
    const entry = runtime.slots.entries('conversation.chat.node').find(item => item.options.key === 'memory-review')
    expect(entry?.options.key).toBe('memory-review')
    expect(entry?.locale).toBe('memory')
    const events = runtime.ctx.get('conversationEvents') as ConversationEventRegistry
    expect(events.entries()).toContain(memoryReviewDefinition)
    await handle.dispose()
    await runtime.dispose()
  })

  it('the review inject face routes openCandidate and decide through their sources', async () => {
    const { runtime, handle, memoryReviewRemote } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(2) })
    const entry = runtime.slots.entries('conversation.chat.node').find(item => item.options.key === 'memory-review')
    const face = entry?.inject?.() as unknown as MemoryReviewInjected

    const panelFace = runtime.slots.entries('shell.overlay')[0]?.inject?.() as unknown as MemoryPanelInjected
    face.openCandidate({ ref: 'n1', scope: 'project', workspaceDir: 'G:/proj' })
    expect(panelFace.hooks.panelOpen.getSnapshot()).toEqual({ ref: 'n1', scope: 'project', workspaceDir: 'G:/proj' })

    const decisions = { accepted: [MemoryNoteId('a')], rejected: [MemoryNoteId('b')] }
    await face.decide(SessionId('s1'), MemoryReviewId('r1'), decisions)
    expect(memoryReviewRemote.decide).toHaveBeenCalledWith(SessionId('s1'), MemoryReviewId('r1'), decisions)
    await handle.dispose()
    await runtime.dispose()
  })

  it('disposes the review Definition and renderer on effect teardown', async () => {
    const { runtime, handle } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(2) })
    await handle.dispose()
    expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(0)
    const events = runtime.ctx.get('conversationEvents') as ConversationEventRegistry
    expect(events.entries()).not.toContain(memoryReviewDefinition)
    await runtime.dispose()
  })

  it('disposes the review Definition and renderer when presence flips absent', async () => {
    const runtime = await SlotTestRuntime.create()
    const memoryRemote = remote(true)
    runtime.provide('remote.memory', memoryRemote)
    runtime.provide('remote.memoryReview', reviewRemote())
    runtime.provide('remote', {
      $on: () => () => {},
      $mount: () => Promise.reject(new Error('unused')),
      memory: memoryRemote,
    })
    const settings = stubSettingsScope<Record<string, unknown>>()
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
      'conversation.chat.node': { kind: 'keyed', scope: 'session' } as never,
    })
    const handle = await runtime.mount({ inject: [...inject], apply })
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(2) })

    memoryRemote.info.mockResolvedValue({ ok: false as const, error: { code: 'internal', message: 'offline', details: {} } })
    runtime.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(0) })
    expect((runtime.ctx.get('conversationEvents') as ConversationEventRegistry).entries()).not.toContain(memoryReviewDefinition)
    await handle.dispose()
    await runtime.dispose()
  })

  it('registers the distill Definition and keyed renderer once presence arrives', async () => {
    const { runtime, handle } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(2) })
    const entry = runtime.slots.entries('conversation.chat.node').find(item => item.options.key === 'memory-distill')
    expect(entry?.options.key).toBe('memory-distill')
    expect(entry?.locale).toBe('memory')
    const events = runtime.ctx.get('conversationEvents') as ConversationEventRegistry
    expect(events.entries()).toContain(memoryDistillDefinition)
    await handle.dispose()
    await runtime.dispose()
  })

  it('the distill inject face publishes openNote through the shared open-request source', async () => {
    const { runtime, handle } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(2) })
    const entry = runtime.slots.entries('conversation.chat.node').find(item => item.options.key === 'memory-distill')
    const face = entry?.inject?.() as unknown as MemoryDistillInjected

    const panelFace = runtime.slots.entries('shell.overlay')[0]?.inject?.() as unknown as MemoryPanelInjected
    face.openNote({ ref: 'n1', scope: 'global', readOnly: true })
    expect(panelFace.hooks.panelOpen.getSnapshot()).toEqual({ ref: 'n1', scope: 'global', readOnly: true })
    await handle.dispose()
    await runtime.dispose()
  })

  it('disposes the distill Definition and renderer on effect teardown', async () => {
    const { runtime, handle } = await bench(true)
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(2) })
    await handle.dispose()
    expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(0)
    const events = runtime.ctx.get('conversationEvents') as ConversationEventRegistry
    expect(events.entries()).not.toContain(memoryDistillDefinition)
    await runtime.dispose()
  })

  it('disposes the distill Definition and renderer when presence flips absent', async () => {
    const runtime = await SlotTestRuntime.create()
    const memoryRemote = remote(true)
    runtime.provide('remote.memory', memoryRemote)
    runtime.provide('remote.memoryReview', reviewRemote())
    runtime.provide('remote', {
      $on: () => () => {},
      $mount: () => Promise.reject(new Error('unused')),
      memory: memoryRemote,
    })
    const settings = stubSettingsScope<Record<string, unknown>>()
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
      'conversation.chat.node': { kind: 'keyed', scope: 'session' } as never,
    })
    const handle = await runtime.mount({ inject: [...inject], apply })
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(2) })

    memoryRemote.info.mockResolvedValue({ ok: false as const, error: { code: 'internal', message: 'offline', details: {} } })
    runtime.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(runtime.slots.entries('conversation.chat.node')).toHaveLength(0) })
    expect((runtime.ctx.get('conversationEvents') as ConversationEventRegistry).entries()).not.toContain(memoryDistillDefinition)
    await handle.dispose()
    await runtime.dispose()
  })
})
