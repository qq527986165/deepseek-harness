/**
 * The memory panel drawer: the shell.overlay entry that opens from the sidebar
 * foot action. Pure presentation over the four shares — scope tabs, the
 * project workspace picker, the search box, the compact two-line list, and the
 * note detail view all render from the panel controller snapshot and the
 * shared viewing store; every business call goes through the injected
 * controller callbacks.
 */
import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCloseOutline16, IconRefreshOutline16, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryScope, MemorySearchHit } from '@deepseek-ai/dsh-memory/types'
import type { MemoryPanelInjected } from '../contract/slots.ts'
import type { createMemoryPanelStore } from '../stores.ts'
import { needsReview, relativeTime, visibleTags } from './format.ts'
import { MemoryNoteView } from './MemoryNoteView.tsx'
import type { MemoryPanelSnapshot } from './controller.ts'
import css from './MemoryPanel.module.css'

/** Props the renderer binds for the drawer entry. */
export type MemoryPanelProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createMemoryPanelStore>>
  & InjectFace<MemoryPanelInjected>
  & PropsLocale<'memory'>

/** One listable row: a plain listing row or a ranked search hit. */
type ListRow =
  | { readonly kind: 'note'; readonly id: string; readonly title: string; readonly tags: readonly string[]; readonly updated: number; readonly excerpt: string; readonly persona: boolean }
  | { readonly kind: 'hit'; readonly id: string; readonly title: string; readonly tags: readonly string[]; readonly snippet: string }

/** Project a listing row plus a search hit onto the common row shape. */
function rowOf(note: MemoryPanelSnapshot['rows'][number]): ListRow {
  return {
    kind: 'note',
    id: String(note.id),
    title: note.title,
    tags: note.tags,
    updated: note.updated,
    excerpt: note.excerpt,
    persona: note.persona,
  }
}

/** Project a search hit onto the common row shape. */
function hitOf(hit: MemorySearchHit): ListRow {
  return { kind: 'hit', id: String(hit.id), title: hit.title, tags: hit.tags, snippet: hit.snippet }
}

/** The rows the list renders: search hits while searching, else listing rows. */
function rowsOf(view: MemoryPanelSnapshot): readonly ListRow[] {
  if (view.searchHits !== null) return view.searchHits.map(hitOf)
  return view.rows.map(rowOf)
}

/** One two-line row: title (persona/review badges), then tags plus relative time. */
function MemoryRow(props: {
  row: ListRow
  reviewAfterDays: number
  selected: boolean
  onOpen: () => void
  t: MemoryPanelProps['t']
}) {
  const { row, reviewAfterDays, selected, onOpen, t } = props
  const tags = visibleTags(row.tags)
  const review = row.kind === 'note' && needsReview(row.updated, reviewAfterDays, Date.now())
  const time = row.kind === 'note' ? relativeTime(Date.now(), row.updated) : null
  const timeText = time === null
    ? null
    : time.unit === 'now'
      ? t('time.now')
      : t(`time.${time.unit}`, { n: time.value })
  return (
    <li className={css.row}>
      <button type="button" className={css.rowMain} aria-current={selected || undefined} onClick={onOpen}>
        <span className={css.rowTitle}>
          {row.title}
          {row.kind === 'note' && row.persona && <span className={css.badge}>{t('row.persona')}</span>}
          {review && <span className={css.badgeReview}>{t('row.review')}</span>}
        </span>
        <span className={css.rowMeta}>
          <span className={css.tags}>
            {tags.shown.map(tag => <Pill key={tag} className={css.tag}>{tag}</Pill>)}
            {tags.overflow > 0 && <Pill className={css.tag}>{t('tag.more', { n: tags.overflow })}</Pill>}
          </span>
          {timeText !== null && <span className={css.time}>{timeText}</span>}
        </span>
      </button>
    </li>
  )
}

