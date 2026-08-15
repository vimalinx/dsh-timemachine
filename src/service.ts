/**
 * `ctx.configGenerations` — the configuration history as an in-tree service.
 *
 * The service derives the booted profile from the Loader's `ctx.baseUrl`
 * anchor ({@link deriveProfileHost}) instead of a launcher-filled context
 * slot, records the boot it is part of, and performs a restore that takes
 * effect at the next boot.
 *
 * Composing a profile goes through `@deepseek-ai/dsh-app-boot`'s
 * `loadProfile`/`renderConfigDump` (rebuilt in `./host-profile.ts`), so
 * verifying a restore uses the one composition path a boot uses.
 * @module dsh-config-generations/service
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  appendOutcome,
  compareForRestore,
  digestText,
  lastActivated,
  readGenerations,
  recordGeneration,
  selectGeneration,
} from './generations.ts'
import { deriveProfileHost } from './host-profile.ts'
import type {
  BundleDrift,
  ConfigGeneration,
  ConfigGenerationHost,
  GenerationEnvironment,
  GenerationsRead,
  RestoreResult,
} from './types.ts'

/**
 * The Loader-service slice {@link ConfigGenerations.recordBoot} settles a boot
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
export default class ConfigGenerations extends Service {
  /** The derived profile facts and composition closures; absent outside a `dsh` profile boot. */
  private readonly host: ConfigGenerationHost | undefined
  /** The generation this process recorded for its own boot; `undefined` until {@link recordBoot} settles. */
  private booted: string | undefined

  /**
   * @param ctx - owning plugin context.
   * @param host - explicit host facts (tests); derived from `ctx.baseUrl` when omitted.
   */
  constructor(ctx: Context, host?: ConfigGenerationHost) {
    super(ctx, 'configGenerations')
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
      process.stderr.write(`dsh-config-generations: warning: could not record this boot's outcome: ${String(error)}\n`)
    }
  }

  /**
   * Record the configuration as it now stands, including what only this tree can
   * see. A configuration already recorded is adopted rather than duplicated.
   * @param environment - the settings document and locally authored presets this tree resolved.
   * @param now - ISO timestamp for the observation.
   * @returns the stored generation, or `undefined` without a profile.
   */
  async record(environment: GenerationEnvironment, now: string): Promise<ConfigGeneration | undefined> {
    if (this.host === undefined) return undefined
    return await recordGeneration({
      profileDir: this.host.profileDir,
      profile: this.host.profile,
      inputs: this.host.readInputs(),
      environment,
      bundles: this.host.readBundles(),
      render: this.host.render(),
      now,
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
    /** The booted profile's configuration history; mounted by `dsh-config-generations`. */
    configGenerations: ConfigGenerations
  }
}
