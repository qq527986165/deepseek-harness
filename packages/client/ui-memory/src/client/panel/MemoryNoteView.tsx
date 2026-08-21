/**
 * The note detail surface: the read view (MarkdownText body with wikilink
 * mentions, backlinks beside it, dangling marks), the field-based edit form
 * with the re-read-before-save conflict notice, and the delete confirm
 * dialog. Pure presentation — every mutation rides the injected controller
 * callbacks and the store actions the panel threads down.
 */
import { useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconEditOutline16, IconTrashOutline16, MarkdownText, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryLinkTarget } from '@deepseek-ai/dsh-memory/types'
import type { MemoryDraft, SaveOutcome } from '../contract/slots.ts'
import { markWikilinks, WIKILINK_MENTION_PREFIX } from './wikilinks.ts'
import type { MemoryPanelSnapshot } from './controller.ts'
import css from './MemoryPanel.module.css'

/** Props the panel threads into the detail surface. */
export interface MemoryNoteViewProps {
  view: MemoryPanelSnapshot
  draft: MemoryDraft | null
  editing: boolean
  onBack: () => void
  onBeginEdit: (draft: MemoryDraft) => void
  onDraft: (draft: MemoryDraft) => void
  onCancelEdit: () => void
  onSave: (draft: MemoryDraft) => Promise<SaveOutcome>
  onSaved: () => void
  onDelete: () => Promise<boolean>
  onDeleted: () => void
  onOpenLink: (id: string) => void
  t: PropsLocale<'memory'>['t']
}

/** One link target rendered beside the read view; `id` absent marks dangling. */
function LinkTarget(props: { target: MemoryLinkTarget; onOpen: (id: string) => void; t: PropsLocale<'memory'>['t'] }) {
  const { target, onOpen, t } = props
  if (target.id === undefined) {
    return (
      <li className={css.linkDangling}>
        <span className={css.linkTitle}>{target.title}</span>
        <span className={css.linkMark}>{t('detail.dangling')}</span>
      </li>
    )
  }
  return (
    <li>
      <button type="button" className={css.linkButton} onClick={() => { onOpen(String(target.id)) }}>
        {target.title}
      </button>
    </li>
  )
}

