/** Panel controller: listing, search, read+adjacency, conflict-aware save, delete, reconciliation. */
import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MemoryDeleteResult, MemoryListResult, MemoryNote, MemoryRemoteListRequest, MemoryRemoteReadRequest, MemoryRemoteSearchRequest, MemoryRemoteWriteRequest, MemorySearchHit, MemoryWriteResult } from '@deepseek-ai/dsh-memory-remote/types'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory/types'
import { MemoryPanelController } from '../src/client/panel/controller.ts'

function note(id: string, title: string, body: string, updated = 1, extra: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: MemoryNoteId(id),
    scope: 'global',
    title,
    path: `notes/${id}.md`,
    tags: ['t'],
    body,
    updated,
    related: [],
    backlinks: [],
    ...extra,
  }
}

function ok<T>(value: T) {
  return Promise.resolve({ ok: true as const, value })
}

function fail(message: string) {
  return Promise.resolve({ ok: false as const, error: { code: 'internal', message, details: {} } })
}

/** A controllable fake memory Remote with call recorders. */
function fakeRemote() {
  const calls: string[] = []
  const remote = {
    info: vi.fn(() => { calls.push('info'); return ok({ globalDir: 'G:/vault' }) }),
    list: vi.fn((request: MemoryRemoteListRequest): Promise<RemoteResult<MemoryListResult>> => {
      calls.push(`list:${request.scope}:${request.workspaceDir ?? ''}`)
      return ok({ dir: 'G:/vault', scope: request.scope, notes: [{ id: MemoryNoteId('n1'), path: 'notes/a.md', title: 'A', tags: ['x'], updated: 100, excerpt: 'first', persona: false }] })
    }),
    read: vi.fn((request: MemoryRemoteReadRequest) => {
      calls.push(`read:${request.ref}`)
      const ref = request.ref
      if (ref === 'missing') return fail('no memory note matches "missing"')
      if (ref === 'n1') return ok(note('n1', 'A', 'body of A'))
      if (ref === 'A') return ok(note('n1', 'A', 'body of A'))
      if (ref === 'Other') return ok(note('n2', 'Other', 'other'))
      if (ref === 'n2') return ok(note('n2', 'Other', 'other'))
      return fail(`no memory note matches "${ref}"`)
    }),
    search: vi.fn((request: MemoryRemoteSearchRequest): Promise<RemoteResult<MemorySearchHit[]>> => {
      calls.push(`search:${request.query}`)
      return ok([{ id: MemoryNoteId('n1'), scope: 'global' as const, title: 'A', snippet: 'snip', tags: ['x'] }])
    }),
    write: vi.fn((request: MemoryRemoteWriteRequest): Promise<RemoteResult<MemoryWriteResult>> => {
      calls.push(`write:${request.title}`)
      return ok({ id: MemoryNoteId('n1'), scope: 'global' as const, title: request.title, path: 'notes/a.md', created: 'c', updated: 'u' })
    }),
    delete: vi.fn((): Promise<RemoteResult<MemoryDeleteResult>> => {
      calls.push('delete')
      return ok({ id: MemoryNoteId('n1'), scope: 'global' as const, title: 'A', path: 'notes/a.md', trashPath: 'G:/trash/a.md' })
    }),
  }
  return { remote, calls }
}

function bench() {
  const settings = stubSettingsScope<{ reviewAfterDays?: number }>()
  const { remote, calls } = fakeRemote()
  const controller = new MemoryPanelController(() => remote, settings.scope)
  return { controller, settings, remote, calls }
}

