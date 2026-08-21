// @vitest-environment jsdom
/** The memory-distill node: one chip per committed topic node. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { MemoryDistillNoteWrite } from '@deepseek-ai/dsh-memory-lifecycle/types'
import { zh } from '../src/client/locales.ts'
import { MemoryDistillNode } from '../src/client/distill/MemoryDistillNode.tsx'
import type { MemoryDistillChatData } from '../src/client/distill/distill-definition.ts'

afterEach(cleanup)

function note(overrides: Partial<MemoryDistillNoteWrite> = {}): MemoryDistillNoteWrite {
  return {
    id: 'w1', scope: 'global', title: '笔记A', path: 'notes/a-1a2b3c4d.md', journalAnchor: '^memory-1a2b3c4d-global', ...overrides,
  }
}

function data(notes: MemoryDistillChatData['notes']): MemoryDistillChatData {
  return { notes }
}

function bench(distillData: MemoryDistillChatData, owner: { cwd?: string } = { cwd: 'G:/project' }) {
  const openNote = vi.fn()
  const t = makeTranslate(zh)
  const props = {
    node: { key: 'k', kind: 'memory-distill', id: '1', data: distillData },
    ...owner,
    openNote,
    t: t as never,
  } as unknown as Parameters<typeof MemoryDistillNode>[0]
  return { props, openNote }
}

describe('MemoryDistillNode', () => {
  it('renders the title and one title-only chip per committed node', () => {
    const { props } = bench(data([
      note({ id: 'w1', title: '笔记A', scope: 'global' }),
      note({ id: 'w2', title: '笔记B', scope: 'project' }),
    ]))
    const view = render(<MemoryDistillNode {...props} />)
    expect(view.getByRole('heading', { name: '记忆蒸馏' })).toBeTruthy()
    expect(view.getByRole('button', { name: '打开笔记「笔记A」' })).toBeTruthy()
    expect(view.getByRole('button', { name: '打开笔记「笔记B」' })).toBeTruthy()
    expect(view.container.textContent).toBe('记忆蒸馏笔记A笔记B')
  })

  it('opens a project note with the session workspace directory', () => {
    const { props, openNote } = bench(data([note({ id: 'w1', title: '笔记A', scope: 'project' })]))
    const view = render(<MemoryDistillNode {...props} />)
    fireEvent.click(view.getByRole('button', { name: '打开笔记「笔记A」' }))
    expect(openNote).toHaveBeenCalledWith({ ref: 'w1', scope: 'project', workspaceDir: 'G:/project' })
  })

  it('leaves the workspace directory absent when the project session has no cwd', () => {
    const { props, openNote } = bench(
      data([note({ id: 'w1', title: '笔记A', scope: 'project' })]),
      {},
    )
    const view = render(<MemoryDistillNode {...props} />)
    fireEvent.click(view.getByRole('button', { name: '打开笔记「笔记A」' }))
    expect(openNote).toHaveBeenCalledWith({ ref: 'w1', scope: 'project' })
  })

  it('opens a global note without a workspace directory', () => {
    const { props, openNote } = bench(data([note({ id: 'w1', title: '笔记A', scope: 'global' })]))
    const view = render(<MemoryDistillNode {...props} />)
    fireEvent.click(view.getByRole('button', { name: '打开笔记「笔记A」' }))
    expect(openNote).toHaveBeenCalledWith({ ref: 'w1', scope: 'global' })
  })
})
