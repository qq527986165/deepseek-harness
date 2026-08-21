/**
 * The `memory-distill` Chat node: one chip per committed topic node. Pure
 * presentation: every navigation rides the injected `openNote` callback.
 * @module @deepseek-ai/dsh-client-ui-memory/client/distill/MemoryDistillNode
 */
import { Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryDistillNoteWrite } from '@deepseek-ai/dsh-memory-lifecycle/types'
import type { MemoryDistillInjected } from '../contract/slots.ts'
import css from './MemoryDistillNode.module.css'

/** Complete keyed Chat renderer props. */
export type MemoryDistillNodeProps =
  & PropsRuntime<'conversation.chat.node', 'memory-distill'>
  & PropsLocale<'memory'>
  & MemoryDistillInjected

/** One committed topic-node chip. */
function NoteChip(props: {
  note: MemoryDistillNoteWrite
  onOpen: () => void
  t: MemoryDistillNodeProps['t']
}) {
  const { note, onOpen, t } = props
  return (
    <Pill
      className={css.chip}
      onClick={onOpen}
      aria-label={t('distill.noteOpen', { title: note.title })}
    >
      {note.title}
    </Pill>
  )
}

/** Render one chip for each node in a committed distillation receipt. */
export function MemoryDistillNode({ node, cwd, openNote, t }: MemoryDistillNodeProps) {
  const { notes } = node.data
  return (
    <section className={css.root} data-memory-distill>
      <h3 className={css.title}>{t('distill.title')}</h3>
      <div className={css.chips}>
        {notes.map(note => (
          <NoteChip
            key={note.id}
            note={note}
            onOpen={() => {
              openNote({
                ref: note.id,
                scope: note.scope,
                ...(note.scope === 'project' && cwd !== undefined ? { workspaceDir: cwd } : {}),
              })
            }}
            t={t}
          />
        ))}
      </div>
    </section>
  )
}
