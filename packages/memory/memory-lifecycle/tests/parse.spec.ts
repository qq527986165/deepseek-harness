import { describe, expect, it } from 'vitest'
import { extractJsonObject, parseDistillOutput, parseReviewOutput } from '../src/parse.ts'

const VALID_OUTPUT = {
  notes: [
    { scope: 'project', title: 'Vitest setup', content: 'We use vitest.', tags: ['testing'], related: ['Other'] },
    { scope: 'global', title: 'User drinks tea', content: 'Prefers green tea.', tags: [], related: [] },
  ],
  journal: { title: 'Set up tests', body: '- Configured [[Vitest setup]].' },
}

describe('extractJsonObject', () => {
  it('extracts the first balanced object from plain or fenced text', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
    expect(extractJsonObject('Here is the result:\n```json\n{"a":{"b":[1,2]}}\n```')).toBe('{"a":{"b":[1,2]}}')
    expect(extractJsonObject('nested {"x": "y}"} tail')).toBe('{"x": "y}"}')
  })

  it('tolerates escaped quotes inside strings', () => {
    expect(extractJsonObject('{"x": "a\\"b"}')).toBe('{"x": "a\\"b"}')
  })

  it('returns undefined without an object or with an unclosed one', () => {
    expect(extractJsonObject('no json here')).toBeUndefined()
    expect(extractJsonObject('{"a":1')).toBeUndefined()
  })
})

describe('parseDistillOutput', () => {
  it('parses a full reply with candidates, tags, links, and a journal', () => {
    const output = parseDistillOutput(`Sure: ${JSON.stringify(VALID_OUTPUT)}`)
    expect(output?.notes).toHaveLength(2)
    expect(output?.notes[0]).toEqual({ scope: 'project', title: 'Vitest setup', content: 'We use vitest.', tags: ['testing'], related: ['Other'] })
    expect(output?.notes[1]?.scope).toBe('global')
    expect(output?.journal).toEqual({ title: 'Set up tests', body: '- Configured [[Vitest setup]].' })
  })

  it('returns undefined for a reply without a JSON object', () => {
    expect(parseDistillOutput('nothing to remember today')).toBeUndefined()
    expect(parseDistillOutput('   ')).toBeUndefined()
  })

  it('accepts an empty notes array with a journal', () => {
    const output = parseDistillOutput(JSON.stringify({ notes: [], journal: { title: 't', body: '- b' } }))
    expect(output?.notes).toEqual([])
    expect(output?.journal.title).toBe('t')
  })

  it('rejects invalid JSON and non-object roots', () => {
    expect(() => parseDistillOutput('{"notes": []')).toThrow('not valid JSON')
    expect(() => parseDistillOutput('{"a":}')).toThrow('not valid JSON')
    expect(() => parseDistillOutput('null')).toThrow('must be an object')
    expect(() => parseDistillOutput('123')).toThrow('must be an object')
    expect(() => parseDistillOutput('"just a string"')).toThrow('must be an object')
    expect(() => parseDistillOutput('[{"notes":[]}]')).toThrow('requires a journal entry object')
  })
  it('rejects a missing notes array or journal', () => {
    expect(() => parseDistillOutput('{"journal":{"title":"t","body":"b"}}')).toThrow('requires a notes array')
    expect(() => parseDistillOutput('{"notes":[]}')).toThrow('requires a journal entry object')
  })

  it('rejects malformed candidates field by field', () => {
    const withNote = (note: unknown) => JSON.stringify({ notes: [note], journal: { title: 't', body: '- b' } })
    expect(() => parseDistillOutput(withNote('not-an-object'))).toThrow('each distillation note must be an object')
    expect(() => parseDistillOutput(withNote({ scope: 'local', title: 't', content: 'c' }))).toThrow('scope must be "project" or "global"')
    expect(() => parseDistillOutput(withNote({ scope: 'global', title: ' ', content: 'c' }))).toThrow('note title must be a non-empty string')
    expect(() => parseDistillOutput(withNote({ scope: 'global', title: 't', content: '' }))).toThrow('note content must be a non-empty string')
    expect(() => parseDistillOutput(withNote({ scope: 'global', title: 't', content: 'c', tags: ['x', 1] }))).toThrow('note tags must be an array of strings')
    expect(() => parseDistillOutput(withNote({ scope: 'global', title: 't', content: 'c', related: 'nope' }))).toThrow('note related must be an array of strings')
  })

  it('rejects malformed journal entries', () => {
    expect(() => parseDistillOutput('{"notes":[],"journal":{"title":"","body":"b"}}')).toThrow('journal title must be a non-empty string')
    expect(() => parseDistillOutput('{"notes":[],"journal":{"title":"t","body":"  "}}')).toThrow('journal body must be a non-empty string')
    expect(() => parseDistillOutput('{"notes":[],"journal":"t"}')).toThrow('requires a journal entry object')
  })
})

describe('parseReviewOutput', () => {
  it('parses candidate proposals from plain or fenced text', () => {
    const output = parseReviewOutput(`Here: ${JSON.stringify({ candidates: [{ id: 'p1', reason: 'User-wide.' }] })}`)
    expect(output?.candidates).toEqual([{ id: 'p1', reason: 'User-wide.' }])
    expect(parseReviewOutput(JSON.stringify({ candidates: [] }))?.candidates).toEqual([])
  })

  it('returns undefined for a reply without a JSON object', () => {
    expect(parseReviewOutput('nothing to promote')).toBeUndefined()
    expect(parseReviewOutput('   ')).toBeUndefined()
  })

  it('rejects invalid JSON, non-object roots, and a missing candidates array', () => {
    expect(() => parseReviewOutput('{"candidates": []')).toThrow('review output is not valid JSON')
    expect(() => parseReviewOutput('null')).toThrow('review JSON must be an object')
    expect(() => parseReviewOutput('{}')).toThrow('review output requires a candidates array')
  })

  it('rejects malformed candidates field by field', () => {
    const withCandidate = (candidate: unknown) => JSON.stringify({ candidates: [candidate] })
    expect(() => parseReviewOutput(withCandidate('not-an-object'))).toThrow('each review candidate must be an object')
    expect(() => parseReviewOutput(withCandidate({ id: '', reason: 'r' }))).toThrow('review candidate id must be a non-empty string')
    expect(() => parseReviewOutput(withCandidate({ id: 'p1', reason: ' ' }))).toThrow('review candidate reason must be a non-empty string')
  })
})
