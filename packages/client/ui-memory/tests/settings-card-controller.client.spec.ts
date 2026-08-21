/** Settings card controller: staged knobs, revision-fenced save, discard, global dir. */
import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { MemorySettingsCardController } from '../src/client/settings/settings-card-controller.ts'
import type { MemoryLifecycleCardSettings } from '../src/client/settings/settings-card-controller.ts'

function remote(infoResult: {
  ok: true
  value: { globalDir: string }
} | {
  ok: false
  error: { code: string; message: string; details: object }
}) {
  return {
    info: vi.fn(() => Promise.resolve(infoResult)),
    list: vi.fn(),
    read: vi.fn(),
    search: vi.fn(),
    write: vi.fn(),
    delete: vi.fn(),
  }
}

function readyScope(value: MemoryLifecycleCardSettings) {
  const stub = stubSettingsScope<MemoryLifecycleCardSettings>()
  stub.publish({ status: 'ready', writable: true, revision: 1, value })
  return stub
}

describe('MemorySettingsCardController', () => {
  it('starts with the schema defaults while the scope loads', () => {
    const stub = stubSettingsScope<MemoryLifecycleCardSettings>()
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    const state = controller.getSnapshot()
    expect(state.status).toBe('loading')
    expect(state.fields.distill.value).toBe(true)
    expect(state.fields.distillMode.value).toBe('concise')
    expect(state.fields.minTurnChars).toMatchObject({ value: 40, text: '40', invalid: false })
    expect(state.globalDir).toEqual({ kind: 'loading' })
  })

  it('publishes the served values and the global vault directory', async () => {
    const stub = readyScope({ minTurnChars: 12, reviewAfterDays: 7 })
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().fields.minTurnChars.value).toBe(12)
    await Promise.resolve()
    expect(controller.getSnapshot().globalDir).toEqual({ kind: 'dir', dir: 'G:/vault' })
  })

  it('marks the directory unavailable when info() fails', async () => {
    const stub = readyScope({})
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: false, error: { code: 'internal', message: 'offline', details: {} } }))
    await Promise.resolve()
    expect(controller.getSnapshot().globalDir).toEqual({ kind: 'unavailable' })
  })

  it('retries while the namespace methods are still installing', async () => {
    const stub = readyScope({})
    let installed = false
    const controller = new MemorySettingsCardController(stub.scope, () => installed
      ? remote({ ok: true, value: { globalDir: 'G:/vault' } })
      : ({}) as never)
    expect(controller.getSnapshot().globalDir).toEqual({ kind: 'loading' })
    installed = true
    await vi.waitFor(() => { expect(controller.getSnapshot().globalDir).toEqual({ kind: 'dir', dir: 'G:/vault' }) })
  })

  it('settles the directory unavailable when the info() call rejects', async () => {
    const stub = readyScope({})
    const controller = new MemorySettingsCardController(stub.scope, () => ({ info: () => Promise.reject(new Error('carrier down')) }) as never)
    await vi.waitFor(() => { expect(controller.getSnapshot().globalDir).toEqual({ kind: 'unavailable' }) })
  })

  it('projects an unavailable scope status', () => {
    const stub = stubSettingsScope<MemoryLifecycleCardSettings>()
    stub.publish({ status: 'unavailable', writable: false, revision: 0, value: undefined })
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    expect(controller.getSnapshot().status).toBe('unavailable')
  })

  it('stages numeric text and flags invalid input without writing', () => {
    const stub = readyScope({})
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    controller.editNumber('minTurnChars', 'abc')
    expect(controller.getSnapshot().fields.minTurnChars).toMatchObject({ text: 'abc', invalid: true })
    expect(controller.getSnapshot().dirty).toBe(true)
    expect(stub.set).not.toHaveBeenCalled()
    controller.editNumber('minTurnChars', '60')
    expect(controller.getSnapshot().fields.minTurnChars).toMatchObject({ text: '60', invalid: false })
  })

  it('stages the mode and the distill toggle', () => {
    const stub = readyScope({})
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    controller.editMode('detailed')
    expect(controller.getSnapshot().fields.distillMode.value).toBe('detailed')
    controller.toggleDistill()
    expect(controller.getSnapshot().fields.distill.value).toBe(false)
  })

  it('save commits valid staged fields through the scope and flashes saved', async () => {
    vi.useFakeTimers()
    try {
      const stub = readyScope({})
      const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
      controller.editNumber('minTurnChars', '60')
      controller.editMode('detailed')
      controller.toggleDistill()
      await controller.save()
      expect(stub.set).toHaveBeenCalledWith('minTurnChars', 60)
      expect(stub.set).toHaveBeenCalledWith('distillMode', 'detailed')
      expect(stub.set).toHaveBeenCalledWith('distill', false)
      const state = controller.getSnapshot()
      expect(state.saving).toBe(false)
      expect(state.saved).toBe(true)
      expect(state.dirty).toBe(false)
      vi.advanceTimersByTime(2600)
      expect(controller.getSnapshot().saved).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('save skips invalid staged numbers but commits the valid ones', async () => {
    const stub = readyScope({})
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    controller.editNumber('minTurnChars', '0')
    controller.editNumber('maxInjectBytes', '100')
    await controller.save()
    expect(stub.set).not.toHaveBeenCalledWith('minTurnChars', expect.anything())
    expect(stub.set).toHaveBeenCalledWith('maxInjectBytes', 100)
  })

  it('a rejected write surfaces the error and keeps the stage', async () => {
    const stub = readyScope({})
    stub.set.mockRejectedValueOnce(new Error('revision mismatch'))
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    controller.editNumber('minTurnChars', '60')
    await controller.save()
    expect(controller.getSnapshot()).toMatchObject({ error: 'revision mismatch', saving: false })
    expect(controller.getSnapshot().dirty).toBe(true)
  })

  it('a non-Error write rejection surfaces its string form', async () => {
    const stub = readyScope({})
    stub.set.mockRejectedValueOnce('revision mismatch')
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    controller.editNumber('minTurnChars', '60')
    await controller.save()
    expect(controller.getSnapshot()).toMatchObject({ error: 'revision mismatch', saving: false })
  })

  it('discard drops the stage and resyncs from the scope', () => {
    const stub = readyScope({ minTurnChars: 40 })
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    controller.editNumber('minTurnChars', '99')
    controller.discard()
    const state = controller.getSnapshot()
    expect(state.dirty).toBe(false)
    expect(state.fields.minTurnChars.text).toBe('40')
  })

  it('the user-layer presence marks a field overridden', () => {
    const stub = stubSettingsScope<MemoryLifecycleCardSettings>()
    stub.publish({ status: 'ready', writable: true, revision: 1, value: { minTurnChars: 40 }, user: { minTurnChars: 40 } })
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    expect(controller.getSnapshot().fields.minTurnChars.overridden).toBe(true)
    expect(controller.getSnapshot().fields.reviewAfterDays.overridden).toBe(false)
  })

  it('scope changes resync the accepted values while the stage stays', () => {
    const stub = readyScope({ minTurnChars: 40 })
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    controller.editNumber('reviewAfterDays', '9')
    stub.publish({ status: 'ready', writable: true, revision: 2, value: { minTurnChars: 55, reviewAfterDays: 7 } })
    const state = controller.getSnapshot()
    expect(state.fields.minTurnChars.value).toBe(55)
    expect(state.fields.reviewAfterDays.text).toBe('9')
  })

  it('a second save replaces the pending saved-flash timer', async () => {
    vi.useFakeTimers()
    try {
      const stub = readyScope({})
      const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
      controller.editNumber('minTurnChars', '60')
      await controller.save()
      controller.editNumber('minTurnChars', '70')
      await controller.save()
      vi.advanceTimersByTime(2500)
      expect(controller.getSnapshot().saved).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose clears the pending saved-flash timer', async () => {
    vi.useFakeTimers()
    try {
      const stub = readyScope({})
      const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
      controller.editNumber('minTurnChars', '60')
      await controller.save()
      controller.dispose()
      controller.refreshGlobalDir()
      vi.advanceTimersByTime(3000)
      expect(controller.getSnapshot().saved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose stops publishing and clears the saved-flash timer', async () => {
    vi.useFakeTimers()
    try {
      const stub = readyScope({})
      const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
      const listener = vi.fn()
      controller.subscribe(listener)
      controller.dispose()
      controller.editNumber('minTurnChars', '60')
      stub.publish({ status: 'ready', writable: true, revision: 2, value: {} })
      expect(listener).not.toHaveBeenCalled()
      await controller.save()
      expect(stub.set).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('notifies subscribers when the snapshot changes', () => {
    const stub = readyScope({})
    const controller = new MemorySettingsCardController(stub.scope, () => remote({ ok: true, value: { globalDir: 'G:/vault' } }))
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.editNumber('minTurnChars', '60')
    expect(listener).toHaveBeenCalled()
    expect(controller.getSnapshot().fields.minTurnChars.text).toBe('60')
  })

  it('dispose during the namespace install retry silences the queued attempt', async () => {
    const stub = readyScope({})
    const controller = new MemorySettingsCardController(stub.scope, () => ({}) as never)
    controller.dispose()
    await Promise.resolve()
    expect(controller.getSnapshot().globalDir).toEqual({ kind: 'loading' })
  })

  it('dispose mid-refresh silences a pending rejection', async () => {
    const stub = readyScope({})
    let reject!: (reason: unknown) => void
    const controller = new MemorySettingsCardController(stub.scope, () => ({
      info: () => new Promise((_res, rej) => { reject = rej }),
    }) as never)
    controller.dispose()
    reject(new Error('carrier down'))
    await Promise.resolve()
    expect(controller.getSnapshot().globalDir).toEqual({ kind: 'loading' })
  })
})
