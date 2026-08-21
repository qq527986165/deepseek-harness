/**
 * Memory panel slot contract: the injected faces of the three registrations
 * this package contributes (the `sidebar.footer.action` button, the
 * `shell.overlay` drawer, and the `settings.plugin.item` card), plus the
 * shared panel-open request the conversation nodes (memory-distill,
 * memory-review) later address. All three target slots are declared by other
 * packages (ui-sidebar, ui-layout, ui-settings-plugins) — this package only
 * registers into them, so its types arrive through those packages' merges.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.footer.action' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls ui-settings-plugins' SlotMap merge (the 'settings.plugin.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { MemoryScope } from '@deepseek-ai/dsh-memory/types'
import type { MemoryReviewDecideResult, MemoryReviewDecisions } from '@deepseek-ai/dsh-memory-remote/types'
import type { MemoryReviewId } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MemoryPanelSnapshot } from '../panel/controller.ts'
import type { MemorySettingsCardState } from '../settings/settings-card-controller.ts'

/**
 * One open request from a conversation node (a distill chip or a review card):
 * navigate the panel to a note and optionally pin a read-only view. The source
 * is registrant-private: the panel entry carries it in its inject `hooks`
 * compartment and the node entries publish into it through their own
 * `openNote` callback, so a session-scoped node never mounts the root panel's
 * store handle.
 */
export interface MemoryPanelOpenRequest {
  /** Note id, exact title, or adopted identity the panel resolves. */
  readonly ref: string
  /** Vault the request addresses; the panel switches to this tab. */
  readonly scope: MemoryScope
  /** Registered workspace directory for a project-scope request. */
  readonly workspaceDir?: string
  /** True for journal/adopted files: render the read-only view without edit. */
  readonly readOnly?: boolean
}

/** Edit draft of one note: the field-based edit form's complete value. */
export interface MemoryDraft {
  readonly title: string
  readonly body: string
  readonly tags: readonly string[]
}

/** One save attempt: committed, conflict-blocked, or failed. */
export type SaveOutcome =
  | { readonly outcome: 'committed' }
  | { readonly outcome: 'conflict'; readonly updated: number }
  | { readonly outcome: 'failed'; readonly message: string }

/** The panel entry's business face: the controller snapshot, the open-request source, and its actions. */
export interface MemoryPanelInjected {
  hooks: {
    /** Panel data snapshot bound by the renderer as useMemoryPanel. */
    panel: HostObservable<MemoryPanelSnapshot>
    /** Latest unacknowledged open request bound by the renderer as useMemoryPanelOpen. */
    panelOpen: HostObservable<MemoryPanelOpenRequest | null>
  }
  /** Clear the current open request after the panel handled it. */
  acknowledge: () => void
  /** Record one node open request so the next select pins its read-only view. */
  noteOpenRequest: (request: MemoryPanelOpenRequest) => void
  /** Retarget the controller at one vault (scope + optional project workspace). */
  setView: (view: { scope: MemoryScope; workspaceDir?: string }) => void
  /** Search the active vault for a query; empty restores the plain listing. */
  setQuery: (query: string) => void
  /** Load one note into the read view. */
  select: (ref: string) => void
  /** Return from the read/edit view to the list. */
  clearSelection: () => void
  /** Re-read the note, then save the draft; resolves the save outcome. */
  save: (draft: MemoryDraft) => Promise<SaveOutcome>
  /** Soft-delete the selected note; resolves whether the deletion committed. */
  deleteSelected: () => Promise<boolean>
  /** Reload the active vault's rows. */
  reload: () => void
}

/** The settings card's business face: its snapshot store and its staged-form actions. */
export interface MemorySettingsCardInjected {
  hooks: {
    /** Card snapshot bound by the renderer as useMemorySettingsCard. */
    memorySettingsCard: HostObservable<MemorySettingsCardState>
  }
  /** Stage one numeric knob's input text. */
  editNumber: (field: 'minTurnChars' | 'maxInjectBytes' | 'maxReviewCandidates' | 'reviewAfterDays', text: string) => void
  /** Stage the distill mode selection. */
  editMode: (mode: 'concise' | 'detailed') => void
  /** Toggle the distill switch. */
  toggleDistill: () => void
  /** Commit every staged change through the revision-fenced scope writes. */
  save: () => Promise<void>
  /** Drop the staged changes and re-read the scope. */
  discard: () => void
}

/**
 * The review node's business face: open one candidate in the panel and settle
 * the whole review through the session-addressed `memoryReview.decide` remote.
 */
export interface MemoryReviewInjected {
  /** Open the panel at one candidate note (project vault, read view). */
  openCandidate: (request: MemoryPanelOpenRequest) => void
  /** Settle the review with one exact partition of the candidate set. */
  decide: (
    sessionId: SessionId,
    reviewId: MemoryReviewId,
    decisions: MemoryReviewDecisions,
  ) => Promise<RemoteResult<MemoryReviewDecideResult>>
}

/**
 * The distill node's business face: open one write or the journal entry in the
 * panel through the shared open-request source.
 */
export interface MemoryDistillInjected {
  /** Open the panel at one written note or the journal entry. */
  openNote: (request: MemoryPanelOpenRequest) => void
}
