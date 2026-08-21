/** The panel viewing store: shared open/scope/query/selection/draft state. */
import { describe, expect, it } from 'vitest'
import { createMemoryPanelStore } from '../src/client/stores.ts'

function fresh() {
  const handle = createMemoryPanelStore()
  const store = handle.create()
  return { store, actions: store.actions, snapshot: () => store.getSnapshot() }
}

describe('createMemoryPanelStore', () => {
  it('starts closed on the global tab with no selection', () => {
    const { snapshot } = fresh()
    expect(snapshot()).toEqual({
      open: false,
      scope: 'global',
      workspaceDir: undefined,
      query: '',
      selection: null,
      editing: false,
      draft: null,
    })
  })

  it('openPanel opens and pins an explicit scope, resetting the project dir otherwise', () => {
    const { actions, snapshot } = fresh()
    actions.openPanel('project', '/workspace')
    expect(snapshot()).toMatchObject({ open: true, scope: 'project', workspaceDir: '/workspace' })
    actions.openPanel('global')
    expect(snapshot()).toMatchObject({ open: true, scope: 'global', workspaceDir: undefined })
  })

  it('openPanel preserves the current project workspace when the arg is omitted', () => {
    const { actions, snapshot } = fresh()
    actions.openPanel('project', '/workspace')
    actions.close()
    actions.openPanel('project')
    expect(snapshot()).toMatchObject({ open: true, scope: 'project', workspaceDir: '/workspace' })
  })

  it('setScope resets the query, selection, and edit state', () => {
    const { actions, snapshot } = fresh()
    actions.setQuery('coffee')
    actions.select('n1')
    actions.beginEdit({ title: 'T', body: 'B', tags: ['t'] })
    actions.setScope('project')
    expect(snapshot()).toMatchObject({
      scope: 'project',
      workspaceDir: undefined,
      query: '',
      selection: null,
      editing: false,
      draft: null,
    })
  })

  it('setWorkspaceDir resets the query and selection', () => {
    const { actions, snapshot } = fresh()
    actions.setScope('project')
    actions.setQuery('x')
    actions.setWorkspaceDir('/w')
    expect(snapshot()).toMatchObject({ workspaceDir: '/w', query: '', selection: null })
  })

  it('selection, edit, and draft flows keep their invariants', () => {
    const { actions, snapshot } = fresh()
    actions.select('n1')
    expect(snapshot()).toMatchObject({ selection: 'n1', editing: false, draft: null })
    actions.beginEdit({ title: 'A', body: 'b', tags: [] })
    expect(snapshot()).toMatchObject({ editing: true, draft: { title: 'A', body: 'b', tags: [] } })
    actions.setDraft({ title: 'A2', body: 'b2', tags: ['x'] })
    expect(snapshot().draft).toEqual({ title: 'A2', body: 'b2', tags: ['x'] })
    actions.cancelEdit()
    expect(snapshot()).toMatchObject({ editing: false, draft: null, selection: 'n1' })
    actions.backToList()
    expect(snapshot()).toMatchObject({ selection: null })
  })

  it('close only folds the drawer', () => {
    const { actions, snapshot } = fresh()
    actions.openPanel()
    actions.setQuery('q')
    actions.close()
    expect(snapshot()).toMatchObject({ open: false, query: 'q' })
  })
})
