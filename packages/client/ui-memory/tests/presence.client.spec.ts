/** Presence tracker: probes flip present/absent, rearm re-probes, dispose silences. */
import { describe, expect, it, vi } from 'vitest'
import { MemoryRemotePresenceTracker } from '../src/client/panel/presence.ts'
import type { MemoryRemote } from '../src/client/contract/remote.ts'

function remote(infoResult: Promise<{ ok: boolean }>): MemoryRemote & { info: ReturnType<typeof vi.fn> } {
  const info = vi.fn(() => infoResult)
  return {
    info,
    list: vi.fn(),
    read: vi.fn(),
    search: vi.fn(),
    write: vi.fn(),
    delete: vi.fn(),
  } as never
}

describe('MemoryRemotePresenceTracker', () => {
  it('starts probing and flips present on a successful info()', async () => {
    const tracker = new MemoryRemotePresenceTracker(() => remote(Promise.resolve({ ok: true })))
    expect(tracker.getSnapshot()).toBe('probing')
    const changes: string[] = []
    tracker.subscribe(() => { changes.push(tracker.getSnapshot()) })
    tracker.probe()
    expect(tracker.getSnapshot()).toBe('probing')
    await Promise.resolve()
    expect(tracker.getSnapshot()).toBe('present')
    expect(changes).toEqual(['present'])
  })

  it('flips absent on a failed info()', async () => {
    const tracker = new MemoryRemotePresenceTracker(() => remote(Promise.resolve({ ok: false })))
    tracker.probe()
    await Promise.resolve()
    expect(tracker.getSnapshot()).toBe('absent')
  })

  it('settles absent when the info() call rejects', async () => {
    const tracker = new MemoryRemotePresenceTracker(() => remote(Promise.reject(new Error('carrier down'))))
    tracker.probe()
    await Promise.resolve()
    expect(tracker.getSnapshot()).toBe('absent')
  })

  it('rearm re-probes after a connection reset', async () => {
    const calls: Array<{ ok: boolean }> = []
    const info = vi.fn(() => Promise.resolve(calls.shift() ?? { ok: true }))
    const tracker = new MemoryRemotePresenceTracker(() => ({ info }) as never)
    tracker.probe()
    await Promise.resolve()
    expect(tracker.getSnapshot()).toBe('present')

    calls.push({ ok: false })
    tracker.rearm()
    expect(tracker.getSnapshot()).toBe('probing')
    await Promise.resolve()
    expect(tracker.getSnapshot()).toBe('absent')
    expect(info).toHaveBeenCalledTimes(2)
  })

  it('stops publishing and unsubscribes on dispose', async () => {
    const tracker = new MemoryRemotePresenceTracker(() => remote(Promise.resolve({ ok: true })))
    const listener = vi.fn()
    const off = tracker.subscribe(listener)
    tracker.probe()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
    off()
    tracker.rearm()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
    tracker.dispose()
  })

  it('retries while the namespace methods are still installing', async () => {
    let installed = false
    const tracker = new MemoryRemotePresenceTracker(() => installed
      ? ({ info: () => Promise.resolve({ ok: true }) }) as never
      : ({} as never))
    tracker.probe()
    await Promise.resolve()
    expect(tracker.getSnapshot()).toBe('probing')
    installed = true
    await vi.waitFor(() => { expect(tracker.getSnapshot()).toBe('present') })
  })

  it('dispose silences probe and rearm', () => {
    const tracker = new MemoryRemotePresenceTracker(() => remote(Promise.resolve({ ok: true })))
    tracker.dispose()
    tracker.probe()
    tracker.rearm()
    expect(tracker.getSnapshot()).toBe('probing')
  })

  it('dispose during the install retry silences the queued attempt', async () => {
    const tracker = new MemoryRemotePresenceTracker(() => ({} as never))
    tracker.probe() // info() missing -> the attempt queues one retry
    tracker.dispose()
    await Promise.resolve()
    expect(tracker.getSnapshot()).toBe('probing')
  })

  it('dispose mid-probe silences a pending resolution', async () => {
    let resolve!: (value: { ok: boolean }) => void
    const tracker = new MemoryRemotePresenceTracker(() => ({
      info: () => new Promise<{ ok: boolean }>((res) => { resolve = res }),
    }) as never)
    tracker.probe()
    tracker.dispose()
    resolve({ ok: true })
    await Promise.resolve()
    expect(tracker.getSnapshot()).toBe('probing')
  })

  it('dispose mid-probe silences a pending rejection', async () => {
    let reject!: (reason: unknown) => void
    const tracker = new MemoryRemotePresenceTracker(() => ({
      info: () => new Promise<{ ok: boolean }>((_res, rej) => { reject = rej }),
    }) as never)
    tracker.probe()
    tracker.dispose()
    reject(new Error('carrier down'))
    await Promise.resolve()
    expect(tracker.getSnapshot()).toBe('probing')
  })
})
