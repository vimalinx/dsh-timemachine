/**
 * Package-owned invariant companion for `dsh-timemachine`.
 * @module dsh-timemachine/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-timemachine'

/** Cordis companion plugin name. */
export const name = 'timemachine-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package records the boot's composition into
 * files and owns no event stream or mutable in-tree relation. The records a
 * running tree could be compared against describe boots other than the one it
 * is part of, so a companion here would read its own writes rather than check
 * an owned relationship.
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
