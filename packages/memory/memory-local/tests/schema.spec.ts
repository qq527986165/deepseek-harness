import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findIndexedNote,
  findIndexedNoteById,
  findNoteIdByLinkTarget,
  findNoteIdByTitle,
  inLinks,
  inLinksToNote,
  listIndexedPaths,
  makeSnippet,
  openIndexFile,
  outLinks,
  removeIndexedNote,
  searchIndex,
  upsertIndexedNote,
} from '../src/schema.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-memory-schema-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function row(id: string, path = `notes/${id}.md`, title = `Note ${id}`) {
  return { id, path, title, created: 1000, updated: 2000, tags: ['t'] }
}

describe('openIndexFile', () => {
  it('creates the schema on a fresh directory', async () => {
    const db = await openIndexFile(dir)
    expect(listIndexedPaths(db)).toEqual([])
    db.close()
  })

  it('reopens an existing current-version index without data loss', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1'), 'body', [], [])
    db.close()
    const reopened = await openIndexFile(dir)
    expect(findIndexedNote(reopened, 'n1')?.id).toBe('n1')
    reopened.close()
  })

  it('rebuilds an index with an unknown version', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1'), 'body', [], [])
    db.close()
    const foreign = new DatabaseSync(join(dir, '.memory-index.sqlite'))
    foreign.exec('PRAGMA user_version = 99')
    foreign.close()
    const rebuilt = await openIndexFile(dir)
    expect(listIndexedPaths(rebuilt)).toEqual([])
    rebuilt.close()
  })

  it('propagates non-ENOENT stat faults', async () => {
    const blocker = join(dir, 'plain-file')
    await writeFile(blocker, 'x', 'utf8')
    await expect(openIndexFile(join(blocker, 'nested'))).rejects.toThrow()
  })
})

describe('note rows', () => {
  it('upserts, finds by id then title, lists paths, and removes', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1', 'notes/a.md', 'Alpha'), 'alpha body', [], [])
    upsertIndexedNote(db, row('n2', 'notes/b.md', 'Beta'), 'beta body', [], [])
    expect(listIndexedPaths(db)).toEqual(['notes/a.md', 'notes/b.md'])
    expect(findIndexedNote(db, 'n1')?.title).toBe('Alpha')
    expect(findIndexedNote(db, 'Beta')?.id).toBe('n2')
    expect(findIndexedNote(db, 'missing')).toBeUndefined()
    expect(findIndexedNoteById(db, 'n1')?.title).toBe('Alpha')
    expect(findIndexedNoteById(db, 'missing')).toBeUndefined()

    upsertIndexedNote(db, row('n1', 'notes/a.md', 'Alpha'), 'new body', [], [])
    expect(findIndexedNote(db, 'n1')?.created).toBe(1000)
    expect(searchIndex(db, 'new', 10)[0]?.id).toBe('n1')

    removeIndexedNote(db, 'n1')
    expect(findIndexedNote(db, 'n1')).toBeUndefined()
    expect(searchIndex(db, 'new', 10)).toEqual([])
    db.close()
  })

  it('tolerates hostile tag rows at the durable boundary', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1'), 'body', [], [])
    db.prepare("UPDATE notes SET tags = '[1, \"ok\"]' WHERE id = 'n1'").run()
    expect(findIndexedNote(db, 'n1')?.tags).toEqual(['ok'])
    db.prepare("UPDATE notes SET tags = '\"scalar\"' WHERE id = 'n1'").run()
    expect(findIndexedNote(db, 'n1')?.tags).toEqual([])
    db.prepare("UPDATE notes SET tags = 'not-json' WHERE id = 'n1'").run()
    expect(findIndexedNote(db, 'n1')?.tags).toEqual([])
    db.close()
  })
})

