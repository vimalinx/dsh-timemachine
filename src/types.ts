/**
 * Persisted record types for `dsh` configuration generations.
 * @module @deepseek-ai/dsh-config-generations/types
 */

/** The three durable files a profile's plugin tree is composed from. */
export interface GenerationInputs {
  /** The profile `package.json` text, verbatim. */
  manifest: string
  /** The profile's `cordis.patch.yml` text; `null` when the file is absent. */
  profilePatch: string | null
  /** The `$DSH_HOME/cordis.patch.yml` text; `null` when the file is absent. */
  homePatch: string | null
}

/** One resolved bundle layer's identity at the moment a generation was recorded. */
export interface BundleStamp {
  /** The bundle's package name, as listed in `dsh.profile.bundles`. */
  name: string
  /** The resolved package's `version`; `null` when its manifest declares none. */
  version: string | null
}

/** Whether one boot attempt on a generation reached an activated tree. */
export type OutcomeStatus = 'activated' | 'failed'

/** The user settings document as one observation saw it. */
export interface SettingsSnapshot {
  /** Absolute path the settings provider resolved. */
  path: string
  /** The document text; `null` when no document exists yet. */
  text: string | null
}

/** One locally authored agent preset's composition. */
export interface PresetSnapshot {
  /** The preset id (its directory name). */
  id: string
  /** Absolute path of the composition file. */
  path: string
  /** The composition text, exactly as stored. */
  text: string
}

/**
 * Configuration a running tree can see and the launcher cannot: the settings
 * document and the locally authored presets. Their paths are derived inside the
 * tree (`ctx.settings.documentPath`, `ctx.agentPresets.roots`), so a record
 * written before a tree mounts carries `null` for the whole environment rather
 * than guessing at those derivations.
 */
export interface GenerationEnvironment {
  /** The settings document, or `null` when the settings seam is not composed. */
  settings: SettingsSnapshot | null
  /** Every `user`-trust preset, by id. `system`-trust presets are versioned by their own package. */
  presets: PresetSnapshot[]
}

/**
 * What a generation observed. `composition` is the launcher's view before a tree
 * mounts — the three files that decide the plugin tree. `full` adds the
 * environment only a running tree can read. Both are honest about their vantage,
 * and the id covers whichever slots the record carries, so the two never collide.
 */
export type GenerationScope = 'composition' | 'full'

/** One boot attempt recorded against the generation it composed. */
export interface GenerationOutcome {
  /** ISO timestamp of the attempt's settlement. */
  at: string
  /** Whether the tree activated. */
  status: OutcomeStatus
  /** The `--patch` overlay paths this attempt applied above the durable layers, in argv order. */
  overlays: string[]
  /** The failure's message; absent on an `activated` outcome. */
  error?: string
}

/** The durable-only composition a generation's inputs produce. */
export interface ComposedTree {
  /** Digest of {@link ComposedTree.render}. */
  digest: string
  /**
   * The rendered composition, as `dsh --profile <name> --dump-config` prints it
   * without any `--patch` overlay or environment switch. Stored rather than
   * recomputed so a diff between two generations stays available after the
   * installed bundles change underneath them.
   */
  render: string
}

/** One recorded configuration of a profile's plugin tree. */
export interface ConfigGeneration {
  /** The record format's monotonic stamp; a differing value is rejected without migration. */
  formatVersion: number
  /** Content-addressed id over every input slot this record carries; also its filename stem. */
  id: string
  /** Which slots this record observed. */
  scope: GenerationScope
  /** ISO timestamp this configuration was first observed. */
  recordedAt: string
  /** ISO timestamp this configuration was most recently composed. */
  lastSeenAt: string
  /** The profile name whose tree this configuration composes. */
  profile: string
  /** The durable input files this configuration is. */
  inputs: GenerationInputs
  /** What a running tree saw beside the composition; `null` on a `composition`-scope record. */
  environment: GenerationEnvironment | null
  /** The resolved bundle layers, in `dsh.profile.bundles` order. */
  bundles: BundleStamp[]
  /** What the inputs composed, without per-invocation overlays. */
  composed: ComposedTree
  /** Every boot attempt recorded against this configuration, oldest first. */
  outcomes: GenerationOutcome[]
}

/** A record file that could not be read as a generation of the current format. */
export interface UnreadableGeneration {
  /** Absolute path of the offending file. */
  path: string
  /** Why it was rejected. */
  reason: string
}

/** Everything one generations directory currently holds. */
export interface GenerationsRead {
  /** Readable generations, oldest `lastSeenAt` first. */
  generations: ConfigGeneration[]
  /**
   * Files rejected by the reader. Surfaced rather than thrown: the history is a
   * recovery aid, so a corrupt record must not be what stops a boot.
   */
  unreadable: UnreadableGeneration[]
}

/** The live state a restore is checked against. */
export interface CurrentComposition {
  /** Digest of the durable-only composition the current installation produces. */
  digest: string
  /** The bundle layers the current installation resolves, in composition order. */
  bundles: BundleStamp[]
}

/** One bundle whose resolved version no longer matches the recorded generation. */
export interface BundleDrift {
  /** The bundle's package name. */
  name: string
  /** The version recorded with the generation; `null` when it declared none, `undefined` when the bundle is new. */
  recorded?: string | null
  /** The version the current installation resolves; `null` when it declares none, `undefined` when the bundle is gone. */
  current?: string | null
}

/** Whether a generation's inputs still reproduce the tree they were recorded with. */
export interface RestoreVerdict {
  /** Whether writing the inputs back would reproduce the recorded composition. */
  reproducible: boolean
  /** Bundles whose identity changed; empty when every layer matches. */
  drift: BundleDrift[]
  /** Whether the recomposed digest differs from the recorded one. */
  digestChanged: boolean
}

/**
 * Launcher-owned facts and closures the configuration-history service needs.
 *
 * Composing a profile belongs to the launcher, which owns `loadProfile`,
 * `composeEntries`, and `renderConfigDump`. Handing those in as closures is what
 * lets an in-tree service verify a restore without a plugin importing launcher
 * glue, and what keeps one composition path behind both the boot record and
 * every later check.
 */
export interface ConfigGenerationHost {
  /** The booted profile's name. */
  profile: string
  /** Absolute profile directory holding the records. */
  profileDir: string
  /** The generation this process booted, or `undefined` when recording failed. */
  bootedId: string | undefined
  /** Read the three durable input texts as they now stand on disk. */
  readInputs: () => GenerationInputs
  /** Render the durable composition as it now stands on disk. */
  render: () => string
  /** Stamp every resolved bundle layer as the installation currently supplies it. */
  readBundles: () => BundleStamp[]
}

/** What an in-tree restore did. */
export interface RestoreResult {
  /** The generation restored, or the one refused. */
  id: string
  /** Whether the inputs were written and kept. */
  restored: boolean
  /** One line per file written or removed; empty on a refusal. */
  changes: string[]
  /** Why a refusal happened, in one human-readable message; absent on success. */
  refusal?: string
  /** The comparison behind the decision; absent when composing the generation threw outright. */
  verdict?: RestoreVerdict
}