/** The read view body: title, tags, MarkdownText, and the link columns. */
function NoteReadView(props: {
  view: MemoryPanelSnapshot
  onBeginEdit: (draft: MemoryDraft) => void
  onDeleteRequested: () => void
  onOpenLink: (id: string) => void
  t: PropsLocale<'memory'>['t']
}) {
  const { view, onBeginEdit, onDeleteRequested, onOpenLink, t } = props
  const selection = view.selection
  /* v8 ignore next -- the parent ternary guards this null check; selection is never null here */
  if (selection === null) return null
  const { note, outbound, readOnly } = selection
  const danglingTargets = outbound.filter(target => target.id === undefined)
  const danglingTitles = useMemo(() => new Set(danglingTargets.map(target => target.title)), [outbound])

  const marked = useMemo(
    () => markWikilinks(note.body, danglingTitles),
    [note.body, danglingTitles],
  )
  const fileMentions = useMemo<MarkdownFileMentions>(() => ({
    resolve: (value: string) => {
      if (!value.startsWith(WIKILINK_MENTION_PREFIX)) return undefined
      const mention = marked.mentions.get(value)
      if (mention === undefined) return undefined
      const resolved = outbound.find(candidate => candidate.title === mention.target)
      if (resolved?.id === undefined) return undefined
      return {
        label: mention.alias,
        title: mention.target,
        open: () => { onOpenLink(String(resolved.id)) },
      }
    },
  }), [marked, outbound, onOpenLink])

  const related = note.related
  const backlinks = note.backlinks
  const linksEmpty = danglingTargets.length === 0 && related.length === 0 && backlinks.length === 0

  return (
    <div className={css.detail}>
      <header className={css.detailHeader}>
        <h3 className={css.detailTitle}>{note.title}</h3>
        <div className={css.detailActions}>
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              icon={<IconEditOutline16 />}
              onClick={() => { onBeginEdit({ title: note.title, body: note.body, tags: note.tags }) }}
            >
              {t('detail.edit')}
            </Button>
          )}
          {!readOnly && (
            <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={onDeleteRequested}>
              {t('detail.delete')}
            </Button>
          )}
        </div>
      </header>
      <div className={css.detailTags}>
        {note.tags.map(tag => <Pill key={tag} className={css.tag}>{tag}</Pill>)}
      </div>
      {readOnly && <p className={css.readOnly}>{t('detail.readOnly')}</p>}
      <div className={css.body}>
        <MarkdownText text={marked.text} fileMentions={fileMentions} />
      </div>
      {!linksEmpty && (
        <div className={css.links}>
          {backlinks.length > 0 && (
            <section className={css.linkColumn}>
              <h4 className={css.linkHeading}>{t('detail.backlinks')}</h4>
              <ul className={css.linkList}>
                {backlinks.map(target => (
                  <LinkTarget key={target.title} target={target} onOpen={onOpenLink} t={t} />
                ))}
              </ul>
            </section>
          )}
          {related.length > 0 && (
            <section className={css.linkColumn}>
              <h4 className={css.linkHeading}>{t('detail.related')}</h4>
              <ul className={css.linkList}>
                {related.map(target => (
                  <LinkTarget key={target.title} target={target} onOpen={onOpenLink} t={t} />
                ))}
              </ul>
            </section>
          )}
          {danglingTargets.length > 0 && (
            <section className={css.linkColumn}>
              <h4 className={css.linkHeading}>{t('detail.dangling')}</h4>
              <ul className={css.linkList}>
                {danglingTargets.map(target => (
                  <LinkTarget key={target.title} target={target} onOpen={onOpenLink} t={t} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

/** The field-based edit form with the conflict notice. */
function NoteEditForm(props: {
  view: MemoryPanelSnapshot
  draft: MemoryDraft
  onDraft: (draft: MemoryDraft) => void
  onCancel: () => void
  onSave: (draft: MemoryDraft) => Promise<SaveOutcome>
  onSaved: () => void
  t: PropsLocale<'memory'>['t']
}) {
  const { view, draft, onDraft, onCancel, onSave, onSaved, t } = props
  const [titleError, setTitleError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const conflict = view.selection?.conflict ?? null

  const save = async (): Promise<void> => {
    if (draft.title.trim() === '') {
      setTitleError(true)
      return
    }
    setSaving(true)
    setFailed(false)
    const outcome = await onSave({
      title: draft.title.trim(),
      body: draft.body,
      tags: draft.tags,
    })
    setSaving(false)
    if (outcome.outcome === 'committed') onSaved()
    else if (outcome.outcome === 'failed') setFailed(true)
    // Conflict: the controller snapshot carries the notice; the user can save again.
  }

  return (
    <form className={css.editForm} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className={css.field}>
        <label className={css.fieldInline} htmlFor="memory-edit-title">
          <span className={css.fieldLabel}>{t('edit.title')}</span>
        </label>
        <input
          id="memory-edit-title"
          className={css.fieldInput}
          value={draft.title}
          aria-invalid={titleError || undefined}
          onChange={(event) => {
            setTitleError(false)
            onDraft({ ...draft, title: event.target.value })
          }}
        />
        {titleError && <span className={css.fieldError}>{t('edit.titleRequired')}</span>}
      </div>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('edit.body')}</span>
        <textarea
          className={css.fieldTextarea}
          value={draft.body}
          onChange={(event) => { onDraft({ ...draft, body: event.target.value }) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('edit.tags')}</span>
        <span className={css.fieldHint}>{t('edit.tagsHint')}</span>
        <input
          className={css.fieldInput}
          value={draft.tags.join(', ')}
          onChange={(event) => {
            const tags = event.target.value.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
            onDraft({ ...draft, tags })
          }}
        />
      </label>
      {conflict !== null && (
        <p className={css.conflict}>{t('edit.changedElsewhere', { time: conflict.updated })}</p>
      )}
      {failed && <p className={css.fieldError}>{t('edit.saveFailed')}</p>}
      <div className={css.editActions}>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t('edit.cancel')}</Button>
        <Button type="submit" variant="primary" size="sm" disabled={saving}>{t('edit.save')}</Button>
      </div>
    </form>
  )
}

/**
 * Render the detail surface for the current selection: read, edit, or the
 * loading/error state.
 * @param props - controller snapshot, store-backed draft state, and actions.
 * @returns the detail body.
 */
export function MemoryNoteView(props: MemoryNoteViewProps) {
  const { view, draft, editing, onBack, onBeginEdit, onDraft, onCancelEdit, onSave, onSaved, onDelete, onDeleted, onOpenLink, t } = props
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteFailed, setDeleteFailed] = useState(false)

  const confirmDelete = async (): Promise<void> => {
    setDeleteFailed(false)
    const committed = await onDelete()
    if (committed) {
      setConfirmingDelete(false)
      onDeleted()
    } else {
      setDeleteFailed(true)
    }
  }

  const selection = view.selection

  const body = view.selectionLoading
    ? <p className={css.empty}>{t('list.loading')}</p>
    : selection === null
      ? <p className={css.banner}>{t('detail.loadFailed')}: {view.selectionError ?? ''}</p>
      : editing && draft !== null
        ? (
          <NoteEditForm
            view={view}
            draft={draft}
            onDraft={onDraft}
            onCancel={onCancelEdit}
            onSave={onSave}
            onSaved={onSaved}
            t={t}
          />
        )
        : (
          <NoteReadView
            view={view}
            onBeginEdit={onBeginEdit}
            onDeleteRequested={() => { setConfirmingDelete(true) }}
            onOpenLink={onOpenLink}
            t={t}
          />
        )

  return (
    <div className={css.detailRoot}>
      <div className={css.detailBar}>
        <Button variant="ghost" size="sm" onClick={onBack}>{t('detail.back')}</Button>
      </div>
      {body}
      <Modal
        open={confirmingDelete}
        onClose={() => { setConfirmingDelete(false) }}
        title={t('delete.confirmTitle')}
        description={t('delete.confirmBody', { name: selection?.note.title ?? '' })}
        footer={
          <div className={css.deleteActions}>
            {deleteFailed && <span className={css.fieldError}>{t('delete.failed')}</span>}
            <Button variant="ghost" size="sm" onClick={() => { setConfirmingDelete(false) }}>{t('delete.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={() => { void confirmDelete() }}>{t('delete.confirm')}</Button>
          </div>
        }
      />
    </div>
  )
}
