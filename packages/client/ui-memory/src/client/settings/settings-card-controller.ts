/**
 * Browser-local controller of the memory settings card: the six user knobs of
 * the memory-lifecycle namespace staged into a form, saved through the
 * revision-fenced settings scope, plus the read-only global vault directory
 * from `memory.info()`. React-free; publishes one snapshot through a
 * HostObservable consumed by the card component.
 * @module @deepseek-ai/dsh-client-ui-memory/client/settings/settings-card-controller
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { MemoryRemote } from '../contract/remote.ts'

/** The memory-lifecycle settings fields the card edits. */
export interface MemoryLifecycleCardSettings {
  distill?: boolean
  distillMode?: 'concise' | 'detailed'
  minTurnChars?: number
  maxInjectBytes?: number
  maxReviewCandidates?: number
  reviewAfterDays?: number
}

/** Defaults mirroring the host namespace schema when the scope answers nothing yet. */
const DEFAULT_SETTINGS: Required<MemoryLifecycleCardSettings> = Object.freeze({
  distill: true,
  distillMode: 'concise',
  minTurnChars: 40,
  maxInjectBytes: 16_384,
  maxReviewCandidates: 5,
  reviewAfterDays: 30,
})

/** One numeric field's staged display state. */
export interface CardNumberField {
  /** Last accepted value. */
  readonly value: number
  /** Current input text (staged or synced). */
  readonly text: string
  /** True when the text is not a positive integer. */
  readonly invalid: boolean
  /** True when the user layer overrides the composition default. */
  readonly overridden: boolean
}

/** One select field's staged display state. */
export interface CardSelectField {
  readonly value: 'concise' | 'detailed'
  readonly overridden: boolean
}

/** One boolean field's staged display state. */
export interface CardToggleField {
  readonly value: boolean
  readonly overridden: boolean
}

/** The read-only vault directory row. */
export type CardGlobalDir =
  | { readonly kind: 'loading' }
  | { readonly kind: 'dir'; readonly dir: string }
  | { readonly kind: 'unavailable' }

/** Immutable card snapshot published to the component. */
export interface MemorySettingsCardState {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly writable: boolean
  readonly dirty: boolean
  readonly saving: boolean
  readonly saved: boolean
  readonly error: string | null
  readonly fields: {
    readonly distill: CardToggleField
    readonly distillMode: CardSelectField
    readonly minTurnChars: CardNumberField
    readonly maxInjectBytes: CardNumberField
    readonly maxReviewCandidates: CardNumberField
    readonly reviewAfterDays: CardNumberField
  }
  readonly globalDir: CardGlobalDir
}

const INITIAL_STATE: MemorySettingsCardState = Object.freeze({
  status: 'loading',
  writable: false,
  dirty: false,
  saving: false,
  saved: false,
  error: null,
  fields: Object.freeze({
    distill: Object.freeze({ value: true, overridden: false }),
    distillMode: Object.freeze({ value: 'concise' as const, overridden: false }),
    minTurnChars: Object.freeze({ value: 40, text: '40', invalid: false, overridden: false }),
    maxInjectBytes: Object.freeze({ value: 16_384, text: '16384', invalid: false, overridden: false }),
    maxReviewCandidates: Object.freeze({ value: 5, text: '5', invalid: false, overridden: false }),
    reviewAfterDays: Object.freeze({ value: 30, text: '30', invalid: false, overridden: false }),
  }),
  globalDir: Object.freeze({ kind: 'loading' }),
})

/** Field keys of the six knobs. */
export type MemorySettingsField =
  | 'distill'
  | 'distillMode'
  | 'minTurnChars'
  | 'maxInjectBytes'
  | 'maxReviewCandidates'
  | 'reviewAfterDays'

/** Numeric knob keys (the rest are toggle/select). */
const NUMBER_FIELDS = ['minTurnChars', 'maxInjectBytes', 'maxReviewCandidates', 'reviewAfterDays'] as const

/** Numeric knob keys as a type. */
export type MemorySettingsNumberField = (typeof NUMBER_FIELDS)[number]

/** True for a positive-integer input text. */
function validInteger(text: string): boolean {
  return /^[0-9]+$/u.test(text) && Number(text) > 0
}

/** Resolve one scope snapshot into the accepted knob values. */
function resolvedValue(scope: SettingsScope<MemoryLifecycleCardSettings>): Required<MemoryLifecycleCardSettings> {
  const value = scope.getSnapshot().value
  return {
    distill: value?.distill ?? DEFAULT_SETTINGS.distill,
    distillMode: value?.distillMode ?? DEFAULT_SETTINGS.distillMode,
    minTurnChars: value?.minTurnChars ?? DEFAULT_SETTINGS.minTurnChars,
    maxInjectBytes: value?.maxInjectBytes ?? DEFAULT_SETTINGS.maxInjectBytes,
    maxReviewCandidates: value?.maxReviewCandidates ?? DEFAULT_SETTINGS.maxReviewCandidates,
    reviewAfterDays: value?.reviewAfterDays ?? DEFAULT_SETTINGS.reviewAfterDays,
  }
}

/** Whether the user layer overrides one field (presence, not value). */
function overriddenOf(scope: SettingsScope<MemoryLifecycleCardSettings>, field: string): boolean {
  const user = scope.getSnapshot().user
  if (typeof user !== 'object' || user === null) return false
  return Object.hasOwn(user, field)
}

/**
 * Staged-form controller over the memory-lifecycle settings namespace.
 */