describe('searchIndex', () => {
  it('ranks title/body matches and returns body snippets', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1', 'notes/a.md', 'vitest setup'), 'we use vitest for unit tests', [], [])
    upsertIndexedNote(db, row('n2', 'notes/b.md', 'unrelated'), 'nothing to see here', [], [])
    const hits = searchIndex(db, 'vitest', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.id).toBe('n1')
    expect(hits[0]?.snippet).toContain('vitest')
    db.close()
  })

  it('falls back to the title when the body has no query term', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1', 'notes/a.md', 'vitest'), 'other words', [], [])
    expect(searchIndex(db, 'vitest', 10)[0]?.snippet).toBe('vitest')
    db.close()
  })

  it('treats the query as one quoted phrase, immune to FTS syntax', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1', 'notes/a.md', 'safe'), 'text with "quotes" and OR and NOT', [], [])
    expect(searchIndex(db, '"quotes" OR', 10)).toHaveLength(0)
    expect(searchIndex(db, 'text with', 10)[0]?.id).toBe('n1')
    db.close()
  })

  it('honors the limit', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1'), 'shared term', [], [])
    upsertIndexedNote(db, row('n2'), 'shared term', [], [])
    expect(searchIndex(db, 'shared', 1)).toHaveLength(1)
    db.close()
  })
})

describe('makeSnippet', () => {
  const longBody = 'x'.repeat(60) + 'needle' + 'y'.repeat(60)

  it('windows the earliest term with both ellipses', () => {
    const snippet = makeSnippet(longBody, 'needle')
    expect(snippet).toContain('needle')
    expect(snippet?.startsWith('…')).toBe(true)
    expect(snippet?.endsWith('…')).toBe(true)
  })

  it('elides the leading ellipsis for terms near the start', () => {
    expect(makeSnippet(`needle${'z'.repeat(100)}`, 'needle')?.startsWith('…')).toBe(false)
  })

  it('elides the trailing ellipsis for terms near the end', () => {
    expect(makeSnippet(`${'z'.repeat(100)}needle`, 'needle')?.endsWith('…')).toBe(false)
  })

  it('picks the earliest of several terms and returns undefined without a match', () => {
    const body = `aa${'z'.repeat(80)}bb`
    const snippet = makeSnippet(body, 'bb aa')
    expect(snippet).toContain('aa')
    expect(snippet).not.toContain('bb')
    expect(snippet?.endsWith('…')).toBe(true)
    expect(makeSnippet('nothing here', 'missing')).toBeUndefined()
  })
})

describe('links', () => {
  it('records outgoing wikilink and related edges and resolves titles', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1', 'notes/a.md', 'Alpha'), '[[Beta]] text', ['Beta'], ['Gamma'])
    expect(outLinks(db, 'n1')).toEqual([
      { kind: 'wikilink', toTitle: 'Beta' },
      { kind: 'related', toTitle: 'Gamma' },
    ])
    upsertIndexedNote(db, row('n2', 'notes/b.md', 'Beta'), '', [], [])
    expect(findNoteIdByTitle(db, 'Beta')).toBe('n2')
    expect(findNoteIdByLinkTarget(db, 'notes/b.md')).toBe('n2')
    expect(findNoteIdByLinkTarget(db, 'notes/b')).toBe('n2')
    expect(findNoteIdByTitle(db, 'Gamma')).toBeUndefined()
    expect(inLinks(db, 'Beta')).toEqual([{ kind: 'wikilink', fromId: 'n1' }])
    expect(inLinksToNote(db, { title: 'Beta', path: 'notes/b' })).toEqual([{ kind: 'wikilink', fromId: 'n1' }])
    expect(inLinks(db, 'nobody')).toEqual([])
    db.close()
  })

  it('replaces link rows wholesale on upsert', async () => {
    const db = await openIndexFile(dir)
    upsertIndexedNote(db, row('n1', 'notes/a.md', 'Alpha'), '[[Beta]]', ['Beta'], [])
    upsertIndexedNote(db, row('n1', 'notes/a.md', 'Alpha'), '', [], ['Gamma'])
    expect(outLinks(db, 'n1')).toEqual([{ kind: 'related', toTitle: 'Gamma' }])
    db.close()
  })
})
