#!/usr/bin/env node
/**
 * `dsh-config-generations <action> --profile <name>` — standalone version
 * control over a profile's plugin-tree configuration, for shells outside a
 * booted tree (the in-tree service and the web panel cover the live side).
 *
 * `log` lists what the profile has booted, `show` prints one configuration's
 * composition, `diff` compares two, and `restore` writes one configuration's
 * input files back. Verb behavior and output format mirror the launcher's
 * `dsh config` command (source: `apps/cli/src/config.ts` in deepseek-harness),
 * recomposed over this package's own profile host (`./host-profile.ts`).
 *
 * A restore refuses when the recorded composition can no longer be reproduced.
 * The composition names installed bundle packages, so replacing only the input
 * files after a bundle changed would compose a different tree and still look
 * like a successful return to an earlier state.
 * @module dsh-config-generations/cli
 */

import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { healProfilesModuleFallback, type Profile } from '@deepseek-ai/dsh-app-boot'
import {
  compareForRestore,
  digestText,
  lastActivated,
  latestStatus,
  readGenerations,
  selectGeneration,
} from './generations.ts'
import {
  homePatchPath,
  prepareProfile,
  readBundleStamps,
  renderDurableComposition,
} from './host-profile.ts'
import type { BundleStamp, ConfigGeneration } from './types.ts'

const NAME = 'dsh-config-generations'

/**
 * Heal the shared module fallback against this package's own anchor before
 * composing (source: profile-boot.ts `prepareProfile`). The fallback the boot
 * maintains already links the installation's closure; healing against this
 * anchor adds this package's, so a standalone restore composes through the
 * same two-anchor resolution a boot uses.
 */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** One `log` row: id, recency, boot outcome, and how many layers it composed. */
function describe(generation: ConfigGeneration, activeId: string | undefined): string {
  const status = latestStatus(generation) ?? 'unbooted'
  const marks = [
    generation.id === activeId ? 'last-good' : undefined,
    `${generation.bundles.length} bundle${generation.bundles.length === 1 ? '' : 's'}`,
  ].filter(mark => mark !== undefined)
  return `${generation.id}  ${generation.lastSeenAt}  ${status.padEnd(9)}  ${marks.join('  ')}`
}

/** Print every recorded configuration, oldest first. */
function runLog(generations: readonly ConfigGeneration[], profile: string): void {
  if (generations.length === 0) {
    process.stdout.write(`${NAME}: profile ${profile} has recorded no configuration yet; boot it once.\n`)
    return
  }
  const activeId = lastActivated(generations)?.id
  for (const generation of generations) process.stdout.write(`${describe(generation, activeId)}\n`)
}

/** Print one configuration's stored composition, with its bundle stamps as a header. */
function runShow(generation: ConfigGeneration): void {
  process.stdout.write(`# configuration ${generation.id}\n`)
  process.stdout.write(`# first seen ${generation.recordedAt}, last used ${generation.lastSeenAt}\n`)
  for (const bundle of generation.bundles) {
    process.stdout.write(`# bundle ${bundle.name}@${bundle.version ?? 'unversioned'}\n`)
  }
  for (const outcome of generation.outcomes) {
    process.stdout.write(`# ${outcome.at} ${outcome.status}${outcome.error === undefined ? '' : `: ${outcome.error}`}\n`)
  }
  process.stdout.write(generation.composed.render)
}

/**
 * Print a unified line diff of two stored compositions. Stored renders, not
 * recomposed ones, so a comparison stays available after the installed bundles
 * move underneath both sides.
 */
