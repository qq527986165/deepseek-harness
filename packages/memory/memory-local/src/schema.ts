/**
 * SQLite index schema and operations for one memory vault. The index is
 * derived state: it mirrors markdown files and is rebuilt wholesale on a
 * schema-version mismatch or deletion.
 * @module @deepseek-ai/dsh-memory-local/schema
 */

import { DatabaseSync } from 'node:sqlite'
import type { Stats } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The index filename inside a vault; derived and delete-safe. */
export const MEMORY_INDEX_FILE = '.memory-index.sqlite'

/** Physical layout version, stamped via `PRAGMA user_version`; mismatches rebuild. */
export const MEMORY_SCHEMA_VERSION = 1

/**
 * The index path for one vault directory.
 * @param dir - vault directory.
 * @returns the absolute index file path.
 */
export function indexPath(dir: string): string {
  return join(dir, MEMORY_INDEX_FILE)
}

const DDL = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS links (
  from_id TEXT NOT NULL,
  to_title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wikilink', 'related')),
  PRIMARY KEY (from_id, to_title, kind)
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, tags, body);
`

/** One indexed note row; `tags` is parsed from its stored JSON form. */
export interface IndexRow {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly created: number
  readonly updated: number
  readonly tags: readonly string[]
}

/**
 * Create every table of the current schema on an open database.
 * @param db - open index database.
 */
export function createSchema(db: DatabaseSync): void {
  db.exec(DDL)
  db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)
}

/**
 * Open the index for one vault directory: an existing index with the current
 * version is kept, any other version (or a plain database) is deleted and
 * recreated, because the index holds only derived state.
 * @param dir - vault directory, which must already exist.
 * @returns the open database.
 */
export async function openIndexFile(dir: string): Promise<DatabaseSync> {
  const path = indexPath(dir)
  const existing = await statSafe(path)
  if (existing !== undefined) {
    const probe = new DatabaseSync(path)
    const version = Number(probe.prepare('PRAGMA user_version').get()?.user_version)
    probe.close()
    if (version === MEMORY_SCHEMA_VERSION) {
      const db = new DatabaseSync(path)
      db.exec('PRAGMA journal_mode = WAL')
      createSchema(db)
      return db
    }
    await rmSafe(path)
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  createSchema(db)
  return db
}

/** `stat` for one path, or `undefined` when it does not exist. */
async function statSafe(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch (error: unknown) {
    /* v8 ignore next -- non-ENOENT stat faults surface as caller errors; platform-specific. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

/** `rm` for one file; a missing file is fine, other faults propagate. */
async function rmSafe(path: string): Promise<void> {
  try {
    await rm(path)
  } catch (error: unknown) {
    /* v8 ignore next -- removal faults on a rebuildable file surface as caller errors. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Create or replace one indexed note and its full-text and link rows. `created`
 * is preserved on replace; links and FTS content are replaced wholesale.
 * @param db - open index database.
 * @param row - note identity, path, timestamps, and tags.
 * @param body - note body, copied into the FTS table.
 * @param wikiLinks - exact `[[wikilink]]` targets found in the body.
 * @param related - frontmatter `related` targets.
 */
export function upsertIndexedNote(
  db: DatabaseSync,
  row: { id: string; path: string; title: string; created: number; updated: number; tags: readonly string[] },
  body: string,
  wikiLinks: readonly string[],
  related: readonly string[],
): void {
  const tagsJson = JSON.stringify(row.tags)
  db.prepare(`
    INSERT INTO notes (id, path, title, created, updated, tags)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      title = excluded.title,
      updated = excluded.updated,
      tags = excluded.tags
  `).run(row.id, row.path, row.title, row.created, row.updated, tagsJson)
  db.prepare('DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE id = ?)').run(row.id)
  db.prepare('INSERT INTO notes_fts (rowid, title, tags, body) VALUES ((SELECT rowid FROM notes WHERE id = ?), ?, ?, ?)')
    .run(row.id, row.title, tagsJson, body)
  db.prepare('DELETE FROM links WHERE from_id = ?').run(row.id)
  const insertLink = db.prepare('INSERT INTO links (from_id, to_title, kind) VALUES (?, ?, ?)')
  for (const title of wikiLinks) insertLink.run(row.id, title, 'wikilink')
  for (const title of related) insertLink.run(row.id, title, 'related')
}

/**
 * Remove one indexed note with its FTS and link rows.
 * @param db - open index database.
 * @param id - note id to drop.
 */
export function removeIndexedNote(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE id = ?)').run(id)
  db.prepare('DELETE FROM links WHERE from_id = ?').run(id)
  db.prepare('DELETE FROM notes WHERE id = ?').run(id)
}

/**
 * Look up one indexed note by id first, then by exact title.
 * @param db - open index database.
 * @param ref - note id or exact title.
 * @returns the matching row, or `undefined` when neither matches.
 */
export function findIndexedNote(db: DatabaseSync, ref: string): IndexRow | undefined {
  const row = findRow(db, 'id', ref) ?? findRow(db, 'title', ref)
  if (row === undefined) return undefined
  return { id: row.id, path: row.path, title: row.title, created: row.created, updated: row.updated, tags: parseTags(row.tags) }
}

/**
 * Every indexed relative path, for collision checks and reconcile scans.
 * @param db - open index database.
 * @returns relative note paths in insertion order.
 */
export function listIndexedPaths(db: DatabaseSync): string[] {
  return db.prepare('SELECT path FROM notes').all().map(row => (row as { path: string }).path)
}

/** One full-text hit joined back to its note row. */
export interface SearchHit {
  readonly id: string
  readonly title: string
  readonly tags: readonly string[]
  readonly snippet: string
}

/**
 * Ranked full-text search over title, tags, and body. The query is quoted so
 * user input cannot inject FTS5 syntax; snippets are cut in JavaScript because
 * FTS5's `snippet()` reports no match for a column.
 * @param db - open index database.
 * @param query - raw user query terms.
 * @param limit - maximum hits to return.
 * @returns ranked hits with a body snippet, falling back to the title.
 */
export function searchIndex(db: DatabaseSync, query: string, limit: number): SearchHit[] {
  const quoted = `"${query.replaceAll('"', '""')}"`
  const rows = db.prepare(`
    SELECT rowid, body
    FROM notes_fts WHERE notes_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(quoted, limit)
  const noteByRowid = db.prepare('SELECT id, title, tags FROM notes WHERE rowid = ?')
  return rows.map((row) => {
    const { rowid, body } = row as { rowid: number; body: string }
    const note = noteByRowid.get(rowid) as { id: string; title: string; tags: string } | undefined
    /* v8 ignore next -- an FTS row always mirrors an existing notes row. */
    if (note === undefined) throw new Error(`index inconsistency: FTS row ${rowid} has no note`)
    return {
      id: note.id,
      title: note.title,
      tags: parseTags(note.tags),
      snippet: makeSnippet(body, query) ?? note.title,
    }
  })
}

/**
 * Window one body around the first query term; `undefined` when no term occurs.
 * @param body - note body text to cut.
 * @param query - search terms; the earliest occurrence wins.
 * @returns an ellipsis-bounded window, or `undefined` without a match.
 */
export function makeSnippet(body: string, query: string): string | undefined {
  const terms = query.split(/\s+/).filter(term => term !== '')
  let index = -1
  let term = ''
  for (const candidate of terms) {
    const found = body.toLowerCase().indexOf(candidate.toLowerCase())
    if (found !== -1 && (index === -1 || found < index)) {
      index = found
      term = candidate
    }
  }
  if (index === -1) return undefined
  const start = Math.max(0, index - 30)
  const end = Math.min(body.length, index + term.length + 40)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

/**
 * Outgoing links of one note: kind plus target title, in insertion order.
 * @param db - open index database.
 * @param fromId - source note id.
 * @returns typed outgoing link rows.
 */
export function outLinks(db: DatabaseSync, fromId: string): Array<{ kind: string; toTitle: string }> {
  return db.prepare('SELECT to_title AS toTitle, kind FROM links WHERE from_id = ? ORDER BY rowid').all(fromId) as Array<{ kind: string; toTitle: string }>
}

/**
 * Incoming links onto one title: kind plus source id, in insertion order.
 * @param db - open index database.
 * @param title - exact target title.
 * @returns typed incoming link rows.
 */
export function inLinks(db: DatabaseSync, title: string): Array<{ kind: string; fromId: string }> {
  return db.prepare('SELECT from_id AS fromId, kind FROM links WHERE to_title = ? ORDER BY rowid').all(title) as Array<{ kind: string; fromId: string }>
}

/**
 * Resolve one exact title to its note id, or `undefined` when it dangles.
 * @param db - open index database.
 * @param title - exact target title.
 * @returns the owning note id when the title resolves.
 */
export function findNoteIdByTitle(db: DatabaseSync, title: string): string | undefined {
  return (db.prepare('SELECT id FROM notes WHERE title = ?').get(title) as { id: string } | undefined)?.id
}

/**
 * Look up one indexed note by exact id.
 * @param db - open index database.
 * @param id - exact note id.
 * @returns the matching row, or `undefined` when unknown.
 */
export function findIndexedNoteById(db: DatabaseSync, id: string): IndexRow | undefined {
  const row = findRow(db, 'id', id)
  if (row === undefined) return undefined
  return { id: row.id, path: row.path, title: row.title, created: row.created, updated: row.updated, tags: parseTags(row.tags) }
}

/** Raw note row shape stored by the schema. */
interface NoteRow {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly created: number
  readonly updated: number
  readonly tags: string
}

/** Look up one raw note row by column. */
function findRow(db: DatabaseSync, column: 'id' | 'title', value: string): NoteRow | undefined {
  return db.prepare(`SELECT id, path, title, created, updated, tags FROM notes WHERE ${column} = ?`).get(value) as NoteRow | undefined
}

/** Parse the stored JSON tags form back into strings. */
function parseTags(raw: unknown): string[] {
  /* v8 ignore next -- rows are only ever written with a string JSON form. */
  if (typeof raw !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    /* v8 ignore next -- unreachable for provider-written rows; hostile data yields []. */
    return []
  }
}
