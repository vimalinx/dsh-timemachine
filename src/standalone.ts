/**
 * The outside-the-tree operations over a profile's configuration history,
 * shared by the standalone CLI (`./cli.ts`) and the rescue GUI (`./gui.ts`).
 *
 * This module is the service's (`./service.ts`) standalone counterpart: same
 * undo/redo planning, same regret/redo-stack bookkeeping, same restore
 * verification, re-derived over a profile directory rather than a booted
 * tree's context. The differences are vantage, not policy:
 *
 * - No environment scope: outside a tree there is no settings document or
 *   preset roster to read, so every record here is composition-scope.
 * - No self-write suppression: there is no watcher running in these processes.
 * - No booted-configuration protection on remove: nothing booted here. The
 *   last known-good protection stands — it is the recovery path a rescue
 *   session itself needs.
 *
 * The composition closures re-resolve the profile per call through
 * `./host-profile.ts` (the launcher's `loadProfile`/`renderConfigDump` path),
 * so a restore's verification sees what the restore just wrote.
 * @module dsh-timemachine/standalone
 */

import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { healProfilesModuleFallback, PROFILES_DIR } from '@deepseek-ai/dsh-app-boot'
import {
  compareForRestore,
  digestText,
  generationId,
  lastActivated,
  pruneGenerations,
  readGenerations,
  readUndoState,
  recordGeneration,
  resolveGenerationsDir,
  selectGeneration,
  writeUndoState,
} from './generations.ts'
import { planRedo, planUndo } from './undo.ts'
import {
  homePatchPath,
  prepareProfile,
  readBundleStamps,
  readGenerationInputs,
  renderDurableComposition,
  resolveDshHome,
} from './host-profile.ts'
import { readTimemachineSettings } from './settings.ts'
import type {
  BundleStamp,
  ConfigGeneration,
  GenerationInputs,
  RestoreResult,
  StackRestoreResult,
  TimemachineStatus,
} from './types.ts'

/**
 * This package's own manifest, the fallback-heal anchor for standalone use.
 * The heal is only safe from an anchor OUTSIDE the profiles tree:
 * `healProfilesModuleFallback` resolves each dependency through the very
 * fallback it rewrites, so from a profile install every peer found there
 * would be re-linked onto its own link (a self-referential symlink),
 * corrupting the fallback the boot maintains. A profile install needs no
 * heal from us — the boot's own heal already covers the whole closure — so
 * {@link openProfile} skips it in that case; a global install (this package
 * outside `$DSH_HOME/profiles`) resolves its peers from its own location and
 * the heal is the fallback's only writer.
 */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Whether the fallback heal from {@link INSTALL_ANCHOR} is safe (see above).
 * @param home - the Harness home the fallback belongs to.
 * @param anchor - the anchor to judge; defaults to this package's manifest.
 */
export function anchorOutsideProfiles(home: string, anchor: string = INSTALL_ANCHOR): boolean {
  const within = relative(join(home, PROFILES_DIR), anchor)
  return within === '' || within.startsWith('..')
}

/**
 * A profile opened for outside-the-tree operations: the directory facts plus
 * the composition closures, re-resolving per call so a restore's check sees
 * the files the restore just wrote (source: host-profile.ts
 * `deriveProfileHost`, whose closures do the same from inside a tree).
 */
export interface StandaloneHost {
  /** The profile's name. */
  profile: string
  /** Absolute profile directory holding the records. */
  profileDir: string
  /** The Harness home the profile lives under. */
  home: string
  /** Read the three durable input texts as they now stand on disk. */
  readInputs: () => GenerationInputs
  /** Render the durable composition as it now stands on disk. */
  render: () => string
  /** Stamp every resolved bundle layer as the installation currently supplies it. */
  readBundles: () => BundleStamp[]
}

/**
 * Open a profile for standalone use: heal the shared module fallback against
 * this package's anchor when that anchor lives outside the profiles tree
 * (from a profile install the boot's heal already covers the closure, and
 * re-healing from inside would corrupt it — see {@link anchorOutsideProfiles}),
 * then resolve the profile once (which validates it exists — an unknown
 * profile throws here, as the CLI has always reported it).
 * @param profile - the profile name.
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @returns the standalone host.
 */
