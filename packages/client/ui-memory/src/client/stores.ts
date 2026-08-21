/**
 * The memory panel's viewing store: which surface is open, the active vault,
 * the search text, and the current selection/edit draft. Shared by the footer
 * button and the overlay drawer through one handle, so both surfaces read one
 * open/scope state and survive each other's remounts. Business data (rows,
 * note bodies, load state) stays in the panel controller; this store carries
 * only what the two entries must share.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { MemoryScope } from '@deepseek-ai/dsh-memory/types'
import type { MemoryDraft } from './contract/slots.ts'

/** Panel viewing state shared between the footer action and the drawer. */
export type MemoryPanelViewState = {
  /** Whether the drawer is open. */
  open: boolean
  /** Active vault tab. */
  scope: MemoryScope
  /** Selected registered workspace directory; the project tab lists its vault. */
  workspaceDir: string | undefined
  /** Search box text; non-empty switches the list to ranked search hits. */
  query: string
  /** Note ref of the read/edit view; null shows the list. */
  selection: string | null
  /** Whether the edit form is open for the selection. */
  editing: boolean
  /** The edit form's draft; null outside the edit view. */
  draft: MemoryDraft | null
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type MemoryPanelViewActions = {
  openPanel: (draft: MemoryPanelViewState, scope?: MemoryScope, workspaceDir?: string) => void
  close: (draft: MemoryPanelViewState) => void
  setScope: (draft: MemoryPanelViewState, scope: MemoryScope) => void
  setWorkspaceDir: (draft: MemoryPanelViewState, workspaceDir: string | undefined) => void
  setQuery: (draft: MemoryPanelViewState, query: string) => void
  select: (draft: MemoryPanelViewState, ref: string) => void
  backToList: (draft: MemoryPanelViewState) => void
  beginEdit: (draft: MemoryPanelViewState, initial: MemoryDraft) => void
  setDraft: (draft: MemoryPanelViewState, next: MemoryDraft) => void
  cancelEdit: (draft: MemoryPanelViewState) => void
}

/**
 * Create the panel viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createMemoryPanelStore(): EngineStoreHandle<MemoryPanelViewState, MemoryPanelViewActions> {
  return defineStore({
    init: (): MemoryPanelViewState => ({
      open: false,
      scope: 'global',
      workspaceDir: undefined,
      query: '',
      selection: null,
      editing: false,
      draft: null,
    }),
    actions: {
      openPanel: (d, scope?: MemoryScope, workspaceDir?: string) => {
        d.open = true
        if (scope !== undefined) {
          d.scope = scope
          // A node jump may omit the workspace; keep the user's current
          // project choice rather than clearing it back to the picker.
          d.workspaceDir = scope === 'project' ? (workspaceDir ?? d.workspaceDir) : undefined
        }
      },
      close: (d) => {
        d.open = false
      },
      setScope: (d, scope: MemoryScope) => {
        d.scope = scope
        d.workspaceDir = undefined
        d.query = ''
        d.selection = null
        d.editing = false
        d.draft = null
      },
      setWorkspaceDir: (d, workspaceDir: string | undefined) => {
        d.workspaceDir = workspaceDir
        d.query = ''
        d.selection = null
        d.editing = false
        d.draft = null
      },
      setQuery: (d, query: string) => {
        d.query = query
        d.selection = null
        d.editing = false
        d.draft = null
      },
      select: (d, ref: string) => {
        d.selection = ref
        d.editing = false
        d.draft = null
      },
      backToList: (d) => {
        d.selection = null
        d.editing = false
        d.draft = null
      },
      beginEdit: (d, initial: MemoryDraft) => {
        d.editing = true
        d.draft = initial
      },
      setDraft: (d, next: MemoryDraft) => {
        d.draft = next
      },
      cancelEdit: (d) => {
        d.editing = false
        d.draft = null
      },
    },
  })
}
