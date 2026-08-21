/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-remote`.
 * @module @deepseek-ai/dsh-memory-remote/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-remote'

/** Cordis companion plugin name. */
export const name = 'memory-remote-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: `decide` appends `memory/review-decided` through the
 * session log, whose shape the memory-lifecycle companion validates before
 * the append commits, and the promotion's own write-then-remove ordering is
 * pinned by the replay-driven assembled test rather than an event stream.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
