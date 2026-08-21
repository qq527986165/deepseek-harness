/**
 * Memory panel plugin, browser half. Three registrations: the sidebar foot
 * action and the shell.overlay drawer (both presence-gated on the memory
 * Remote — absent means no trace), and the memory-lifecycle settings card
 * (always registered; the plugins tab skips it when the host serves no such
 * namespace). The footer and the drawer share one viewing-store handle and one
 * panel controller; the open-request source rides the panel entry's inject
 * hooks compartment so the session-scoped conversation nodes can open notes
 * without mounting the root store.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings surface's Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.footer.action' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls ui-settings-plugins' SlotMap merge (the 'settings.plugin.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls ui-conversation's SlotMap merge (the keyed 'conversation.chat.node' entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ctx.remote merge (the gateway namespace services).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { MemoryDistillInjected, MemoryPanelInjected, MemoryReviewInjected, MemorySettingsCardInjected } from './contract/slots.ts'
import type { MemoryRemote, MemoryReviewRemote } from './contract/remote.ts'
import { en, settingsEn, settingsZh, zh, type MemoryKey, type SettingsMemoryKey } from './locales.ts'
import { createMemoryPanelStore } from './stores.ts'
import { MemoryPanelController } from './panel/controller.ts'
import type { PanelSettings } from './panel/controller.ts'
import { MemoryPanelOpenSource } from './panel/open-source.ts'
import { MemoryRemotePresenceTracker } from './panel/presence.ts'
import { MemoryFooterAction } from './panel/MemoryPanelFooterAction.tsx'
import { MemoryPanel } from './panel/MemoryPanel.tsx'
import { MemorySettingsCardController } from './settings/settings-card-controller.ts'
import type { MemoryLifecycleCardSettings } from './settings/settings-card-controller.ts'
import { MemorySettingsCard } from './settings/MemorySettingsCard.tsx'
import { memoryReviewDefinition } from './review/review-definition.ts'
import { MemoryReviewNode } from './review/MemoryReviewNode.tsx'
import { memoryDistillDefinition } from './distill/distill-definition.ts'
import { MemoryDistillNode } from './distill/MemoryDistillNode.tsx'

export type {
  MemoryDistillInjected,
  MemoryDraft,
  MemoryPanelInjected,
  MemoryPanelOpenRequest,
  MemoryReviewInjected,
  MemorySettingsCardInjected,
  SaveOutcome,
} from './contract/slots.ts'
export type { MemoryRemote, MemoryReviewRemote } from './contract/remote.ts'
export type { MemoryKey, SettingsMemoryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The memory panel chrome copy. */
    memory: MemoryKey
    /** The memory settings card copy. */
    'settings.memory': SettingsMemoryKey
  }
}

/** Dictionary namespace owned by the panel registrations. */
const NS = 'memory'
/** Dictionary namespace owned by the settings card registration. */
const SETTINGS_NS = 'settings.memory'

/** Required services: slots, copy, the memory Remote namespaces, the settings scope, and the conversation-node registry. */
export const inject = ['slots', 'locale', 'remote', 'remote.memory', 'remote.memoryReview', 'settingsScope', 'conversationEvents']

