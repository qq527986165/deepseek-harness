/**
 * Wikilink display transform for the panel read view. The body renders through
 * ui-primitives' MarkdownText, whose `fileMentions` affordance replaces
 * recognized inline-code tokens with interactive spans — so this module
 * rewrites every resolvable `[[target]]` / `[[target|alias]]` into a prefixed
 * inline-code token and returns the token table a mention resolver reads.
 * Dangling targets stay literal `[[…]]` text in the body (their mark) and the
 * read view lists them beside the body. The token mirrors the provider's
 * extraction pattern (`memory-local`'s `extractWikiLinks`) so the panel links
 * exactly the targets the index links.
 */

/** Inline-code token prefix marking a rewritten wikilink. */
export const WIKILINK_MENTION_PREFIX = 'wl:'

/** One rewritten wikilink: the exact target title and the displayed alias. */
export interface WikilinkMention {
  /** Exact note title the index resolves. */
  readonly target: string
  /** Display text; the target itself when the link declares no alias. */
  readonly alias: string
}

/** A rewritten body: the tokenized markdown plus its token table. */
export interface WikilinkMarked {
  /** Body with every resolvable wikilink replaced by a `` `wl:<n>` `` token. */
  readonly text: string
  /** Token text → mention table, in occurrence order. */
  readonly mentions: ReadonlyMap<string, WikilinkMention>
}

/** The provider's wikilink grammar: target, optional `|alias`. */
const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g

/**
 * Rewrite a markdown body's resolvable wikilinks into mention tokens.
 * @param body - note body markdown.
 * @param dangling - exact titles the vault does not resolve; these stay literal.
 * @returns the tokenized text and its mention table.
 */
export function markWikilinks(body: string, dangling: ReadonlySet<string> = new Set()): WikilinkMarked {
  const mentions = new Map<string, WikilinkMention>()
  const text = body.replace(WIKILINK_PATTERN, (raw, target: string) => {
    const title = target.trim()
    if (title === '' || dangling.has(title)) return raw
    const aliasRaw = raw.slice(2, -2).split('|', 2)[1]
    const alias = aliasRaw === undefined || aliasRaw.trim() === '' ? title : aliasRaw.trim()
    const token = `${WIKILINK_MENTION_PREFIX}${mentions.size}`
    mentions.set(token, { target: title, alias })
    return `\`${token}\``
  })
  return { text, mentions }
}
