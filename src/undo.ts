/**
 * The undo/redo planning over a profile's generation history.
 *
 * The undo stack needs no file: the generations themselves are it, walked
 * newest-`lastSeenAt`-first for the nearest configuration that is not the
 * current one. Only the redo stack persists (`undo-state.json`, IO in
 * `./generations.ts`), because a redo target survives no record of its own —
 * it is the configuration an undo stepped away FROM.
 *
 * This module is pure: it plans over what a caller read, and the service
 * (`./service.ts`) executes the plan.
 * @module dsh-timemachine/undo
 */

import { generationId } from './generations.ts'
import type { ConfigGeneration } from './types.ts'

/**
 * Plan one undo step: the most recently seen generation whose durable inputs
 * differ from the current configuration's. The comparison runs on the
 * composition-scope digest of the inputs, not the record id: a `full`-scope
 * record of the SAME inputs (a running tree saw more than the launcher) is
 * the same configuration for restore purposes — undo only writes the durable
 * inputs back. `lastSeenAt` order is what "step back" means: a hand-reverted
 * configuration was seen again most recently, so undoing from it steps to
 * what came before, not to the newest file ever recorded.
 * @param generations - the history in `readGenerations` order (oldest first).
 * @param currentDigest - the composition-scope digest of the inputs now on disk.
 * @returns the generation to restore, or `undefined` when there is nothing to undo.
 */
export function planUndo(
  generations: readonly ConfigGeneration[], currentDigest: string,
): ConfigGeneration | undefined {
  return [...generations].reverse().find(generation => generationId(generation.inputs, null) !== currentDigest)
}

/** What {@link planRedo} decided: the target and the stack with it consumed. */
export interface RedoPlan {
  /** The generation to step forward to. */
  generation: ConfigGeneration
  /**
   * The redo stack after the step: the consumed target removed, and every
   * dangling id above it with it — a record pruned or deleted by hand can
   * never be stepped to, so it stops masking the entries beneath it.
   */
  remaining: string[]
}

/**
 * Plan one redo step: the newest redo-stack entry that still names a recorded
 * generation.
 * @param redo - the stored redo stack, oldest first (the next target last).
 * @param generations - the history to resolve ids against.
 * @returns the plan, or `undefined` when there is nothing to redo.
 */
export function planRedo(redo: readonly string[], generations: readonly ConfigGeneration[]): RedoPlan | undefined {
  const byId = new Map(generations.map(generation => [generation.id, generation]))
  for (let index = redo.length - 1; index >= 0; index -= 1) {
    const generation = byId.get(redo[index]!)
    if (generation !== undefined) return { generation, remaining: redo.slice(0, index) }
  }
  return undefined
}
