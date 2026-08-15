/**
 * `ctx.timemachine` — the configuration history as an in-tree service.
 *
 * The service derives the booted profile from the Loader's `ctx.baseUrl`
 * anchor ({@link deriveProfileHost}) instead of a launcher-filled context
 * slot, records the boot it is part of, and performs a restore that takes
 * effect at the next boot.
 *
 * Composing a profile goes through `@deepseek-ai/dsh-app-boot`'s
 * `loadProfile`/`renderConfigDump` (rebuilt in `./host-profile.ts`), so
 * verifying a restore uses the one composition path a boot uses.
 * @module dsh-timemachine/service
 */

import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  appendOutcome,
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
import { deriveProfileHost } from './host-profile.ts'
import { exportGenerations, importGenerations, type ImportResult } from './archive.ts'
import { diffInputs, type DiffSide, type InputDiff } from './diff.ts'
import { readTimemachineSettings, writeTimemachineSettings, DEFAULT_TIMEMACHINE_SETTINGS } from './settings.ts'
import { planRedo, planUndo } from './undo.ts'
import { watchInputs } from './watch.ts'
import type {
  BundleDrift,
  ConfigGeneration,
  ConfigGenerationHost,
  GenerationEnvironment,
  GenerationOrigin,
  GenerationsRead,
  RestoreResult,
  StackRestoreResult,
  TimemachineSettings,
  TimemachineSettingsPatch,
  TimemachineStatus,
} from './types.ts'

/**
 * The Loader-service slice {@link TimeMachine.recordBoot} settles a boot
 * against (structural: the service is not a declared dependency of this
 * package). Mirrors the launcher's post-boot audit
 * (`assertEntriesLoaded`/`assertEntriesActivated` in `dsh-app-boot`): a
 * settled tree whose enabled entries all hold a fiber counts as activated.
 */
interface LoaderSettlement {
  await: () => Promise<unknown>
  entries: () => Iterable<{ fiber: unknown; disabled?: boolean }>
}

/**
 * The configuration history of the booted profile.
 *
 * A tree the dsh profile launcher did not boot gets a service that reports an
 * empty history and refuses to record or restore, rather than guessing at a
 * profile directory.
 */
export default class TimeMachine extends Service {
  /** The derived profile facts and composition closures; absent outside a `dsh` profile boot. */
  private readonly host: ConfigGenerationHost | undefined
  /** The generation this process recorded for its own boot; `undefined` until {@link recordBoot} settles. */
  private booted: string | undefined
  /**
   * Input digests this service is about to write itself (a restore, an undo,
   * a redo). Registered BEFORE the files are written, so the watcher's settled
   * read can never race the registration; consumed one-shot on the watcher's
   * first hit, so a user edit landing on the same digest later still records.
   */
  private readonly selfWrites = new Set<string>()
  /** Closes the auto-save watcher; `undefined` while none runs. */
  private stopWatch: (() => void) | undefined
  /** Whether apply asked for auto-save (settings can still switch it off). */
  private watcherArmed = false

  /**
   * @param ctx - owning plugin context.
   * @param host - explicit host facts (tests); derived from `ctx.baseUrl` when omitted.
   */
  constructor(ctx: Context, host?: ConfigGenerationHost) {
    super(ctx, 'timemachine')
    this.host = host ?? deriveProfileHost(ctx.baseUrl)
  }

  /** Whether this tree booted from a profile directory. */
  get available(): boolean {
    return this.host !== undefined
  }

  /** The booted profile's name; `undefined` outside a `dsh` profile boot. */
  get profile(): string | undefined {
    return this.host?.profile
  }

  /** The generation this process booted; `undefined` when recording failed or has not run. */
  get bootedId(): string | undefined {
    return this.booted
  }

  /**
   * Every recorded configuration of the booted profile.
   * @returns the readable generations oldest `lastSeenAt` first plus every rejected record; empty without a profile.
   */
  list(): GenerationsRead {
    if (this.host === undefined) return { generations: [], unreadable: [] }
    return readGenerations(this.host.profileDir)
  }

