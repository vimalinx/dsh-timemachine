/**
 * The package's invariant companion: it reserves package ownership and installs
 * nothing, because the records describe boots other than the one a running tree
 * is part of.
 * @module dsh-timemachine/tests/invariant
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as TimeMachineInvariant from 'dsh-timemachine/invariant'

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(TimeMachineInvariant).await()).resolves.toBeDefined()
  })
})
