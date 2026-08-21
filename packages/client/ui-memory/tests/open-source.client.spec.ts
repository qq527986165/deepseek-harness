/** Open-request source: publish replaces, clear resets, disposal unsubscribes. */
import { describe, expect, it, vi } from 'vitest'
import { MemoryPanelOpenSource } from '../src/client/panel/open-source.ts'

describe('MemoryPanelOpenSource', () => {
  it('publishes one request and clears it', () => {
    const source = new MemoryPanelOpenSource()
    const seen: Array<unknown> = []
    source.subscribe(() => { seen.push(source.getSnapshot()) })
    expect(source.getSnapshot()).toBeNull()

    source.publish({ ref: 'n1', scope: 'project' })
    expect(source.getSnapshot()).toEqual({ ref: 'n1', scope: 'project' })

    source.clear()
    expect(source.getSnapshot()).toBeNull()
    expect(seen).toEqual([{ ref: 'n1', scope: 'project' }, null])
  })

  it('a later publish replaces an unacknowledged request', () => {
    const source = new MemoryPanelOpenSource()
    const seen: Array<unknown> = []
    source.subscribe(() => { seen.push(source.getSnapshot()) })
    source.publish({ ref: 'n1', scope: 'global' })
    source.publish({ ref: 'n2', scope: 'project', readOnly: true })
    expect(seen).toEqual([{ ref: 'n1', scope: 'global' }, { ref: 'n2', scope: 'project', readOnly: true }])
  })

  it('clear without a request publishes nothing', () => {
    const source = new MemoryPanelOpenSource()
    const listener = vi.fn()
    source.subscribe(listener)
    source.clear()
    expect(listener).not.toHaveBeenCalled()
  })
})