  /**
   * Resolve one generation by id or unambiguous id prefix.
   * @param id - the id or prefix to resolve.
   * @returns the matching generation.
   * @throws when nothing matches or a prefix is ambiguous.
   */
  read(id: string): ConfigGeneration {
    return selectGeneration(this.list().generations, id)
  }

  /**
   * The newest configuration that reached an activated tree.
   * @returns the last known-good generation, or `undefined` when none activated.
   */
  lastGood(): ConfigGeneration | undefined {
    return lastActivated(this.list().generations)
  }

  /**
   * Record the composition this process booted, from the launcher's vantage
   * (no environment), and settle the boot's outcome once the tree resolves.
   * Replaces the launcher's `recordComposition`/`settleComposition` pair
   * (source: `apps/cli/src/profile-boot.ts`): an external plugin observes its
   * own boot instead of being handed the launcher's record. The `--patch`
   * overlays a launcher would name are not visible from inside the tree, so
   * the outcome records an empty overlay list.
   *
   * Settlement mirrors the launcher's post-boot audit as closely as a plugin
   * can: the Loader service's settlement rejects plugin load/apply failures,
   * and an enabled entry without a fiber fails the tree at the launcher's
   * final audit. Both paths settle `failed`; anything else settles
   * `activated`. A tree with no Loader service (a manual mount) records
   * without settling an outcome.
   * @param now - ISO timestamp for this observation.
   * @returns the recorded generation, or `undefined` without a profile.
   */
  async recordBoot(now: string): Promise<ConfigGeneration | undefined> {
    const host = this.host
    if (host === undefined) return undefined
    const generation = await recordGeneration({
      profileDir: host.profileDir,
      profile: host.profile,
      inputs: host.readInputs(),
      environment: null,
      bundles: host.readBundles(),
      render: host.render(),
      now,
      origin: 'boot',
      retention: readTimemachineSettings(host.profileDir).retention,
    })
    this.booted = generation.id
    const loader = this.ctx.get('loader') as LoaderSettlement | undefined
    if (loader === undefined) return generation
    void loader.await().then(
      () => {
        // The launcher's final audit fails a settled tree whose enabled
        // entries lack a fiber; mirror it before calling the boot activated.
        const incomplete = [...loader.entries()].some(entry => entry.fiber === undefined && !entry.disabled)
        void this.settleBoot(generation.id, incomplete ? 'an enabled entry did not activate' : undefined)
      },
      (error: unknown) => {
        void this.settleBoot(generation.id, error instanceof Error ? error.message : String(error))
      },
    )
    return generation
  }

  /**
   * Settle this boot's outcome against its generation (source:
   * profile-boot.ts `settleComposition`, without the recovery hint — the
   * launcher prints it; a plugin cannot reach its own boot's stderr moment).
   * Best-effort like the launcher's recording: a settlement failure warns and
   * is otherwise lost.
   */
  private async settleBoot(id: string, failure?: string): Promise<void> {
    if (this.host === undefined) return
    try {
      await appendOutcome(this.host.profileDir, id, failure === undefined
        ? { at: new Date().toISOString(), status: 'activated', overlays: [] }
        : { at: new Date().toISOString(), status: 'failed', overlays: [], error: failure })
    } catch (error) {
      process.stderr.write(`dsh-timemachine: warning: could not record this boot's outcome: ${String(error)}\n`)
    }
  }

  /**
   * Record the configuration as it now stands, including what only this tree can
   * see. A configuration already recorded is adopted rather than duplicated.
   * @param environment - the settings document and locally authored presets this tree resolved.
   * @param now - ISO timestamp for the observation.
   * @param origin - how this observation came to be (`boot` unless a caller says otherwise).
   * @returns the stored generation, or `undefined` without a profile.
   */
  async record(
    environment: GenerationEnvironment, now: string, origin: GenerationOrigin = 'boot',
  ): Promise<ConfigGeneration | undefined> {
    if (this.host === undefined) return undefined
    return await recordGeneration({
      profileDir: this.host.profileDir,
      profile: this.host.profile,
      inputs: this.host.readInputs(),
      environment,
      bundles: this.host.readBundles(),
      render: this.host.render(),
      now,
      origin,
      retention: readTimemachineSettings(this.host.profileDir).retention,
    })
  }

