/** Wikilink mention transform: resolvable links tokenize, dangling stay literal. */
import { describe, expect, it } from 'vitest'
import { markWikilinks, WIKILINK_MENTION_PREFIX } from '../src/client/panel/wikilinks.ts'

describe('markWikilinks', () => {
  it('leaves a body without wikilinks untouched', () => {
    expect(markWikilinks('plain **text**')).toEqual({ text: 'plain **text**', mentions: new Map() })
  })

  it('tokenizes a plain wikilink with the target as its alias', () => {
    const marked = markWikilinks('See [[Coffee]] for details.')
    expect(marked.text).toBe(`See \`${WIKILINK_MENTION_PREFIX}0\` for details.`)
    expect(marked.mentions.get(`${WIKILINK_MENTION_PREFIX}0`)).toEqual({ target: 'Coffee', alias: 'Coffee' })
  })

  it('honors an alias and trims both sides', () => {
    const marked = markWikilinks('[[ Coffee | the brew ]]')
    expect(marked.mentions.get(`${WIKILINK_MENTION_PREFIX}0`)).toEqual({ target: 'Coffee', alias: 'the brew' })
  })

  it('keeps empty targets literal', () => {
    const marked = markWikilinks('[[ ]] and [[|x]]')
    expect(marked.text).toBe('[[ ]] and [[|x]]')
    expect(marked.mentions.size).toBe(0)
  })

  it('numbers tokens in occurrence order', () => {
    const marked = markWikilinks('[[A]] then [[B]] then [[A]]')
    expect(marked.text).toContain(`${WIKILINK_MENTION_PREFIX}0`)
    expect(marked.text).toContain(`${WIKILINK_MENTION_PREFIX}1`)
    expect(marked.mentions.get(`${WIKILINK_MENTION_PREFIX}0`)?.target).toBe('A')
    expect(marked.mentions.get(`${WIKILINK_MENTION_PREFIX}1`)?.target).toBe('B')
  })

  it('leaves dangling targets literal', () => {
    const marked = markWikilinks('[[Gone]] and [[Here]]', new Set(['Gone']))
    expect(marked.text).toBe(`[[Gone]] and \`${WIKILINK_MENTION_PREFIX}0\``)
    expect(marked.mentions.get(`${WIKILINK_MENTION_PREFIX}0`)?.target).toBe('Here')
  })
})
