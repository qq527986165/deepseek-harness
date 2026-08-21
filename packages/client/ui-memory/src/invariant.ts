/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-memory`.
 * @module @deepseek-ai/dsh-client-ui-memory/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-memory'

/** Cordis companion plugin name. */
export const name = 'client-ui-memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a browser consumer that emits no cordis events and
 * owns no cross-plugin mutable state — the panel reads and writes the vault
 * through the memory Remote, whose mutations leave no session events (the
 * vault files plus index are the record), and its presentation behavior is
 * asserted directly by this package's component and controller specs.
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