export class MemorySettingsCardController implements HostObservable<MemorySettingsCardState> {
  private state = INITIAL_STATE
  private readonly listeners = new Set<() => void>()
  private disposed = false
  /** Staged knob values; numeric fields stage their input text. */
  private staged: Partial<Record<MemorySettingsField, string | boolean>> = {}
  /** The saved-flash reset timer handle. */
  private savedTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param scope - the bound settings scope for the memory-lifecycle namespace.
   * @param remote - reader resolving the `memory` Remote namespace service.
   */
  constructor(
    private readonly scope: SettingsScope<MemoryLifecycleCardSettings>,
    private readonly remote: () => MemoryRemote,
  ) {
    scope.subscribe(() => { this.sync() })
    this.sync()
    this.refreshGlobalDir()
  }

  /** @returns the current card snapshot (stable reference until the next change). */
  getSnapshot(): MemorySettingsCardState {
    return this.state
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release listeners and the saved-flash timer. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer)
  }

  /**
   * Stage one numeric knob's input text.
   * @param field - the numeric knob.
   * @param text - the input text; invalid text blocks only the save.
   */
  editNumber(field: MemorySettingsNumberField, text: string): void {
    this.staged[field] = text
    this.publish(this.render())
  }

  /**
   * Stage the distill mode selection.
   * @param mode - the selected mode.
   */
  editMode(mode: 'concise' | 'detailed'): void {
    this.staged.distillMode = mode
    this.publish(this.render())
  }

  /** Stage the distill toggle flip. */
  toggleDistill(): void {
    const current = this.displayValue('distill') as boolean
    this.staged.distill = !current
    this.publish(this.render())
  }

  /**
   * Commit every staged change through the scope's revision-fenced writes.
   */
  async save(): Promise<void> {
    if (this.disposed || !this.dirty()) return
    this.publish({ ...this.render(), saving: true, saved: false, error: null })
    try {
      for (const [field, staged] of Object.entries(this.staged)) {
        if (field === 'distill') {
          await this.scope.set(field, staged === true)
        } else if (field === 'distillMode') {
          await this.scope.set(field, staged)
        } else {
          const text = staged as string
          if (!validInteger(text)) continue
          await this.scope.set(field, Number(text))
        }
      }
      this.staged = {}
      this.publish({ ...this.render(), saving: false, saved: true })
      if (this.savedTimer !== undefined) clearTimeout(this.savedTimer)
      this.savedTimer = setTimeout(() => {
        this.savedTimer = undefined
        /* v8 ignore next -- dispose() clears the pending timer, so this callback never fires after disposal */
        if (!this.disposed) this.publish({ ...this.render(), saved: false })
      }, 2500)
    } catch (error: unknown) {
      this.publish({ ...this.render(), saving: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Drop the staged changes. */
  discard(): void {
    this.staged = {}
    this.publish(this.render())
  }

  /** Re-read the read-only global vault directory. */
  refreshGlobalDir(): void {
    if (this.disposed) return
    const attempt = (): void => {
      if (this.disposed) return
      try {
        void this.remote().info().then((result) => {
          if (this.disposed) return
          this.publish({
            ...this.render(),
            globalDir: result.ok
              ? { kind: 'dir', dir: result.value.globalDir }
              : { kind: 'unavailable' },
          })
        }, () => {
          // A transport-level rejection also leaves the row unavailable.
          if (this.disposed) return
          this.publish({ ...this.render(), globalDir: { kind: 'unavailable' } })
        })
      } catch {
        // The client assembly provides the namespace service one tick before
        // its methods install; retry on the next microtask until they do.
        queueMicrotask(attempt)
      }
    }
    attempt()
  }

  /** Whether any knob carries a staged change. */
  private dirty(): boolean {
    return Object.keys(this.staged).length > 0
  }

  /** The display value of one knob: staged when present, else the accepted value. */
  private displayValue(field: MemorySettingsField): string | boolean | number {
    const staged = this.staged[field]
    if (staged !== undefined) return staged
    return resolvedValue(this.scope)[field]
  }

  /** Build one number field's state from its input text and the scope. */
  private numberField(field: (typeof NUMBER_FIELDS)[number]): CardNumberField {
    const text = String(this.displayValue(field))
    return {
      value: resolvedValue(this.scope)[field],
      text,
      invalid: !validInteger(text),
      overridden: overriddenOf(this.scope, field),
    }
  }

  /** Rebuild the complete snapshot over the scope and the stage. */
  private render(): MemorySettingsCardState {
    const snapshot = this.scope.getSnapshot()
    const status = snapshot.status === 'unavailable' ? 'unavailable'
      : snapshot.status === 'ready' ? 'ready'
        : 'loading'
    return {
      status,
      writable: snapshot.writable,
      dirty: this.dirty(),
      saving: this.state.saving,
      saved: this.state.saved,
      error: this.state.error,
      fields: {
        distill: {
          value: this.displayValue('distill') as boolean,
          overridden: overriddenOf(this.scope, 'distill'),
        },
        distillMode: {
          value: this.displayValue('distillMode') as 'concise' | 'detailed',
          overridden: overriddenOf(this.scope, 'distillMode'),
        },
        minTurnChars: this.numberField('minTurnChars'),
        maxInjectBytes: this.numberField('maxInjectBytes'),
        maxReviewCandidates: this.numberField('maxReviewCandidates'),
        reviewAfterDays: this.numberField('reviewAfterDays'),
      },
      globalDir: this.state.globalDir,
    }
  }

  /** Resync from the scope (fires on every scope snapshot change). */
  private sync(): void {
    this.publish(this.render())
  }

  private publish(next: MemorySettingsCardState): void {
    this.state = Object.freeze(next)
    for (const listener of [...this.listeners]) listener()
  }
}
