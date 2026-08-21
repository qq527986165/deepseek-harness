/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-lifecycle`.
 * Validates the shape of every `memory/distill` write record and every
 * `memory/review` proposal on the live session stream, so a malformed record
 * fails at the append site instead of corrupting reconstruction.
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
const DISTILL_NOTE_PATH = /^notes\/[a-z0-9\u4e00-\u9fff_-]+-[a-f0-9]{8}(?:-\d+)?\.md$/

/** Validate one required non-empty string field. */
function requireNonEmptyString(value: unknown, label: string, fail: InvariantFailure): void {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
}

/** Validate one committed topic-note write record. */
function validateNoteWrite(value: unknown, fail: InvariantFailure): void {
  if (value === null || typeof value !== 'object') fail('each memory/distill note write must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) fail('memory/distill note id must be a non-empty string')
  if (record.scope !== 'project' && record.scope !== 'global') fail('memory/distill note scope must be project or global')
  if (typeof record.title !== 'string' || record.title.length === 0) fail('memory/distill note title must be a non-empty string')
  if (typeof record.path !== 'string' || !DISTILL_NOTE_PATH.test(record.path)) {
    fail('memory/distill note path must be notes/<summary>-<short-id>.md')
  }
  if (typeof record.journalAnchor !== 'string'
    || record.journalAnchor !== `^memory-${record.journalAnchor.slice(8, 16)}-${record.scope}`
    || !/^\^memory-[a-f0-9]{8}-(project|global)$/.test(record.journalAnchor)) {
    fail('memory/distill note journalAnchor must name its scope with an eight-hex transaction id')
  }
  if ('action' in record) fail('memory/distill note action is not part of a commit receipt')
  if (record.previous !== undefined) {
    if (record.previous === null || typeof record.previous !== 'object') fail('memory/distill note previous must be an object')
    const previous = record.previous as Record<string, unknown>
    requireNonEmptyString(previous.id, 'memory/distill note previous id', fail)
    requireNonEmptyString(previous.title, 'memory/distill note previous title', fail)
    if (typeof previous.path !== 'string' || !previous.path.startsWith('notes/')) {
      fail('memory/distill note previous path must live under notes/')
    }
  }
}

/** Validate the journal append record when one is present. */
function validateJournalWrite(value: unknown, fail: InvariantFailure): void {
  if (value === null || typeof value !== 'object') fail('memory/distill journal must be an object')
  const record = value as Record<string, unknown>
  if (record.scope !== 'project' && record.scope !== 'global') fail('memory/distill journal scope must be project or global')
  if (typeof record.path !== 'string' || !JOURNAL_PATH.test(record.path)) fail('memory/distill journal path must be journal/<date>.md')
  if (typeof record.date !== 'string' || record.date.length !== 10) fail('memory/distill journal date must be YYYY-MM-DD')
  if (record.path !== `journal/${record.date}.md`) fail('memory/distill journal path must match its date')
  if (typeof record.title !== 'string' || record.title.length === 0) fail('memory/distill journal title must be a non-empty string')
  if (typeof record.anchor !== 'string' || !/^\^memory-[a-f0-9]{8}-(project|global)$/.test(record.anchor)
    || !record.anchor.endsWith(`-${record.scope}`)) {
    fail('memory/distill journal anchor must name its scope with an eight-hex transaction id')
  }
}

/** Validate one memory/distill event against its declared write-record contract. */
function validateDistillEvent(event: unknown, fail: InvariantFailure): void {
  if (event === null || typeof event !== 'object') fail('memory/distill payload must be an object')
  const record = event as Record<string, unknown>
  if ('error' in record || 'journal' in record) fail('memory/distill legacy partial fields are not allowed')
  if (typeof record.turn !== 'number' || !Number.isSafeInteger(record.turn) || record.turn < 1) {
    fail('memory/distill turn must be a positive safe integer')
  }
  if (!Array.isArray(record.notes)) fail('memory/distill notes must be an array')
  if (record.notes.length === 0) fail('memory/distill notes must be non-empty')
  for (const note of record.notes as unknown[]) validateNoteWrite(note, fail)
  const noteIds = (record.notes as Array<Record<string, unknown>>).map(note => note.id)
  const notePaths = (record.notes as Array<Record<string, unknown>>).map(note => note.path)
  if (new Set(noteIds).size !== noteIds.length) fail('memory/distill note ids must be unique')
  if (new Set(notePaths).size !== notePaths.length) fail('memory/distill note paths must be unique')
  if (!Array.isArray(record.journals)) fail('memory/distill journals must be an array')
  if (record.journals.length === 0) fail('memory/distill journals must be non-empty')
  for (const journal of record.journals as unknown[]) validateJournalWrite(journal, fail)
  const noteScopes = new Set((record.notes as Array<Record<string, unknown>>).map(note => note.scope))
  const journalScopes = (record.journals as Array<Record<string, unknown>>).map(journal => journal.scope)
  if (new Set(journalScopes).size !== journalScopes.length) fail('memory/distill journals must contain one entry per scope')
  if (noteScopes.size !== journalScopes.length || journalScopes.some(scope => !noteScopes.has(scope))) {
    fail('memory/distill journal scopes must match note scopes')
  }
  const anchors = new Map((record.journals as Array<Record<string, unknown>>).map(journal => [journal.scope, journal.anchor]))
  if ((record.notes as Array<Record<string, unknown>>).some(note => anchors.get(note.scope) !== note.journalAnchor)) {
    fail('memory/distill note journalAnchor must match its scope journal anchor')
  }
  const model = record.model
  if (model === null || typeof model !== 'object') fail('memory/distill model must be an object')
  const route = model as Record<string, unknown>
  if (typeof route.provider !== 'string' || route.provider.length === 0
    || typeof route.model !== 'string' || route.model.length === 0) {
    fail('memory/distill model must name a non-empty provider and model')
  }
}

/** Validate one review candidate against its declared contract. */
function validateReviewCandidate(value: unknown, fail: InvariantFailure): void {
  if (value === null || typeof value !== 'object') fail('each memory/review candidate must be an object')
  const record = value as Record<string, unknown>
  requireNonEmptyString(record.id, 'memory/review candidate id', fail)
  requireNonEmptyString(record.title, 'memory/review candidate title', fail)
  if (typeof record.snippet !== 'string') fail('memory/review candidate snippet must be a string')
  requireNonEmptyString(record.reason, 'memory/review candidate reason', fail)
}

/** Validate one memory/review event against its declared proposal contract. */
function validateReviewEvent(event: unknown, fail: InvariantFailure): void {
  if (event === null || typeof event !== 'object') fail('memory/review payload must be an object')
  const record = event as Record<string, unknown>
  requireNonEmptyString(record.reviewId, 'memory/review reviewId', fail)
  if (!Array.isArray(record.candidates)) fail('memory/review candidates must be an array')
  for (const candidate of record.candidates as unknown[]) validateReviewCandidate(candidate, fail)
  requireNonEmptyString(record.workspaceDir, 'memory/review workspaceDir', fail)
}

/** Validate one accepted promotion entry. */
function validateDecidedAccepted(value: unknown, fail: InvariantFailure): void {
  if (value === null || typeof value !== 'object') fail('each memory/review-decided accepted entry must be an object')
  const record = value as Record<string, unknown>
  requireNonEmptyString(record.id, 'memory/review-decided accepted id', fail)
  requireNonEmptyString(record.title, 'memory/review-decided accepted title', fail)
  requireNonEmptyString(record.globalId, 'memory/review-decided accepted globalId', fail)
}

/** Validate one memory/review-decided event against its declared settlement contract. */
function validateReviewDecidedEvent(event: unknown, fail: InvariantFailure): void {
  if (event === null || typeof event !== 'object') fail('memory/review-decided payload must be an object')
  const record = event as Record<string, unknown>
  requireNonEmptyString(record.reviewId, 'memory/review-decided reviewId', fail)
  if (!Array.isArray(record.accepted)) fail('memory/review-decided accepted must be an array')
  for (const accepted of record.accepted as unknown[]) validateDecidedAccepted(accepted, fail)
  if (!Array.isArray(record.rejected)) fail('memory/review-decided rejected must be an array')
  for (const rejected of record.rejected as unknown[]) {
    requireNonEmptyString(rejected, 'memory/review-decided rejected id', fail)
  }
}

/** Validate one memory/* event against its declared contract. */
function validateMemoryEvent(event: SessionEvent, fail: InvariantFailure): void {
  switch (event.type) {
    case 'memory/distill':
      validateDistillEvent(event.data, fail)
      return
    case 'memory/review':
      validateReviewEvent(event.data, fail)
      return
    case 'memory/review-decided':
      validateReviewDecidedEvent(event.data, fail)
      return
    default:
      return
  }
}

/**
 * Install pre-commit validation of every `memory/*` record this package owns:
 * the `internal/dispatch` hook runs during the append's dispatch phase, before
 * containment, so a malformed record rejects the append itself.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    validateMemoryEvent(event, fail)
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