/**
 * Mount the memory surface: dictionaries, the presence-gated panel + footer,
 * and the settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-memory: panel dictionaries')
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh: settingsZh, en: settingsEn }), 'ui-memory: settings dictionaries')

  // The memory namespace service the gateway installs lazily per mounted
  // Remote contribution. The gateway provides the service one tick before its
  // methods install, so consumers resolve it through a reader at call time
  // (and the presence probe retries while the methods are missing).
  const remote = (): MemoryRemote => ctx.get('remote.memory') as MemoryRemote
  // The session-addressed review namespace, same reader discipline. User
  // actions settle long after boot, so the decide call needs no retry loop;
  // the injected wrapper is async so a not-yet-installed method rejects
  // instead of throwing inside the click handler.
  const reviewRemote = (): MemoryReviewRemote => ctx.get('remote.memoryReview') as MemoryReviewRemote
  const store = createMemoryPanelStore()
  const presence = new MemoryRemotePresenceTracker(remote)
  const panelSettings = ctx.settingsScope.bind<PanelSettings>({ namespace: 'memory-lifecycle' })
  const controller = new MemoryPanelController(remote, panelSettings)
  const openSource = new MemoryPanelOpenSource()

  // Forwarded vault changes refresh the active list; a reconnect re-probes
  // presence and reloads every derived read.
  ctx.effect(() => {
    const offChange = ctx.remote.$on('memory/change', (payload) => {
      controller.reconcile(payload.dir)
    })
    const offReset = ctx.on('connection/reset', () => {
      presence.rearm()
      controller.refreshInfo()
      controller.reload()
    })
    return () => {
      offChange()
      offReset()
    }
  }, 'ui-memory: refresh subscriptions')

  // The settings card always registers; the plugins tab skips its key when the
  // host serves no memory-lifecycle namespace.
  const card = new MemorySettingsCardController(
    ctx.settingsScope.bind<MemoryLifecycleCardSettings>({ namespace: 'memory-lifecycle' }),
    remote,
  )
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'memory-lifecycle',
    locale: SETTINGS_NS,
    inject: (): MemorySettingsCardInjected => ({
      hooks: { memorySettingsCard: card },
      editNumber: (field, text) => { card.editNumber(field, text) },
      editMode: (mode) => { card.editMode(mode) },
      toggleDistill: () => { card.toggleDistill() },
      save: async () => { await card.save() },
      discard: () => { card.discard() },
    }),
  }, MemorySettingsCard))

  // The footer button and the drawer mount only while the host answers the
  // memory Remote; both share the one viewing-store handle (same root scope).
  const registerSurfaces = (): (() => void) => {
    const disposeFooter = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'memory',
      store,
      locale: NS,
    }, MemoryFooterAction))
    const disposePanel = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'memory',
      store,
      locale: NS,
      inject: (): MemoryPanelInjected => ({
        hooks: { panel: controller, panelOpen: openSource },
        acknowledge: () => { openSource.clear() },
        noteOpenRequest: (request) => { controller.noteOpenRequest(request) },
        setView: (view) => { controller.setView(view) },
        setQuery: (query) => { controller.setQuery(query) },
        select: (ref) => { void controller.select(ref) },
        clearSelection: () => { controller.clearSelection() },
        save: async draft => controller.save(draft),
        deleteSelected: async () => controller.deleteSelected(),
        reload: () => { controller.reload() },
      }),
    }, MemoryPanel))
    return () => {
      disposePanel()
      disposeFooter()
    }
  }

  let disposeSurfaces: (() => void) | undefined
  // The conversation nodes share the surfaces' presence gate: without the
  // memory Remote they register neither their Definitions nor their keyed
  // renderers, so the `memory/review` and `memory/distill` events leave no
  // trace (tier two).
  let disposeReviewNode: (() => void) | undefined
  let disposeDistillNode: (() => void) | undefined
  const registerReviewNode = (): (() => void) => {
    const disposeDefinition = ctx.conversationEvents.register(memoryReviewDefinition)
    const disposeRenderer = ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'memory-review',
      locale: NS,
      inject: (): MemoryReviewInjected => ({
        openCandidate: (request) => { openSource.publish(request) },
        decide: async (sessionId, reviewId, decisions) => reviewRemote().decide(sessionId, reviewId, decisions),
      }),
    }, MemoryReviewNode))
    return () => {
      disposeRenderer()
      disposeDefinition()
    }
  }
  const registerDistillNode = (): (() => void) => {
    const disposeDefinition = ctx.conversationEvents.register(memoryDistillDefinition)
    const disposeRenderer = ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'memory-distill',
      locale: NS,
      inject: (): MemoryDistillInjected => ({
        openNote: (request) => { openSource.publish(request) },
      }),
    }, MemoryDistillNode))
    return () => {
      disposeRenderer()
      disposeDefinition()
    }
  }
  ctx.effect(() => {
    const offPresence = presence.subscribe(() => {
      const present = presence.getSnapshot() === 'present'
      if (present && disposeSurfaces === undefined) disposeSurfaces = registerSurfaces()
      else if (!present && disposeSurfaces !== undefined) {
        disposeSurfaces()
        disposeSurfaces = undefined
      }
      if (present && disposeReviewNode === undefined) disposeReviewNode = registerReviewNode()
      else if (!present && disposeReviewNode !== undefined) {
        disposeReviewNode()
        disposeReviewNode = undefined
      }
      if (present && disposeDistillNode === undefined) disposeDistillNode = registerDistillNode()
      else if (!present && disposeDistillNode !== undefined) {
        disposeDistillNode()
        disposeDistillNode = undefined
      }
    })
    presence.probe()
    return () => {
      offPresence()
      disposeSurfaces?.()
      disposeSurfaces = undefined
      disposeReviewNode?.()
      disposeReviewNode = undefined
      disposeDistillNode?.()
      disposeDistillNode = undefined
      presence.dispose()
      controller.dispose()
      card.dispose()
    }
  }, 'ui-memory: presence-gated surfaces')
}
