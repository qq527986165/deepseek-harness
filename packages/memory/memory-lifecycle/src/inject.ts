/**
 * Session-start injection assembly: load the scope chain's persona notes in
 * full plus the note catalog (title, tags, updated date, first-line excerpt,
 * newest first), then render them into one byte-capped model-facing context
 * whose provenance the memory/inject event records.
 * @module @deepseek-ai/dsh-memory-lifecycle/inject
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryScope } from '@deepseek-ai/dsh-memory'
import type { MemoryInjectRef } from './types.ts'

/** One persona note entering the injected context whole. */
export interface InjectedPersona {
  readonly kind: 'persona'
  readonly scope: MemoryScope
  /** Absolute vault directory. */
  readonly dir: string
  /** File path relative to the vault root; always `MEMORY.md`. */
  readonly path: string
  readonly text: string
}

/** One note-catalog entry entering the injected context as structured fields. */
export interface InjectedCatalogEntry {
  readonly kind: 'catalog'
  readonly scope: MemoryScope
  /** Absolute vault directory. */
  readonly dir: string
  /** File path relative to the vault root. */
  readonly path: string
  readonly title: string
  readonly tags: readonly string[]
  /** Index timestamp in epoch milliseconds of the latest indexed update. */
  readonly updated: number
  /** First non-empty body line. */
  readonly excerpt: string
}

/** One loaded memory fact entering the injected context. */
export type InjectedPiece = InjectedPersona | InjectedCatalogEntry

/** The assembled injection: complete model-facing text plus the files it covers. */
export interface BuiltInjection {
  readonly text: string
  readonly refs: readonly MemoryInjectRef[]
}

/** The heading each injected context opens with. */
const INJECTION_HEADING = 'Memory context'

/** The heading the note catalog renders under. */
const CATALOG_HEADING = 'Memory note catalog'

/** Marker appended when the byte cap cut the assembled text short. */
const TRUNCATION_MARKER = '\n\n(truncated: memory context exceeded the injection byte cap)'

/** One catalog entry's updated date, rendered as an ISO calendar day. */
function isoDay(updated: number): string {
  return new Date(updated).toISOString().slice(0, 10)
}

/**
 * Load the persona notes of every resolved scope in full plus every scope's
 * note catalog, project scope first. The journal never enters the injected
 * set: listing skips journal rows and the persona reads target MEMORY.md alone.
 * @param ctx - context carrying the memory service.
 * @param cwd - session working directory, or `undefined` for global-only sessions.
 * @returns the loaded pieces, or `undefined` when nothing exists to inject.
 */
export async function loadInjectionPieces(
  ctx: Context,
  cwd: string | undefined,
): Promise<InjectedPiece[] | undefined> {
  const scopes = await ctx.memory.resolveScopes(cwd)
  const pieces: InjectedPiece[] = []
  for (const scope of scopes) {
    const persona = await ctx.memory.readPersona(scope, cwd)
    if (persona !== undefined && persona.text.trim() !== '') {
      pieces.push({ kind: 'persona', scope, dir: persona.dir, path: persona.path, text: persona.text })
    }
  }
  for (const scope of scopes) {
    const listed = await ctx.memory.list(scope, cwd)
    for (const note of listed.notes) {
      if (note.persona) continue
      pieces.push({
        kind: 'catalog',
        scope,
        dir: listed.dir,
        path: note.path,
        title: note.title,
        tags: note.tags,
        updated: note.updated,
        excerpt: note.excerpt,
      })
    }
  }
  return pieces.length === 0 ? undefined : pieces
}

/**
 * Render loaded pieces into one complete model-facing context: persona notes
 * first (project, then global), then the note catalog under its own heading,
 * newest first per scope.
 * @param pieces - loaded pieces in desired order.
 * @returns the rendered text.
 */
export function renderInjection(pieces: readonly InjectedPiece[]): string {
  const personas = pieces.filter((piece): piece is InjectedPersona => piece.kind === 'persona')
  const catalog = pieces.filter((piece): piece is InjectedCatalogEntry => piece.kind === 'catalog')
  const lines: string[] = [INJECTION_HEADING]
  for (const persona of personas) {
    lines.push('', `## Persona (${persona.scope})`, '', persona.text.trim())
  }
  if (catalog.length > 0) {
    lines.push('', `## ${CATALOG_HEADING}`)
    for (const note of catalog) {
      lines.push(
        '',
        `### ${note.title} (${note.scope})`,
        `Tags: ${note.tags.join(', ') || '(none)'}`,
        `Updated: ${isoDay(note.updated)}`,
        note.excerpt,
      )
    }
  }
  return lines.join('\n')
}

/**
 * Assemble the byte-capped complete injection. The cap applies to the whole
 * emitted text including the truncation marker: overflowing content is cut at
 * a UTF-8 character boundary and the marker names the cut. Every loaded file's
 * content still entered the context, so refs cover all pieces.
 * @param pieces - loaded pieces in desired order.
 * @param maxBytes - complete-text byte cap.
 * @returns the assembled text and refs, or `undefined` with nothing to inject.
 */
export function buildInjectionText(pieces: readonly InjectedPiece[], maxBytes: number): BuiltInjection | undefined {
  if (pieces.length === 0) return undefined
  const full = renderInjection(pieces)
  const refs: MemoryInjectRef[] = pieces.map(piece => ({
    scope: piece.scope,
    dir: piece.dir,
    path: piece.path,
    ...(piece.kind === 'persona' ? {} : { title: piece.title }),
  }))
  if (byteLength(full) <= maxBytes) return { text: full, refs }
  const markerBytes = byteLength(TRUNCATION_MARKER)
  const text = `${truncateUtf8(full, maxBytes - markerBytes)}${TRUNCATION_MARKER}`
  return { text, refs }
}

/** UTF-8 byte length of one string. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Cut one string to at most `maxBytes` UTF-8 bytes on a character boundary.
 * Callers invoke this only when the text is known to overflow the budget.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = byteLength(char)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}
