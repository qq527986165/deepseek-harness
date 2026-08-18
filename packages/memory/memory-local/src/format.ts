/**
 * Note file format: frontmatter parsing/serialization, title slugs, and the
 * relative paths that make a vault readable in Obsidian.
 * @module @deepseek-ai/dsh-memory-local/format
 */

import { parseDocument, stringify } from 'yaml'

/** The markdown file a provider write targets: topic notes live under `notes/`. */
export const NOTES_DIR = 'notes'

/** Frontmatter fields the provider owns and parses back. */
export interface NoteFrontmatter {
  id: string
  scope: string
  title: string
  created: string
  updated: string
  tags: readonly string[]
  related: readonly string[]
}

/** Split a markdown document into its frontmatter block and body. */
export function splitFrontmatter(text: string): { frontmatter: string | undefined; body: string } {
  if (!text.startsWith('---\n')) return { frontmatter: undefined, body: text }
  const end = text.indexOf('\n---\n', 4)
  if (end === -1) return { frontmatter: undefined, body: text }
  return { frontmatter: text.slice(4, end), body: text.slice(end + 5) }
}

/**
 * Parse a note document into frontmatter fields and body. A missing or
 * malformed frontmatter yields `undefined` — the caller decides whether the
 * file is a note, a journal entry, or foreign markdown.
 * @param text - complete file content.
 * @returns parsed frontmatter plus body, or `undefined` without one.
 */
export function parseNote(text: string): { frontmatter: NoteFrontmatter; body: string } | undefined {
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter === undefined) return undefined
  const document = parseDocument(frontmatter)
  const raw = document.toJS() as Record<string, unknown> | null
  if (raw === null || typeof raw !== 'object') return undefined
  if (typeof raw.id !== 'string' || typeof raw.scope !== 'string' || typeof raw.title !== 'string') return undefined
  if (typeof raw.created !== 'string' || typeof raw.updated !== 'string') return undefined
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : []
  const related = Array.isArray(raw.related) ? raw.related.filter((link): link is string => typeof link === 'string') : []
  return {
    frontmatter: {
      id: raw.id,
      scope: raw.scope,
      title: raw.title,
      created: raw.created,
      updated: raw.updated,
      tags,
      related,
    },
    body,
  }
}

/** Serialize one note to its on-disk markdown form. */
export function stringifyNote(frontmatter: NoteFrontmatter, body: string): string {
  const yaml = stringify({
    id: frontmatter.id,
    scope: frontmatter.scope,
    title: frontmatter.title,
    created: frontmatter.created,
    updated: frontmatter.updated,
    tags: [...frontmatter.tags],
    related: [...frontmatter.related],
  })
  return `---\n${yaml}---\n${body}`
}

/** Lowercase one title into a filesystem-safe slug segment. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug === '' ? 'note' : slug
}

/**
 * Pick a collision-free `notes/` path for a new note. Existing sibling ids
 * keep their paths; a new note whose slug collides with another note's path
 * gains a numeric suffix before the extension.
 * @param title - note title the path derives from.
 * @param taken - relative paths already owned by other notes in the vault.
 * @returns a unique `notes/<slug>.md` path.
 */
export function newNotePath(title: string, taken: ReadonlySet<string>): string {
  const base = slugify(title)
  let candidate = `${NOTES_DIR}/${base}.md`
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `${NOTES_DIR}/${base}-${suffix}.md`
    suffix += 1
  }
  return candidate
}