/** Scope tabs plus the project workspace picker. */
function ScopeTabs(props: {
  scope: MemoryScope
  workspaceDir: string | undefined
  workspaces: readonly { path: string; title: string }[]
  onChangeScope: (scope: MemoryScope) => void
  onChangeWorkspace: (dir: string) => void
  t: MemoryPanelProps['t']
}) {
  const { scope, workspaceDir, workspaces, onChangeScope, onChangeWorkspace, t } = props
  return (
    <div className={css.tabsRow}>
      <div className={css.tabs} role="tablist" aria-label={t('panel.title')}>
        <Pill role="tab" aria-selected={scope === 'global'} active={scope === 'global'} onClick={() => { onChangeScope('global') }}>{t('tab.global')}</Pill>
        <Pill role="tab" aria-selected={scope === 'project'} active={scope === 'project'} onClick={() => { onChangeScope('project') }}>{t('tab.project')}</Pill>
      </div>
      {scope === 'project' && (
        <label className={css.workspacePick}>
          <span className={css.visuallyHidden}>{t('workspace.placeholder')}</span>
          <select
            className={css.workspaceSelect}
            value={workspaceDir ?? ''}
            onChange={(event) => { onChangeWorkspace(event.target.value) }}
          >
            <option value="" disabled>{t('workspace.placeholder')}</option>
            {workspaces.map(workspace => (
              <option key={workspace.path} value={workspace.path}>{workspace.title}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

/** The list body: loading, provider-missing banner, error, empty, or rows. */
function MemoryList(props: {
  view: MemoryPanelSnapshot
  selected: string | null
  reviewAfterDays: number
  workspaces: readonly { path: string; title: string }[]
  scope: MemoryScope
  workspaceDir: string | undefined
  onOpen: (id: string) => void
  t: MemoryPanelProps['t']
}) {
  const { view, selected, reviewAfterDays, workspaces, scope, workspaceDir, onOpen, t } = props
  if (scope === 'project' && (workspaceDir === undefined || workspaceDir === '') && workspaces.length === 0) {
    return <p className={css.empty}>{t('workspace.empty')}</p>
  }
  if (view.providerMissing) {
    return <p className={css.banner}>{t('list.providerMissing')}</p>
  }
  if (view.status === 'loading') {
    return <p className={css.empty}>{t('list.loading')}</p>
  }
  if (view.status === 'error') {
    return <p className={css.banner}>{t('list.loadFailed')}: {view.error ?? ''}</p>
  }
  const rows = rowsOf(view)
  if (rows.length === 0) {
    return <p className={css.empty}>{t('list.empty')}</p>
  }
  return (
    <ul className={css.list}>
      {rows.map(row => (
        <MemoryRow
          key={row.id}
          row={row}
          reviewAfterDays={reviewAfterDays}
          selected={selected === row.id}
          onOpen={() => { onOpen(row.id) }}
          t={t}
        />
      ))}
    </ul>
  )
}

/**
 * Render the panel drawer (mounted while the shared store says open; the
 * footer toggles it). The overlay layer is click-through, so the backdrop and
 * drawer opt back into pointer events and the backdrop click closes.
 * @param props - store, controller face, locale, and the shell owner share.
 * @returns the drawer, or null when closed.
 */
export function MemoryPanel(props: MemoryPanelProps) {
  const { useStore, actions, t } = props
  const panel = useStore(s => s)
  const view = props.usePanel(snapshot => snapshot)
  const openRequest = props.usePanelOpen(snapshot => snapshot)
  const workspaces = props.useWorkspaces(snapshot =>
    snapshot.items.map(workspace => ({ path: workspace.path, title: workspace.title })))

  // The store is the single source of viewing state; the controller follows.
  useEffect(() => {
    props.setView({
      scope: panel.scope,
      ...(panel.workspaceDir === undefined ? {} : { workspaceDir: panel.workspaceDir }),
    })
  }, [panel.scope, panel.workspaceDir, props])

  useEffect(() => {
    props.setQuery(panel.query)
  }, [panel.query, props])

  useEffect(() => {
    if (panel.selection !== null) props.select(panel.selection)
    else props.clearSelection()
  }, [panel.selection, props])

  // A node-driven open request flips the store, then clears the source. The
  // controller records the request first so the store-driven select pins the
  // read-only view.
  useEffect(() => {
    if (openRequest === null) return
    props.noteOpenRequest(openRequest)
    actions.openPanel(openRequest.scope, openRequest.workspaceDir)
    actions.select(openRequest.ref)
    props.acknowledge()
  }, [openRequest, props, actions])

  if (!panel.open) return null

  const listBody = (
    <MemoryList
      view={view}
      selected={panel.selection}
      reviewAfterDays={view.reviewAfterDays}
      workspaces={workspaces}
      scope={panel.scope}
      workspaceDir={panel.workspaceDir}
      onOpen={(id) => { actions.select(id) }}
      t={t}
    />
  )
  const noteBody = (
    <MemoryNoteView
      view={view}
      draft={panel.draft}
      editing={panel.editing}
      onBack={() => { actions.backToList() }}
      onBeginEdit={(draft) => { actions.beginEdit(draft) }}
      onDraft={(draft) => { actions.setDraft(draft) }}
      onCancelEdit={() => { actions.cancelEdit() }}
      onSave={props.save}
      onSaved={() => { actions.cancelEdit() }}
      onDelete={props.deleteSelected}
      onDeleted={() => { actions.backToList() }}
      onOpenLink={(id) => { actions.select(id) }}
      t={t}
    />
  )

  return (
    <div className={css.layer}>
      <div className={css.backdrop} aria-hidden="true" onClick={() => { actions.close() }} />
      <aside className={css.drawer} aria-label={t('panel.title')}>
        <header className={css.header}>
          <h2 className={css.title}>{t('panel.title')}</h2>
          <Button variant="ghost" size="sm" icon={<IconCloseOutline16 />} aria-label={t('panel.close')} onClick={() => { actions.close() }} />
        </header>
        <ScopeTabs
          scope={panel.scope}
          workspaceDir={panel.workspaceDir}
          workspaces={workspaces}
          onChangeScope={(scope) => { actions.setScope(scope) }}
          onChangeWorkspace={(dir) => { actions.setWorkspaceDir(dir) }}
          t={t}
        />
        <div className={css.toolbar}>
          <input
            className={css.search}
            type="search"
            placeholder={t('search.placeholder')}
            value={panel.query}
            onChange={(event) => { actions.setQuery(event.target.value) }}
          />
          <Button variant="ghost" size="sm" icon={<IconRefreshOutline16 />} aria-label={t('refresh')} onClick={() => { props.reload() }} />
        </div>
        {panel.selection === null ? listBody : noteBody}
      </aside>
    </div>
  )
}