export function openProfile(profile: string, home: string = resolveDshHome()): StandaloneHost {
  if (anchorOutsideProfiles(home)) healProfilesModuleFallback(INSTALL_ANCHOR, home)
  const prepared = prepareProfile(profile, home)
  const profileDir = prepared.dir
  const reload = (): ReturnType<typeof prepareProfile> => prepareProfile(profile, home)
  return {
    profile,
    profileDir,
    home,
    readInputs: () => readGenerationInputs(reload(), home),
    render: () => renderDurableComposition(reload(), home),
    readBundles: () => readBundleStamps(reload()),
  }
}

/** Replace one input file's contents, or delete it when the generation recorded none. */
async function restoreInput(path: string, text: string | null): Promise<string> {
  if (text === null) {
    rmSync(path, { force: true })
    return `removed ${path}`
  }
  // Atomic replacement: a half-written patch layer is a profile that cannot
  // boot, which is exactly what this command exists to get out of.
  await writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 })
  return `wrote ${path}`
}

/** One input file's current contents, for putting it back. */
interface InputSnapshot {
  path: string
  text: string | null
}

/**
 * Write one configuration's inputs back, then confirm they still compose the
 * tree they were recorded with — and put the profile back as it was when they
 * do not.
 *
 * The check has to run against written files rather than the recorded texts,
 * because reproducing a composition means resolving the bundle packages the
 * manifest names against the current installation. Restoring first and undoing
 * on a mismatch reuses the one composition path a boot uses, instead of a
 * parallel one that could disagree with it.
 * @param host - the standalone host.
 * @param generation - the configuration to return to.
 * @returns what the restore did, including why it refused.
 */
export async function restoreGeneration(
  host: StandaloneHost, generation: ConfigGeneration,
): Promise<RestoreResult> {
  const targets = [
    { path: join(host.profileDir, 'package.json'), text: generation.inputs.manifest as string | null },
    { path: join(host.profileDir, 'cordis.patch.yml'), text: generation.inputs.profilePatch },
    { path: homePatchPath(host.home), text: generation.inputs.homePatch },
  ]
  const previous: InputSnapshot[] = targets.map(target => ({
    path: target.path,
    text: existsSync(target.path) ? readFileSync(target.path, 'utf8') : null,
  }))
  const changes: string[] = []
  for (const target of targets) changes.push(await restoreInput(target.path, target.text))
  const undo = async (): Promise<void> => {
    for (const entry of previous) await restoreInput(entry.path, entry.text)
  }
  let verdict
  try {
    verdict = compareForRestore(generation, {
      digest: digestText(host.render()),
      bundles: host.readBundles(),
    })
  } catch (error) {
    // A recorded bundle the installation can no longer resolve fails inside
    // `loadProfile`, which is drift the digest never gets a chance to see.
    await undo()
    return {
      id: generation.id,
      restored: false,
      changes: [],
      refusal: `configuration ${generation.id} no longer composes: `
        + `${error instanceof Error ? error.message : String(error)}\n`
        + `the profile is unchanged.`,
    }
  }
  if (!verdict.reproducible) {
    await undo()
    const lines = verdict.drift.map(drift =>
      `  ${drift.name}: recorded ${drift.recorded ?? 'absent'}, installed ${drift.current ?? 'absent'}`)
    return {
      id: generation.id,
      restored: false,
      changes: [],
      verdict,
      refusal: `configuration ${generation.id} can no longer be reproduced, so restoring it would compose a different tree.\n`
        + (lines.length > 0
          ? `these bundles moved:\n${lines.join('\n')}\n`
          : `its inputs now compose a different tree with the same bundles.\n`)
        + `the profile is unchanged.`,
    }
  }
  return { id: generation.id, restored: true, changes, verdict }
}

/**
 * Step back to the most recently seen configuration that is not the current
 * one — the service's undo semantics executed standalone: the configuration
 * being stepped away from is recorded with `origin: 'regret'` and pushed onto
 * the redo stack first, and a drift refusal leaves that redo entry in place.
 * @param host - the standalone host.
 * @param now - ISO timestamp for the regret record.
 * @returns what the step did; `empty: 'nothing-to-undo'` when no other configuration exists.
 */
