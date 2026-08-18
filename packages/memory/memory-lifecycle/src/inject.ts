/**
 * Session-start injection assembly: load the scope chain's persona notes and
 * the project recency window, then render them into one byte-capped
 * model-facing context whose provenance the memory/inject event records.
 * @module @deepseek-ai/dsh-memory-lifecycle/inject
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryScope } from '@deepseek-ai/dsh-memory'
import type { ResolvedConfig } from './config.ts'
import type { MemoryInjectRef } from './types.ts'

/** One loaded memory file entering the injected context. */
export interface InjectedPiece {
  readonly scope: MemoryScope
  /** Absolute vault directory. */
  readonly dir: string
  /** File path relative to the vault root. */
  readonly path: string
  /** Topic-note title; absent for persona notes. */
  readonly title?: string
  readonly text: string
}

/** The assembled injection: complete model-facing text plus the files it covers. */
export interface BuiltInjection {
  readonly text: string
  readonly refs: readonly MemoryInjectRef[]
}

/** The heading each injected context opens with. */
const INJECTION_HEADING = 'Memory context'

/** Marker appended when the byte cap cut the assembled text short. */
const TRUNCATION_MARKER = '\n\n(truncated: memory context exceeded the injection byte cap)'

/**
 * Load the persona notes of every resolved scope plus the project recency
 * window, project scope first. The journal never enters this set: recency only
 * walks topic notes and the persona reads target MEMORY.md alone.
 * @param ctx - context carrying the memory service.
 * @param cwd - session working directory, or `undefined` for global-only sessions.
 * @param config - resolved lifecycle parameters.
 * @returns the loaded pieces, or `undefined` when nothing exists to inject.
 */
export async function loadInjectionPieces(
  ctx: Context,
  cwd: string | undefined,
  config: ResolvedConfig,
): Promise<InjectedPiece[] | undefined> {
  const scopes = await ctx.memory.resolveScopes(cwd)
  const pieces: InjectedPiece[] = []
  for (const scope of scopes) {
    const persona = await ctx.memory.readPersona(scope, cwd)
    if (persona !== undefined && persona.text.trim() !== '') {
      pieces.push({ scope, dir: persona.dir, path: persona.path, text: persona.text })
    }
  }
  if (scopes.includes('project')) {
    const recent = await ctx.memory.recent({ limit: config.recentNoteCount }, cwd)
    for (const note of recent.notes) {
      pieces.push({ scope: 'project', dir: recent.dir, path: note.path, title: note.title, text: note.body })
    }
  }
  return pieces.length === 0 ? undefined : pieces
}

/**
 * Render loaded pieces into one complete model-facing context: persona notes
 * first (project, then global), then the recency window under its own heading.
 * @param pieces - loaded pieces in desired order.
 * @returns the rendered text.
 */
export function renderInjection(pieces: readonly InjectedPiece[]): string {
  const personas = pieces.filter(piece => piece.title === undefined)
  const notes = pieces.filter(piece => piece.title !== undefined)
  const lines: string[] = [INJECTION_HEADING]
  for (const persona of personas) {
    lines.push('', `## Persona (${persona.scope})`, '', persona.text.trim())
  }
  if (notes.length > 0) {
    lines.push('', '## Recent project notes')
    for (const note of notes) {
      lines.push('', `### ${note.title}`, note.text.trim())
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
    ...(piece.title === undefined ? {} : { title: piece.title }),
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
