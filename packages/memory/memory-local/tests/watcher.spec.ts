import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { VaultWatcher } from '../src/watcher.ts'
import type { WatchImpl, WatchLike } from '../src/watcher.ts'

const DIR = join('vault')

class FakeHandle implements WatchLike {
  closed = false
  options: Record<string, unknown> | undefined
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  constructor(readonly dir: string, options?: Record<string, unknown>) {
    this.options = options
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function harness() {
  const handles: FakeHandle[] = []
  const watchImpl: WatchImpl = vi.fn((dir: string, options?: Record<string, unknown>) => {
    const handle = new FakeHandle(dir, options)
    handles.push(handle)
    return handle
  })
  const changes = vi.fn(async () => {})
  const warn = vi.fn()
  const watcher = new VaultWatcher(DIR, 5, changes, watchImpl, warn)
  return { handles, watchImpl, changes, warn, watcher }
}

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('VaultWatcher', () => {
  it('watches with ignoreInitial and a filtering ignored predicate', async () => {
    const { handles, watcher, watchImpl } = harness()
    watcher.start()
    expect(watchImpl).toHaveBeenCalledWith(DIR, expect.objectContaining({ ignoreInitial: true }))
    const ignored = handles[0]!.options!.ignored as (path: unknown) => boolean
    expect(ignored(join(DIR, '.memory-index.sqlite'))).toBe(true)
    expect(ignored(join(DIR, '.obsidian', 'workspace.json'))).toBe(true)
    expect(ignored(join(DIR, '.obsidian'))).toBe(true)
    expect(ignored(join(DIR, 'notes', 'a.txt'))).toBe(true)
    expect(ignored(join(DIR, 'notes', 'a.md'))).toBe(false)
    expect(ignored(join(DIR, 'MEMORY.md'))).toBe(false)
    await watcher.dispose()
    expect(handles[0]!.closed).toBe(true)
  })

  it('debounces changes into one batch and runs the ready-time full pass', async () => {
    const { handles, changes, watcher } = harness()
    watcher.start()
    handles[0]!.emit('all', 'change', join(DIR, 'a.md'))
    handles[0]!.emit('all', 'change', join(DIR, 'b.md'))
    await tick(10)
    expect(changes).toHaveBeenCalledTimes(1)
    expect(changes).toHaveBeenCalledWith([join(DIR, 'a.md'), join(DIR, 'b.md')])
    handles[0]!.emit('ready')
    await tick(0)
    expect(changes).toHaveBeenLastCalledWith([])
    await watcher.dispose()
  })

  it('lets the ready-time full pass supersede a pending incremental batch', async () => {
    const { handles, changes, watcher } = harness()
    watcher.start()
    handles[0]!.emit('all', 'change', join(DIR, 'a.md'))
    handles[0]!.emit('ready')
    await tick(10)
    expect(changes).toHaveBeenCalledTimes(1)
    expect(changes).toHaveBeenCalledWith([])
    await watcher.dispose()
  })

  it('contains watcher errors and change-handler failures through warn', async () => {
    const { handles, changes, warn, watcher } = harness()
    changes.mockRejectedValueOnce(new Error('reconcile failed'))
    watcher.start()
    handles[0]!.emit('all', 'change', join(DIR, 'a.md'))
    await tick(10)
    expect(warn).toHaveBeenCalledWith(expect.any(Error))
    handles[0]!.emit('error', new Error('watcher backend failure'))
    expect(warn).toHaveBeenCalledTimes(2)
    await watcher.dispose()
  })

  it('drops events after dispose and waits for queued work to settle', async () => {
    const { handles, changes, watcher } = harness()
    let release: () => void = () => {}
    changes.mockImplementation(async () => { await new Promise<void>((resolve) => { release = resolve }) })
    watcher.start()
    handles[0]!.emit('all', 'change', join(DIR, 'a.md'))
    await tick(10)
    const disposal = watcher.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await tick(0)
    expect(disposed).toBe(false)
    release()
    await disposal
    expect(disposed).toBe(true)
    expect(handles[0]!.closed).toBe(true)
  })

  it('start is idempotent and ignores second starts', async () => {
    const { handles, watcher } = harness()
    watcher.start()
    watcher.start()
    expect(handles).toHaveLength(1)
    await watcher.dispose()
  })

  it('ignores start, change, and ready events after dispose', async () => {
    const { handles, changes, watcher } = harness()
    watcher.start()
    await watcher.dispose()
    watcher.start()
    handles[0]!.emit('all', 'change', join(DIR, 'a.md'))
    handles[0]!.emit('ready')
    await tick(10)
    expect(handles).toHaveLength(1)
    expect(changes).not.toHaveBeenCalled()
  })

  it('clears a still-armed debounce timer on dispose', async () => {
    const { handles, changes, watcher } = harness()
    watcher.start()
    handles[0]!.emit('all', 'change', join(DIR, 'a.md'))
    await watcher.dispose()
    await tick(10)
    expect(changes).not.toHaveBeenCalled()
  })

  it('runs the default silent warn callback when none is supplied', async () => {
    const handle = new FakeHandle(DIR)
    const watchImpl: WatchImpl = () => handle
    const changes = vi.fn(async () => {})
    const watcher = new VaultWatcher(DIR, 5, changes, watchImpl)
    watcher.start()
    handle.emit('error', new Error('boom'))
    expect(changes).not.toHaveBeenCalled()
    await watcher.dispose()
  })

  it('dispose is idempotent', async () => {
    const { watcher } = harness()
    watcher.start()
    await watcher.dispose()
    await watcher.dispose()
  })
})
