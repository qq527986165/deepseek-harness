import { describe, expect, it } from 'vitest'
import { newNotePath, parseNote, slugify, splitFrontmatter, stringifyNote } from '../src/format.ts'

const NOTE = `---
id: n1
scope: project
title: My Note
created: 2026-08-18T10:00:00.000Z
updated: 2026-08-18T11:00:00.000Z
tags:
  - a
  - b
related:
  - "[[other]]"
---
Body with a [[link]] inside.
`

describe('splitFrontmatter', () => {
  it('splits a leading frontmatter block from the body', () => {
    expect(splitFrontmatter(NOTE).body).toBe('Body with a [[link]] inside.\n')
    expect(splitFrontmatter(NOTE).frontmatter).toContain('id: n1')
  })

  it('returns no frontmatter for plain text and unterminated blocks', () => {
    expect(splitFrontmatter('plain text')).toEqual({ frontmatter: undefined, body: 'plain text' })
    expect(splitFrontmatter('---\nid: n1\nno closer')).toEqual({ frontmatter: undefined, body: '---\nid: n1\nno closer' })
  })
})

describe('parseNote', () => {
  it('parses every provider-owned field', () => {
    const parsed = parseNote(NOTE)
    expect(parsed).toEqual({
      frontmatter: {
        id: 'n1',
        scope: 'project',
        title: 'My Note',
        created: '2026-08-18T10:00:00.000Z',
        updated: '2026-08-18T11:00:00.000Z',
        tags: ['a', 'b'],
        related: ['[[other]]'],
      },
      body: 'Body with a [[link]] inside.\n',
    })
  })

  it('returns undefined for missing frontmatter, malformed YAML, and missing fields', () => {
    expect(parseNote('no frontmatter')).toBeUndefined()
    expect(parseNote('---\nid: [unclosed\n---\nbody')).toBeUndefined()
    expect(parseNote('---\nscope: project\n---\nbody')).toBeUndefined()
    expect(parseNote('---\nid: n1\nscope: project\ntitle: t\ncreated: c\n---\nbody')).toBeUndefined()
  })

  it('filters non-string tags and related entries, and tolerates non-array forms', () => {
    const parsed = parseNote('---\nid: n\nscope: global\ntitle: t\ncreated: c\nupdated: u\ntags: [1, ok]\nrelated: [2, "[[x]]"]\n---\nbody')
    expect(parsed?.frontmatter.tags).toEqual(['ok'])
    expect(parsed?.frontmatter.related).toEqual(['[[x]]'])
    const scalar = parseNote('---\nid: n\nscope: global\ntitle: t\ncreated: c\nupdated: u\ntags: scalar\nrelated: scalar\n---\nbody')
    expect(scalar?.frontmatter.tags).toEqual([])
    expect(scalar?.frontmatter.related).toEqual([])
  })

  it('returns undefined for an empty frontmatter document and a null document', () => {
    expect(parseNote('---\n---\nbody')).toBeUndefined()
    expect(parseNote('---\nnull\n---\nbody')).toBeUndefined()
  })
})

describe('stringifyNote', () => {
  it('round-trips through parseNote', () => {
    const text = stringifyNote({
      id: 'n1',
      scope: 'global',
      title: 'T',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
      tags: ['x'],
      related: ['[[y]]'],
    }, 'body')
    const parsed = parseNote(text)
    expect(parsed?.frontmatter).toMatchObject({ id: 'n1', scope: 'global', title: 'T', tags: ['x'], related: ['[[y]]'] })
    expect(parsed?.body).toBe('body')
  })
})

describe('slugify', () => {
  it('lowercases and replaces separators, keeping CJK', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('  记忆 系统 ')).toBe('记忆-系统')
    expect(slugify('!!!')).toBe('note')
    expect(slugify('under_score-kebab')).toBe('under_score-kebab')
  })
})

describe('newNotePath', () => {
  it('derives notes/<slug>.md and suffixes collisions', () => {
    expect(newNotePath('Hello World', new Set())).toBe('notes/hello-world.md')
    expect(newNotePath('Hello World', new Set(['notes/hello-world.md']))).toBe('notes/hello-world-2.md')
    expect(newNotePath('Hello World', new Set(['notes/hello-world.md', 'notes/hello-world-2.md']))).toBe('notes/hello-world-3.md')
  })
})