  /**
   * Return the profile's composition inputs to a recorded configuration, and its
   * locally authored preset files with them.
   *
   * The change lands on disk and takes effect at the next boot: this process
   * keeps the tree it mounted, because swapping a running tree's composition
   * underneath its own live agents has no defined lifecycle. The settings
   * document is deliberately not written — `dsh-settings-file` owns it behind a
   * cross-process writer lock, and going around that lock is what its contract
   * forbids.
   *
   * Inputs are written, then verified, then put back on a mismatch, so a refusal
   * leaves the profile untouched.
   * @param id - the generation id or unambiguous prefix to return to.
   * @returns what the restore did, including why it refused.
   */
  async restore(id: string): Promise<RestoreResult> {
    const host = this.host
    if (host === undefined) {
      return { id, restored: false, changes: [], refusal: 'no profile was handed to this composition' }
    }
    const generation = this.read(id)
    // Self-write suppression registers BEFORE the write: the watcher's settled
    // digest of what this restore leaves behind (the home patch is not written,
    // so the digest takes the one now on disk) must already be known when the
    // watcher re-reads, or the restore would trigger an auto record of itself.
    this.selfWrites.add(generationId({
      manifest: generation.inputs.manifest,
      profilePatch: generation.inputs.profilePatch,
      homePatch: host.readInputs().homePatch,
    }, null))
    const targets = [
      { path: join(host.profileDir, 'package.json'), text: generation.inputs.manifest as string | null },
      { path: join(host.profileDir, 'cordis.patch.yml'), text: generation.inputs.profilePatch },
      ...generation.environment?.presets.map(preset => ({ path: preset.path, text: preset.text })) ?? [],
    ]
    const previous = targets.map(target => ({
      path: target.path,
      text: existsSync(target.path) ? readFileSync(target.path, 'utf8') : null,
    }))
    const changes: string[] = []
    for (const target of targets) changes.push(await writeInput(target.path, target.text))
    const undo = async (): Promise<void> => {
      for (const entry of previous) await writeInput(entry.path, entry.text)
    }
    let verdict
    try {
      verdict = compareForRestore(generation, { digest: digestText(host.render()), bundles: host.readBundles() })
    } catch (error) {
      // A recorded bundle the installation can no longer resolve fails while
      // composing, which is drift the digest never gets a chance to see.
      await undo()
      return {
        id: generation.id,
        restored: false,
        changes: [],
        refusal: `configuration ${generation.id} no longer composes: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (!verdict.reproducible) {
      await undo()
      return { id: generation.id, restored: false, changes: [], verdict, refusal: refusalText(generation, verdict.drift) }
    }
    return { id: generation.id, restored: true, changes, verdict }
  }

  /**
   * Take a manual snapshot of the configuration as it now stands, from this
   * tree's own vantage on the durable inputs (composition scope — the settings
   * document and presets stay out, as they do at boot).
   * @param reason - the note to record with the snapshot.
   * @param now - ISO timestamp for the observation.
   * @returns the stored generation, or `undefined` without a profile.
   */
  async snapshot(reason: string | undefined, now: string): Promise<ConfigGeneration | undefined> {
    const host = this.host
    if (host === undefined) return undefined
    return await recordGeneration({
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
   * Step back to the most recently seen configuration that is not the current
   * one. The configuration being stepped away from is first recorded with
   * `origin: 'regret'` and pushed onto the redo stack, so a redo can return to
   * it — that record is a genuine observation of what was on disk, and like a
   * manual snapshot it is never auto-cleaned.
   * @param now - ISO timestamp for the regret record.
   * @returns what the step did; `empty: 'nothing-to-undo'` when no other configuration exists.
   */
  async undo(now: string): Promise<StackRestoreResult> {
    const host = this.host
    if (host === undefined) return { changed: false, empty: 'nothing-to-undo' }
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
    // A refusal (drift) leaves the redo entry in place: the way back still
    // names a real configuration, and redoing into it refuses the same way.
    const result = await this.restore(target.id)
    return { changed: result.restored, result }
  }

  /**
   * Step forward to the newest redo-stack configuration that still exists.
   * Dangling entries above it (pruned, deleted by hand) are dropped with it.
   * @returns what the step did; `empty: 'nothing-to-redo'` when the stack holds nothing restorable.
   */
  async redo(): Promise<StackRestoreResult> {
    const host = this.host
    if (host === undefined) return { changed: false, empty: 'nothing-to-redo' }
    const state = readUndoState(host.profileDir)
    const plan = planRedo(state.redo, readGenerations(host.profileDir).generations)
    if (plan === undefined) {
      // Purge a stack that nothing resolves from, so `canRedo` stops lying.
      if (state.redo.length > 0) await writeUndoState(host.profileDir, { redo: [] })
      return { changed: false, empty: 'nothing-to-redo' }
    }
    await writeUndoState(host.profileDir, { redo: plan.remaining })
    const result = await this.restore(plan.generation.id)
    return { changed: result.restored, result }
  }

  /**
   * Delete one generation's record. The running process's own boot
   * configuration and the last known-good one are protected — deleting either
   * would remove the recovery path a mistake needs.
   * @param id - the generation id or unambiguous prefix.
   * @returns whether the record was removed, or why not.
   */
  remove(id: string): { removed: boolean, refusal?: string } {
    const host = this.host
    if (host === undefined) return { removed: false, refusal: 'no profile was handed to this composition' }
    const generation = this.read(id)
    if (generation.id === this.booted) {
      return { removed: false, refusal: `configuration ${generation.id} is what this process booted` }
    }
    if (lastActivated(readGenerations(host.profileDir).generations)?.id === generation.id) {
      return { removed: false, refusal: `configuration ${generation.id} is the last known-good one` }
    }
    unlinkSync(join(resolveGenerationsDir(host.profileDir), `${generation.id}.json`))
    return { removed: true }
  }

  /**
   * Diff one generation against another, or against what is on disk now.
   * @param id - the recorded side.
   * @param otherId - the other recorded side; omitted to diff against the live inputs and render.
   * @returns one entry per differing file.
   */
  diff(id: string, otherId?: string): InputDiff[] {
    const host = this.host
    if (host === undefined) return []
    const sideOf = (generation: ConfigGeneration): DiffSide => ({
      ...generation.inputs,
      render: generation.composed.render,
    })
    const before = sideOf(this.read(id))
    const after = otherId === undefined
      ? { ...host.readInputs(), render: host.render() }
      : sideOf(this.read(otherId))
    return diffInputs(before, after)
  }

  /**
   * Zip the booted profile's whole history.
   * @returns the archive bytes; `undefined` without a profile.
   */
  exportData(): Uint8Array | undefined {
    return this.host === undefined ? undefined : exportGenerations(this.host.profileDir)
  }

  /**
   * Unzip an archive into the booted profile's history, never overwriting.
   * @param data - the archive bytes.
   * @returns which ids landed and which were skipped; `undefined` without a profile.
   */
  importData(data: Uint8Array): Promise<ImportResult | undefined> {
    return this.host === undefined
      ? Promise.resolve(undefined)
      : importGenerations(this.host.profileDir, data)
  }

  /**
   * Apply the retention bound on demand, without recording anything (the
   * panel's "prune expired" action; {@link recordGeneration} prunes as a side
   * effect of recording). Housekeeping reaps only `boot`/`auto` generations
   * beyond the bound — manual snapshots, regret records, and the last
   * known-good configuration survive.
   * @returns the removed generations' ids; `undefined` without a profile.
   */
  prune(): string[] | undefined {
    if (this.host === undefined) return undefined
    return pruneGenerations(this.host.profileDir, readTimemachineSettings(this.host.profileDir).retention)
  }

  /**
   * The undo/redo availability and boot health, derived per call from the
   * store rather than cached — the watcher and other processes move the state.
   */
  status(): TimemachineStatus {
    const host = this.host
    if (host === undefined) return { canUndo: false, canRedo: false, total: 0, lastBootFailed: false }
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
   * The effective settings; the defaults without a profile.
   */
  getSettings(): TimemachineSettings {
    if (this.host === undefined) return DEFAULT_TIMEMACHINE_SETTINGS
    return readTimemachineSettings(this.host.profileDir)
  }

  /**
   * Apply a settings patch. A change to `autoSave` or `debounceMs` rebuilds
   * the watcher immediately when auto-save is armed, so the new value takes
   * effect live rather than at the next boot.
   * @param patch - the fields to change.
   * @returns the effective settings after the write; `undefined` without a profile.
   */
  async updateSettings(patch: TimemachineSettingsPatch): Promise<TimemachineSettings | undefined> {
    if (this.host === undefined) return undefined
    const next = await writeTimemachineSettings(this.host.profileDir, patch)
    if (patch.autoSave !== undefined || patch.debounceMs !== undefined) this.rebuildWatcher(next)
    return next
  }

  /**
   * Arm auto-save: start the input watcher per the stored settings. Called by
   * the plugin body once the service fiber is up; idempotent.
   */
  startAutoSave(): void {
    if (this.host === undefined || this.watcherArmed) return
    this.watcherArmed = true
    this.rebuildWatcher(readTimemachineSettings(this.host.profileDir))
  }

  /** Disarm auto-save and close the watcher (the plugin body's dispose hook). */
  stopAutoSave(): void {
    this.watcherArmed = false
    this.stopWatch?.()
    this.stopWatch = undefined
  }

  /** (Re)start the watcher from the given settings when armed and enabled. */
  private rebuildWatcher(settings: TimemachineSettings): void {
    this.stopWatch?.()
    this.stopWatch = undefined
    const host = this.host
    if (!this.watcherArmed || !settings.autoSave || host === undefined) return
    this.stopWatch = watchInputs({
      profileDir: host.profileDir,
      ...host.homeDir === undefined ? {} : { homeDir: host.homeDir },
      debounceMs: settings.debounceMs,
      shouldIgnore: digest => this.selfWrites.delete(digest),
      onChange: () => {
        void recordGeneration({
          profileDir: host.profileDir,
          profile: host.profile,
          inputs: host.readInputs(),
          environment: null,
          bundles: host.readBundles(),
          render: host.render(),
          now: new Date().toISOString(),
          origin: 'auto',
          retention: readTimemachineSettings(host.profileDir).retention,
        }).catch((error: unknown) => {
          // Auto-save is a recovery aid, never a reason to disturb the tree.
          process.stderr.write(`dsh-timemachine: warning: could not auto-record a configuration change: ${String(error)}\n`)
        })
      },
    })
  }
}

/** Replace one input file's contents, or delete it when the generation recorded none. */
async function writeInput(path: string, text: string | null): Promise<string> {
  if (text === null) {
    rmSync(path, { force: true })
    return `removed ${path}`
  }
  await writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 })
  return `wrote ${path}`
}

/** One message naming why a configuration cannot be reproduced. */
function refusalText(generation: ConfigGeneration, drift: readonly BundleDrift[]): string {
  const moved = drift.map(entry => `${entry.name}: recorded ${entry.recorded ?? 'absent'}, installed ${entry.current ?? 'absent'}`)
  return `configuration ${generation.id} can no longer be reproduced, so restoring it would compose a different tree`
    + (moved.length > 0 ? ` (${moved.join('; ')})` : ' with the same bundles')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The booted profile's configuration history; mounted by `dsh-timemachine`. */
    timemachine: TimeMachine
  }
}