function runDiff(left: ConfigGeneration, right: ConfigGeneration): void {
  process.stdout.write(`--- ${left.id}  ${left.lastSeenAt}\n+++ ${right.id}  ${right.lastSeenAt}\n`)
  const leftLines = left.composed.render.split('\n')
  const rightLines = right.composed.render.split('\n')
  const leftSet = new Set(leftLines)
  const rightSet = new Set(rightLines)
  for (const line of leftLines) {
    if (!rightSet.has(line)) process.stdout.write(`-${line}\n`)
  }
  for (const line of rightLines) {
    if (!leftSet.has(line)) process.stdout.write(`+${line}\n`)
  }
  for (const bundle of right.bundles) {
    const before = left.bundles.find(candidate => candidate.name === bundle.name)
    if (before?.version !== bundle.version) {
      process.stdout.write(`# bundle ${bundle.name}: ${before?.version ?? 'absent'} -> ${bundle.version ?? 'unversioned'}\n`)
    }
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

/** The three input files a generation restores, paired with their recorded contents. */
function restoreTargets(loaded: Profile, generation: ConfigGeneration): InputSnapshot[] {
  return [
    { path: join(loaded.dir, 'package.json'), text: generation.inputs.manifest },
    { path: loaded.patchPath, text: generation.inputs.profilePatch },
    { path: homePatchPath(), text: generation.inputs.homePatch },
  ]
}

/**
 * Recompose the profile as it now stands on disk, through the same layers a
 * boot would stack.
 * @param profile - the profile name.
 * @returns the composition's digest and the bundle versions it resolved.
 */
function recompose(profile: string): { digest: string; bundles: BundleStamp[] } {
  const loaded = prepareProfile(profile)
  return { digest: digestText(renderDurableComposition(loaded)), bundles: readBundleStamps(loaded) }
}

/**
 * Write one configuration's inputs back, then confirm they still compose the
 * tree they were recorded with — and put the profile back as it was when they do
 * not.
 *
 * The check has to run against written files rather than the recorded texts,
 * because reproducing a composition means resolving the bundle packages the
 * manifest names against the current installation. Restoring first and undoing
 * on a mismatch reuses the one composition path a boot uses, instead of a
 * parallel one that could disagree with it.
 * @param loaded - the profile as the current installation resolves it.
 * @param generation - the configuration to return to.
 */
async function runRestore(loaded: Profile, generation: ConfigGeneration): Promise<void> {
  const targets = restoreTargets(loaded, generation)
  const previous: InputSnapshot[] = targets.map(target => ({
    path: target.path,
    text: existsSync(target.path) ? readFileSync(target.path, 'utf8') : null,
  }))
  const changes = []
  for (const target of targets) changes.push(await restoreInput(target.path, target.text))
  let verdict
  try {
    verdict = compareForRestore(generation, recompose(loaded.name))
  } catch (error) {
    // A recorded bundle the installation can no longer resolve fails inside
    // `loadProfile`, which is drift the digest never gets a chance to see.
    for (const entry of previous) await restoreInput(entry.path, entry.text)
    throw new Error(
      `${NAME}: configuration ${generation.id} no longer composes: `
      + `${error instanceof Error ? error.message : String(error)}\n`
      + `${NAME}: the profile is unchanged.`,
    )
  }
  if (!verdict.reproducible) {
    for (const entry of previous) await restoreInput(entry.path, entry.text)
    const lines = verdict.drift.map(drift =>
      `  ${drift.name}: recorded ${drift.recorded ?? 'absent'}, installed ${drift.current ?? 'absent'}`)
    throw new Error(
      `${NAME}: configuration ${generation.id} can no longer be reproduced, so restoring it would compose a different tree.\n`
      + (lines.length > 0
        ? `${NAME}: these bundles moved:\n${lines.join('\n')}\n`
        : `${NAME}: its inputs now compose a different tree with the same bundles.\n`)
      + `${NAME}: the profile is unchanged. Inspect what was recorded with `
      + `'${NAME} show --profile ${loaded.name} ${generation.id}'.`,
    )
  }
  for (const change of changes) process.stdout.write(`${NAME}: ${change}\n`)
  process.stdout.write(`${NAME}: profile ${loaded.name} is back at configuration ${generation.id}.\n`)
}

const USAGE = `usage: ${NAME} <action> --profile <name>
  log                     list recorded configurations
  show <id>               print one configuration's composition
  diff <id> [id]          compare two compositions (default: against the latest)
  restore <id>            write one configuration's input files back
`

/** The parsed invocation: one verb, its ids, and the profile it acts on. */
interface Invocation {
  action: 'log' | 'show' | 'diff' | 'restore'
  profile: string
  id?: string
  against?: string
}

/**
 * Parse argv into an invocation. Hand-rolled on purpose: the CLI stands alone
 * in a profile's dependency tree and pulls in no argument parser.
 * @param argv - process arguments after the node/script pair.
 * @returns the invocation.
 * @throws a usage line when the verb set, `--profile`, or the id counts do not parse.
 */
export function parseArgs(argv: readonly string[]): Invocation {
  let profile: string | undefined
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') {
      profile = argv[index + 1]
      if (profile === undefined) throw new Error(`${NAME}: --profile needs a profile name`)
      index += 1
    } else if (arg !== undefined && arg.startsWith('--')) {
      throw new Error(`${NAME}: unknown flag ${JSON.stringify(arg)}`)
    } else if (arg !== undefined) {
      positional.push(arg)
    }
  }
  const [action, id, against, ...rest] = positional
  if (profile === undefined) throw new Error(`${NAME}: --profile <name> is required`)
  if (action === 'log' && id === undefined) return { action, profile }
  if ((action === 'show' || action === 'restore') && id !== undefined && against === undefined) {
    return { action, profile, id }
  }
  if (action === 'diff' && id !== undefined && rest.length === 0) {
    return against === undefined ? { action, profile, id } : { action, profile, id, against }
  }
  throw new Error(`${NAME}: unknown action or wrong argument count\n${USAGE}`)
}

/**
 * Run one invocation.
 * @param invocation - the parsed verb, whose type already carries its argument count.
 * @returns the process exit code once the verb settles.
 */
export async function run(invocation: Invocation): Promise<number> {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const loaded = prepareProfile(invocation.profile)
  try {
    const { generations, unreadable } = readGenerations(loaded.dir)
    // Named on every verb, not just `log`: a restore that silently skipped the
    // record a person is looking for would be the worst place to stay quiet.
    for (const entry of unreadable) {
      process.stderr.write(`${NAME}: warning: ignoring unreadable record ${entry.path}: ${entry.reason}\n`)
    }
    switch (invocation.action) {
      case 'log':
        runLog(generations, invocation.profile)
        return 0
      case 'show':
        runShow(selectGeneration(generations, invocation.id as string))
        return 0
      case 'diff': {
        // A bare id compares that configuration against the most recent one,
        // which is the question a person asks after a boot started failing.
        const right = invocation.against === undefined
          ? generations.at(-1)
          : selectGeneration(generations, invocation.against)
        if (right === undefined) {
          throw new Error(`${NAME}: profile ${invocation.profile} has recorded no configuration to compare against`)
        }
        runDiff(selectGeneration(generations, invocation.id as string), right)
        return 0
      }
      case 'restore':
        await runRestore(loaded, selectGeneration(generations, invocation.id as string))
        return 0
    }
  } catch (error) {
    // The library's own diagnostics carry no bin prefix, so one is added here.
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message.startsWith(`${NAME}: `) ? message : `${NAME}: ${message}`}\n`)
    return 1
  }
}

/* v8 ignore next 4 -- the bin entry's own argv handoff; `run` is the tested unit */
// `realpathSync`: package managers link the bin name to this file, and Node
// keeps the symlink in argv[1] while import.meta.url is always resolved.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = await run(parseArgs(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
