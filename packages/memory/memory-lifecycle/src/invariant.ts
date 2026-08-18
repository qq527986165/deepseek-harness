/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-lifecycle`.
 * Validates the shape of every `memory/distill` write record on the live
 * session stream, so a malformed record fails at the append site instead of
 * corrupting reconstruction.
 * @module @deepseek-ai/dsh-memory-lifecycle/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the memory/* event keys this companion validates.
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-lifecycle'

/** Cordis companion plugin name. */
export const name = 'memory-lifecycle-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Journal paths are always `journal/<YYYY-MM-DD>.md` relative to the vault. */
const JOURNAL_PATH = /^journal\/\d{4}-\d{2}-\d{2}\.md$/

/** Validate one committed topic-note write record. */
function validateNoteWrite(value: unknown, fail: InvariantFailure): void {
  if (value === null || typeof value !== 'object') fail('each memory/distill note write must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) fail('memory/distill note id must be a non-empty string')
  if (record.scope !== 'project' && record.scope !== 'global') fail('memory/distill note scope must be project or global')
  if (typeof record.title !== 'string' || record.title.length === 0) fail('memory/distill note title must be a non-empty string')
  if (typeof record.path !== 'string' || !record.path.startsWith('notes/')) fail('memory/distill note path must live under notes/')
  if (record.action !== 'create' && record.action !== 'merge') fail('memory/distill note action must be create or merge')
}

/** Validate the journal append record when one is present. */
function validateJournalWrite(value: unknown, fail: InvariantFailure): void {
  if (value === null || typeof value !== 'object') fail('memory/distill journal must be an object')
  const record = value as Record<string, unknown>
  if (record.scope !== 'project' && record.scope !== 'global') fail('memory/distill journal scope must be project or global')
  if (typeof record.path !== 'string' || !JOURNAL_PATH.test(record.path)) fail('memory/distill journal path must be journal/<date>.md')
  if (typeof record.date !== 'string' || record.date.length !== 10) fail('memory/distill journal date must be YYYY-MM-DD')
  if (typeof record.title !== 'string' || record.title.length === 0) fail('memory/distill journal title must be a non-empty string')
}

/** Validate one memory/distill event against its declared write-record contract. */
function validateDistillEvent(event: unknown, fail: InvariantFailure): void {
  if (event === null || typeof event !== 'object') fail('memory/distill payload must be an object')
  const record = event as Record<string, unknown>
  if (typeof record.turn !== 'number' || !Number.isSafeInteger(record.turn) || record.turn < 1) {
    fail('memory/distill turn must be a positive safe integer')
  }
  if (!Array.isArray(record.notes)) fail('memory/distill notes must be an array')
  for (const note of record.notes as unknown[]) validateNoteWrite(note, fail)
  if (record.journal !== undefined) validateJournalWrite(record.journal, fail)
  const model = record.model
  if (model === null || typeof model !== 'object') fail('memory/distill model must be an object')
  const route = model as Record<string, unknown>
  if (typeof route.provider !== 'string' || route.provider.length === 0
    || typeof route.model !== 'string' || route.model.length === 0) {
    fail('memory/distill model must name a non-empty provider and model')
  }
  if (record.error !== undefined && typeof record.error !== 'string') fail('memory/distill error must be a string')
}

/**
 * Install pre-commit validation of every `memory/distill` write record: the
 * `internal/dispatch` hook runs during the append's dispatch phase, before
 * containment, so a malformed record rejects the append itself.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    if (event.type !== 'memory/distill') return
    validateDistillEvent(event.data, fail)
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