export async function undoStandalone(host: StandaloneHost, now: string): Promise<StackRestoreResult> {
  const inputs = host.readInputs()
  const target = planUndo(readGenerations(host.profileDir).generations, generationId(inputs, null))
  if (target === undefined) return { changed: false, empty: 'nothing-to-undo' }
  const regret = await recordGeneration({
    profileDir: host.profileDir,
    profile: host.profile,
    inputs,
    environment: null,
    bundles: host.readBundles(),
    render: host.render(),
    now,
    origin: 'regret',
    retention: readTimemachineSettings(host.profileDir).retention,
  })
  // The regret record is pushed AFTER it exists on disk: a redo must never
  // name a generation the store does not hold.
  const state = readUndoState(host.profileDir)
  await writeUndoState(host.profileDir, { redo: [...state.redo, regret.id] })
  const result = await restoreGeneration(host, target)
  return { changed: result.restored, result }
}

/**
 * Step forward to the newest redo-stack configuration that still exists,
 * dropping dangling entries above it — the service's redo semantics executed
 * standalone, including purging a stack that nothing resolves from.
 * @param host - the standalone host.
 * @returns what the step did; `empty: 'nothing-to-redo'` when the stack holds nothing restorable.
 */
export async function redoStandalone(host: StandaloneHost): Promise<StackRestoreResult> {
  const state = readUndoState(host.profileDir)
  const plan = planRedo(state.redo, readGenerations(host.profileDir).generations)
  if (plan === undefined) {
    // Purge a stack that nothing resolves from, so `canRedo` stops lying.
    if (state.redo.length > 0) await writeUndoState(host.profileDir, { redo: [] })
    return { changed: false, empty: 'nothing-to-redo' }
  }
  await writeUndoState(host.profileDir, { redo: plan.remaining })
  const result = await restoreGeneration(host, plan.generation)
  return { changed: result.restored, result }
}

/**
 * Take a manual snapshot of the configuration as it now stands, composition
 * scope (the standalone vantage sees no environment). A configuration already
 * recorded is adopted rather than duplicated.
 * @param host - the standalone host.
 * @param reason - the note to record with the snapshot.
 * @param now - ISO timestamp for the observation.
 * @returns the stored generation.
 */
export function snapshotStandalone(
  host: StandaloneHost, reason: string | undefined, now: string,
): Promise<ConfigGeneration> {
  return recordGeneration({
    profileDir: host.profileDir,
    profile: host.profile,
    inputs: host.readInputs(),
    environment: null,
    bundles: host.readBundles(),
    render: host.render(),
    now,
    origin: 'manual',
    ...reason === undefined ? {} : { reason },
    retention: readTimemachineSettings(host.profileDir).retention,
  })
}

/**
 * Delete one generation's record. The last known-good one is protected —
 * deleting it would remove the recovery path a rescue session exists for.
 * (The booted-configuration protection does not apply: no process booted
 * anything here.)
 * @param host - the standalone host.
 * @param id - the generation id or unambiguous prefix.
 * @returns whether the record was removed, or why not.
 */
export function removeStandalone(host: StandaloneHost, id: string): { removed: boolean, refusal?: string } {
  const generation = selectGeneration(readGenerations(host.profileDir).generations, id)
  if (lastActivated(readGenerations(host.profileDir).generations)?.id === generation.id) {
    return { removed: false, refusal: `configuration ${generation.id} is the last known-good one` }
  }
  unlinkSync(join(resolveGenerationsDir(host.profileDir), `${generation.id}.json`))
  return { removed: true }
}

/**
 * The undo/redo availability and boot health, derived per call from the store
 * (the same derivation the service answers with; other processes move the
 * state between calls).
 * @param host - the standalone host.
 * @returns the status snapshot.
 */
export function statusStandalone(host: StandaloneHost): TimemachineStatus {
  const { generations } = readGenerations(host.profileDir)
  const currentDigest = generationId(host.readInputs(), null)
  const latest = generations.flatMap(generation => generation.outcomes)
    .sort((left, right) => left.at.localeCompare(right.at))
    .at(-1)
  return {
    canUndo: planUndo(generations, currentDigest) !== undefined,
    canRedo: planRedo(readUndoState(host.profileDir).redo, generations) !== undefined,
    total: generations.length,
    lastBootFailed: latest?.status === 'failed',
  }
}

/**
 * Prune the history on demand, per the stored retention setting.
 * @param host - the standalone host.
 * @returns the removed generations' ids.
 */
export function pruneStandalone(host: StandaloneHost): string[] {
  return pruneGenerations(host.profileDir, readTimemachineSettings(host.profileDir).retention)
}