describe('MemoryPanelController', () => {
  it('starts idle with defaults and loads the global vault directory', async () => {
    const { controller } = bench()
    const initial = controller.getSnapshot()
    expect(initial.status).toBe('idle')
    expect(initial.globalDir).toBeNull()
    expect(initial.reviewAfterDays).toBe(30)
    await vi.waitFor(() => { expect(controller.getSnapshot().globalDir).toBe('G:/vault') })
  })

  it('setView lists one vault, persona-pinned order preserved', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    const view = controller.getSnapshot()
    expect(view.rows.map(row => row.title)).toEqual(['A'])
    expect(remote.list).toHaveBeenCalledWith({ scope: 'global' })
  })

  it('a project view without a workspace stays idle (no NO_PROJECT_SCOPE call)', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'project' })
    await vi.waitFor(() => { expect(controller.getSnapshot().scope).toBe('project') })
    expect(remote.list).not.toHaveBeenCalled()
    expect(controller.getSnapshot().status).toBe('idle')
  })

  it('a project view with a workspace addresses the vault through the directory', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'project', workspaceDir: 'C:/repo' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    expect(remote.list).toHaveBeenCalledWith({ scope: 'project', workspaceDir: 'C:/repo' })
  })

  it('setQuery searches and an empty query restores the listing', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    controller.setQuery('coffee')
    await vi.waitFor(() => { expect(controller.getSnapshot().searchHits).toHaveLength(1) })
    expect(remote.search).toHaveBeenCalledWith({ query: 'coffee', scope: 'global' })
    controller.setQuery('')
    await vi.waitFor(() => { expect(controller.getSnapshot().searchHits).toBeNull() })
    expect(controller.getSnapshot().rows.map(row => row.title)).toEqual(['A'])
  })

  it('a provider-less list publishes the providerMissing banner', async () => {
    const { controller, remote } = bench()
    remote.list.mockImplementation(() => fail('no memory provider is registered'))
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('error') })
    expect(controller.getSnapshot().providerMissing).toBe(true)
  })

  it('select resolves the note, its resolved body wikilinks, and dangling targets', async () => {
    const settings = stubSettingsScope<{ reviewAfterDays?: number }>()
    const linked = note('n1', 'A', 'See [[Other]] and [[Gone]] for more.')
    const remote = {
      info: vi.fn(() => ok({ globalDir: 'G:/vault' })),
      list: vi.fn(() => ok({ dir: 'G:/vault', scope: 'global' as const, notes: [] })),
      read: vi.fn((request: MemoryRemoteReadRequest) => {
        if (request.ref === 'n1') return ok(linked)
        if (request.ref === 'Other') return ok(note('n2', 'Other', 'other'))
        return fail(`no memory note matches "${request.ref}"`)
      }),
      search: vi.fn(() => ok([])),
      write: vi.fn(() => ok({ id: MemoryNoteId('n1'), scope: 'global' as const, title: 'A', path: 'notes/a.md', created: 'c', updated: 'u' })),
      delete: vi.fn(() => ok({ id: MemoryNoteId('n1'), scope: 'global' as const, title: 'A', path: 'notes/a.md' })),
    }
    const controller = new MemoryPanelController(() => remote, settings.scope)
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    const selection = controller.getSnapshot().selection
    expect(selection?.note.title).toBe('A')
    expect(selection?.outbound).toEqual([{ title: 'Other', id: MemoryNoteId('n2') }, { title: 'Gone' }])
    expect(selection?.readOnly).toBe(false)
  })

  it('adopted notes pin the read-only view', async () => {
    const settings = stubSettingsScope<{ reviewAfterDays?: number }>()
    const adopted = note('adopted:journal/2026-08-19.md', '2026-08-19', 'journal body')
    const remote = {
      info: vi.fn(() => ok({ globalDir: 'G:/vault' })),
      list: vi.fn(() => ok({ dir: 'G:/vault', scope: 'global' as const, notes: [] })),
      read: vi.fn(() => ok(adopted)),
      search: vi.fn(() => ok([])),
      write: vi.fn(() => ok({ id: MemoryNoteId('adopted:journal/2026-08-19.md'), scope: 'global' as const, title: '2026-08-19', path: 'journal/2026-08-19.md', created: 'c', updated: 'u' })),
      delete: vi.fn(() => ok({ id: MemoryNoteId('adopted:journal/2026-08-19.md'), scope: 'global' as const, title: '2026-08-19', path: 'journal/2026-08-19.md' })),
    }
    const controller = new MemoryPanelController(() => remote, settings.scope)
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('adopted:journal/2026-08-19.md')
    expect(controller.getSnapshot().selection?.readOnly).toBe(true)
  })

  it('save commits after a clean re-read and reselects the refreshed note', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    const outcome = await controller.save({ title: 'A', body: 'updated body', tags: ['t'] })
    expect(outcome).toEqual({ outcome: 'committed' })
    expect(remote.write).toHaveBeenCalledWith({
      id: MemoryNoteId('n1'),
      scope: 'global',
      title: 'A',
      content: 'updated body',
      tags: ['t'],
    })
    expect(controller.getSnapshot().selection?.note.body).toBe('body of A')
  })

  it('a changed update timestamp surfaces a conflict once and the next save overwrites', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    // The note changed after it was opened.
    remote.read.mockImplementation((request: MemoryRemoteReadRequest) => {
      if (request.ref === 'n1') return ok(note('n1', 'A', 'body of A', 2))
      return fail(`no memory note matches "${request.ref}"`)
    })
    const first = await controller.save({ title: 'A', body: 'mine', tags: [] })
    expect(first).toEqual({ outcome: 'conflict', updated: 2 })
    expect(controller.getSnapshot().selection?.conflict).toEqual({ updated: 2 })
    expect(remote.write).not.toHaveBeenCalled()

    const second = await controller.save({ title: 'A', body: 'mine', tags: [] })
    expect(second).toEqual({ outcome: 'committed' })
    expect(remote.write).toHaveBeenCalled()
  })

  it('deleteSelected soft-deletes and returns to the list', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    const committed = await controller.deleteSelected()
    expect(committed).toBe(true)
    expect(remote.delete).toHaveBeenCalledWith({ ref: MemoryNoteId('n1'), scope: 'global' })
    expect(controller.getSnapshot().selection).toBeNull()
  })

  it('reconcile reloads only when the changed directory matches the active vault', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    const before = remote.list.mock.calls.length
    controller.reconcile('G:/other')
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    expect(remote.list.mock.calls.length).toBe(before)
    controller.reconcile('G:/vault')
    await vi.waitFor(() => { expect(remote.list.mock.calls.length).toBe(before + 1) })
  })

  it('the settings scope feeds the review threshold and republishes on change', () => {
    const { controller, settings } = bench()
    expect(controller.getSnapshot().reviewAfterDays).toBe(30)
    settings.publish({ status: 'ready', value: { reviewAfterDays: 7 }, writable: true, revision: 1 })
    expect(controller.getSnapshot().reviewAfterDays).toBe(7)
  })

  it('dispose silences listeners and later operations', async () => {
    const { controller } = bench()
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.dispose()
    controller.setView({ scope: 'global' })
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
  })

  it('waits out the one-tick window where the remote methods install late', async () => {
    const settings = stubSettingsScope<{ reviewAfterDays?: number }>()
    const { remote } = fakeRemote()
    let resolves = 0
    const controller = new MemoryPanelController(() => {
      resolves += 1
      return resolves === 1 ? ({} as never) : remote
    }, settings.scope)
    await vi.waitFor(() => { expect(controller.getSnapshot().globalDir).toBe('G:/vault') })
  })

  it('save without an open selection commits without writing', async () => {
    const { controller, remote } = bench()
    const outcome = await controller.save({ title: 'A', body: 'b', tags: [] })
    expect(outcome).toEqual({ outcome: 'committed' })
    expect(remote.write).not.toHaveBeenCalled()
  })

  it('save surfaces a re-read failure as a failed outcome', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    remote.read.mockImplementation(() => fail('no memory note matches "n1"'))
    const outcome = await controller.save({ title: 'A', body: 'b', tags: [] })
    expect(outcome).toEqual({ outcome: 'failed', message: 'no memory note matches "n1"' })
    expect(controller.getSnapshot().status).toBe('error')
    expect(remote.write).not.toHaveBeenCalled()
  })

  it('save surfaces a provider-missing write failure with the banner', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    remote.write.mockImplementation(() => fail('no memory provider is registered'))
    const outcome = await controller.save({ title: 'A', body: 'b', tags: [] })
    expect(outcome).toEqual({ outcome: 'failed', message: 'no memory provider is registered' })
    expect(controller.getSnapshot().providerMissing).toBe(true)
  })

  it('save surfaces an ordinary write failure without the provider banner', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    remote.write.mockImplementation(() => fail('disk full'))
    const outcome = await controller.save({ title: 'A', body: 'b', tags: [] })
    expect(outcome).toEqual({ outcome: 'failed', message: 'disk full' })
    expect(controller.getSnapshot().providerMissing).toBe(false)
  })

  it('deleteSelected without a selection returns false', async () => {
    const { controller, remote } = bench()
    const committed = await controller.deleteSelected()
    expect(committed).toBe(false)
    expect(remote.delete).not.toHaveBeenCalled()
  })

  it('deleteSelected surfaces an ordinary failure', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    remote.delete.mockImplementation(() => fail('disk full'))
    const committed = await controller.deleteSelected()
    expect(committed).toBe(false)
    expect(controller.getSnapshot().status).toBe('error')
    expect(controller.getSnapshot().providerMissing).toBe(false)
  })

  it('deleteSelected flags a provider-missing failure', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    remote.delete.mockImplementation(() => fail('no memory provider is registered'))
    const committed = await controller.deleteSelected()
    expect(committed).toBe(false)
    expect(controller.getSnapshot().providerMissing).toBe(true)
  })

  it('noteOpenRequest pins the next select read-only and is consumed once', async () => {
    const { controller } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    controller.noteOpenRequest({ ref: 'n1', scope: 'global', readOnly: true })
    await controller.select('n1')
    expect(controller.getSnapshot().selection?.readOnly).toBe(true)
    await controller.select('n1')
    expect(controller.getSnapshot().selection?.readOnly).toBe(false)
  })

  it('dispose stops the info refresh queue', async () => {
    const { controller, remote } = bench()
    await vi.waitFor(() => { expect(controller.getSnapshot().globalDir).toBe('G:/vault') })
    const before = remote.info.mock.calls.length
    controller.dispose()
    controller.refreshInfo()
    await Promise.resolve()
    expect(remote.info.mock.calls.length).toBe(before)
  })

  it('a transport-level rejection propagates without poisoning the operation tail', async () => {
    const { controller, remote } = bench()
    remote.read.mockRejectedValueOnce(new Error('carrier down'))
    await expect(controller.select('n1')).rejects.toThrow('carrier down')
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
  })

  it('select surfaces an ordinary read failure on the selection', async () => {
    const { controller, remote } = bench()
    remote.read.mockImplementation(() => fail('no memory note matches "missing"'))
    await controller.select('missing')
    expect(controller.getSnapshot().selectionError).toBe('no memory note matches "missing"')
    expect(controller.getSnapshot().providerMissing).toBe(false)
    expect(controller.getSnapshot().selectionLoading).toBe(false)
  })

  it('select flags a provider-missing read failure', async () => {
    const { controller, remote } = bench()
    remote.read.mockImplementation(() => fail('no memory provider is registered'))
    await controller.select('n1')
    expect(controller.getSnapshot().providerMissing).toBe(true)
  })

  it('a save enqueued before dispose settles without reloading', async () => {
    const { controller } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    controller.dispose()
    const outcome = await controller.save({ title: 'A', body: 'b', tags: [] })
    expect(outcome).toEqual({ outcome: 'committed' })
  })

  it('drops a load superseded by a newer view', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    controller.setView({ scope: 'project', workspaceDir: 'C:/repo' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    expect(remote.list).toHaveBeenCalledTimes(1)
    expect(remote.list).toHaveBeenCalledWith({ scope: 'project', workspaceDir: 'C:/repo' })
  })

  it('drops a load when disposed while waiting for the remote', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    controller.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(remote.list).not.toHaveBeenCalled()
  })

  it('drops a list answer superseded by a newer query', async () => {
    const { controller, remote } = bench()
    let resolveList!: (value: { ok: true; value: MemoryListResult }) => void
    remote.list.mockImplementation(() => new Promise((resolve) => { resolveList = resolve }))
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(remote.list).toHaveBeenCalled() })
    controller.setQuery('coffee')
    resolveList({ ok: true, value: { dir: 'G:/vault', scope: 'global', notes: [] } })
    await vi.waitFor(() => { expect(remote.search).toHaveBeenCalledWith({ query: 'coffee', scope: 'global' }) })
    expect(controller.getSnapshot().searchHits).toHaveLength(1)
    expect(controller.getSnapshot().status).toBe('ready')
  })

  it('drops a search answer superseded by a newer query', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    let resolveSearch!: (value: { ok: true; value: MemorySearchHit[] }) => void
    remote.search.mockImplementation(() => new Promise((resolve) => { resolveSearch = resolve }))
    controller.setQuery('coffee')
    await vi.waitFor(() => { expect(remote.search).toHaveBeenCalledWith({ query: 'coffee', scope: 'global' }) })
    controller.setQuery('')
    resolveSearch({ ok: true, value: [] })
    await vi.waitFor(() => { expect(controller.getSnapshot().searchHits).toBeNull() })
    expect(controller.getSnapshot().rows.map(row => row.title)).toEqual(['A'])
  })

  it('a search failure publishes the error state', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    remote.search.mockImplementation(() => fail('search index unavailable'))
    controller.setQuery('coffee')
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('error') })
    expect(controller.getSnapshot().error).toBe('search index unavailable')
  })

  it('resolves a self wikilink to the note itself', async () => {
    const settings = stubSettingsScope<{ reviewAfterDays?: number }>()
    const selfLinked = note('n1', 'A', 'See [[A]] again.')
    const remote = {
      info: vi.fn(() => ok({ globalDir: 'G:/vault' })),
      list: vi.fn(() => ok({ dir: 'G:/vault', scope: 'global' as const, notes: [] })),
      read: vi.fn(() => ok(selfLinked)),
      search: vi.fn(() => ok([])),
      write: vi.fn(() => ok({ id: MemoryNoteId('n1'), scope: 'global' as const, title: 'A', path: 'notes/a.md', created: 'c', updated: 'u' })),
      delete: vi.fn(() => ok({ id: MemoryNoteId('n1'), scope: 'global' as const, title: 'A', path: 'notes/a.md' })),
    }
    const controller = new MemoryPanelController(() => remote, settings.scope)
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    expect(controller.getSnapshot().selection?.outbound).toEqual([{ title: 'A', id: MemoryNoteId('n1') }])
  })

  it('ignores a wikilink whose title trims to empty', async () => {
    const settings = stubSettingsScope<{ reviewAfterDays?: number }>()
    const blank = note('n1', 'A', 'See [[ ]] here.')
    const remote = {
      info: vi.fn(() => ok({ globalDir: 'G:/vault' })),
      list: vi.fn(() => ok({ dir: 'G:/vault', scope: 'global' as const, notes: [] })),
      read: vi.fn(() => ok(blank)),
      search: vi.fn(() => ok([])),
      write: vi.fn(() => ok({ id: MemoryNoteId('n1'), scope: 'global' as const, title: 'A', path: 'notes/a.md', created: 'c', updated: 'u' })),
      delete: vi.fn(() => ok({ id: MemoryNoteId('n1'), scope: 'global' as const, title: 'A', path: 'notes/a.md' })),
    }
    const controller = new MemoryPanelController(() => remote, settings.scope)
    controller.setView({ scope: 'global' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    expect(controller.getSnapshot().selection?.outbound).toEqual([])
  })

  it('a project view addresses every request through its workspace directory', async () => {
    const { controller, remote } = bench()
    controller.setView({ scope: 'project', workspaceDir: 'C:/repo' })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    await controller.select('n1')
    expect(remote.read).toHaveBeenCalledWith({ ref: 'n1', scope: 'project', workspaceDir: 'C:/repo' })
    const outcome = await controller.save({ title: 'A', body: 'b', tags: [] })
    expect(outcome).toEqual({ outcome: 'committed' })
    expect(remote.write).toHaveBeenCalledWith({
      id: MemoryNoteId('n1'),
      scope: 'project',
      title: 'A',
      content: 'b',
      tags: [],
      workspaceDir: 'C:/repo',
    })
    const committed = await controller.deleteSelected()
    expect(committed).toBe(true)
    expect(remote.delete).toHaveBeenCalledWith({ ref: MemoryNoteId('n1'), scope: 'project', workspaceDir: 'C:/repo' })
  })
})
