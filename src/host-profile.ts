/**
 * Profile-host derivation and the launcher composition closures, rebuilt for
 * an external plugin.
 *
 * The core launcher (`apps/cli/src/profile-boot.ts` in deepseek-harness) used
 * to hand these facts to the in-tree service through a context slot. As an
 * external bundle this package derives them instead: the Loader anchors
 * `ctx.baseUrl` at the booted profile directory (`boot()` sets it to the
 * `cordis.yml` directory), and the composition closures re-resolve the profile
 * per call through `@deepseek-ai/dsh-app-boot`'s `loadProfile` /
 * `renderConfigDump` — the same composition path a boot uses, so a restore
 * check can never disagree with a boot about what "the same configuration"
 * means.
 *
 * `prepareProfile` / `readGenerationInputs` / `renderDurableComposition` /
 * `readBundleStamps` below are copies of the launcher's private functions of
 * the same names (source: `apps/cli/src/profile-boot.ts`), narrowed to the
 * facts this package needs.
 * @module dsh-timemachine/host-profile
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadOptionalPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  renderConfigDump,
  type ConfigDumpLayer,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import type { BundleStamp, ConfigGenerationHost, GenerationInputs } from './types.ts'

/** Diagnostic prefix on errors this package raises. */
const NAME = 'dsh-timemachine'

/**
 * Resolution anchor standing in for the launcher's `INSTALL_ANCHOR` (this
 * package's own manifest, valid from `src/` and from the bundled `lib/`).
 * Bundle resolution from here reaches the dsh installation through the healed
 * `$DSH_HOME/profiles/node_modules` fallback, which the boot's own
 * `prepareProfile` maintains before this plugin mounts.
 */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** Root config filename inside a profile directory (source: profile-boot.ts). */
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * The empty root entry list every profile tree patches over (source:
 * profile-boot.ts). Rewritten per composition read: the vendored Loader's
 * tree write-back can bake composed rows into this file, which would
 * duplicate every bundle insert on the next boot.
 */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/**
 * Resolve the Harness home (source: `@deepseek-ai/dsh-home-paths`
 * `resolveDshHome`, copied so this package need not depend on it): `$DSH_HOME`
 * when set and non-blank, else `~/.dsh`.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
}

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied over
 * every profile's own layer (source: profile-boot.ts `homePatchPath`).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(home: string = resolveDshHome()): string {
  return join(home, PROFILE_PATCH_FILENAME)
}

/**
 * Load a resolved profile and (re)write its empty root config (source:
 * profile-boot.ts `prepareProfile`, minus the fallback heal — the boot
 * already maintains `$DSH_HOME/profiles/node_modules`; the standalone CLI
 * heals it only when this package's anchor lives outside the profiles tree,
 * since healing from inside corrupts the boot's links — see standalone.ts
 * `anchorOutsideProfiles`).
 * @param name - the profile name.
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, home: string = resolveDshHome()): Profile {
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, home)
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/**
 * Read the durable input texts a profile's tree is composed from (source:
 * profile-boot.ts `readGenerationInputs`). Read after {@link prepareProfile},
 * so the manifest text is the one that actually composed.
 * @param loaded - the resolved profile.
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @returns the three input texts, `null` for each absent patch file.
 */
export function readGenerationInputs(loaded: Profile, home: string = resolveDshHome()): GenerationInputs {
  const read = (path: string): string | null => existsSync(path) ? readFileSync(path, 'utf8') : null
  return {
    manifest: readFileSync(join(loaded.dir, 'package.json'), 'utf8'),
    profilePatch: read(loaded.patchPath),
    homePatch: read(homePatchPath(home)),
  }
}

/**
 * Stamp each resolved bundle with the version the installation currently
 * supplies (source: profile-boot.ts `readBundleStamps`).
 * @param loaded - the resolved profile.
 * @returns one stamp per bundle layer, in composition order.
 */
export function readBundleStamps(loaded: Profile): BundleStamp[] {
  return loaded.layers.map((layer) => {
    const manifest = JSON.parse(
      readFileSync(join(layer.packageDir, 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return {
      name: layer.packageName,
      version: typeof manifest.version === 'string' ? manifest.version : null,
    }
  })
}

/** One dump layer per resolved bundle, labelled by package name (source: profile-boot.ts `bundleDumpLayers`). */
function bundleDumpLayers(loaded: Profile): ConfigDumpLayer[] {
  return loaded.layers.map(layer => ({ label: layer.packageName, patches: layer.patches }))
}

/** The user's own durable layers, labelled by path (source: profile-boot.ts `userDumpLayers`). */
function userDumpLayers(loaded: Profile, home: string): ConfigDumpLayer[] {
  const layers: ConfigDumpLayer[] = []
  if (existsSync(loaded.patchPath)) layers.push({ label: loaded.patchPath, patches: loaded.patches })
  const homePatchFile = homePatchPath(home)
  const homePatches = loadOptionalPatches(NAME, homePatchFile)
  if (homePatches !== undefined) layers.push({ label: homePatchFile, patches: homePatches })
  return layers
}

/**
 * Render a profile's durable composition: bundle layers under the user's own,
 * with no `--patch` overlay and no environment switch, anchored on the same
 * empty root the boot includes (source: profile-boot.ts
 * `renderDurableComposition`). One home for the render every generation is
 * recorded with and every restore is checked against.
 * @param loaded - the resolved profile, loaded WITH its user layer.
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @returns the composition as loadable YAML.
 */
export function renderDurableComposition(loaded: Profile, home: string = resolveDshHome()): string {
  return renderConfigDump(
    NAME,
    join(loaded.dir, PROFILE_ROOT_FILENAME),
    [...bundleDumpLayers(loaded), ...userDumpLayers(loaded, home)],
  )
}

/**
 * Derive the host facts from the Loader's `ctx.baseUrl` anchor.
 *
 * The anchor counts as a profile boot only when it points at a directory
 * shaped like `$DSH_HOME/profiles/<name>` holding a manifest; any other tree
 * (a raw `cordis.yml`, a test context) gets `undefined`, which degrades the
 * service to an empty history and restore refusals — the same answer the
 * launcher-handoff design gave outside a profile boot, so a caller cannot
 * probe the composition by diffing them.
 *
 * The closures re-resolve the profile per call rather than closing over one
 * load: a restore rewrites the inputs, and the next check has to see what is
 * now on disk (source: profile-boot.ts `configGenerationHost`).
 * @param baseUrl - the plugin context's `baseUrl`; `undefined` outside a Loader boot.
 * @returns the host facts and composition closures, or `undefined` off a profile boot.
 */
export function deriveProfileHost(baseUrl: string | undefined): ConfigGenerationHost | undefined {
  if (baseUrl === undefined || !baseUrl.startsWith('file:')) return undefined
  const profileDir = fileURLToPath(baseUrl)
  if (basename(dirname(profileDir)) !== 'profiles') return undefined
  if (!existsSync(join(profileDir, 'package.json'))) return undefined
  const profile = basename(profileDir)
  const home = dirname(dirname(profileDir))
  const prepared = (): Profile => prepareProfile(profile, home)
  return {
    profile,
    profileDir,
    homeDir: home,
    // Settled by the service's own boot record, not known at derivation time.
    bootedId: undefined,
    readInputs: () => readGenerationInputs(prepared(), home),
    render: () => renderDurableComposition(prepared(), home),
    readBundles: () => readBundleStamps(prepared()),
  }
}
