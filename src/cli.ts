#!/usr/bin/env node
/**
 * `dsh-timemachine <action> --profile <name>` — standalone version
 * control over a profile's plugin-tree configuration, for shells outside a
 * booted tree (the in-tree service and the web panel cover the live side).
 *
 * `log` lists what the profile has booted, `show` prints one configuration's
 * composition, `diff` compares two, and `restore` writes one configuration's
 * input files back. `undo`/`redo` step through the history, `snapshot` records
 * the configuration as it stands, `remove` deletes one record, `status`
 * reports undo/redo availability and boot health, `export`/`import` move the
 * history as one zip, `prune` applies the retention bound on demand, and
 * `settings` reads and writes the plugin's own settings. `gui` serves the
 * rescue page (`./gui.ts`) for when no dsh tree boots at all. Verb behavior
 * and output format mirror the launcher's `dsh config` command (source:
 * `apps/cli/src/config.ts` in deepseek-harness), recomposed over this
 * package's own profile host (`./host-profile.ts`) and the standalone
 * operations (`./standalone.ts`).
 *
 * A restore refuses when the recorded composition can no longer be reproduced.
 * The composition names installed bundle packages, so replacing only the input
 * files after a bundle changed would compose a different tree and still look
 * like a successful return to an earlier state.
 * @module dsh-timemachine/cli
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { exportGenerations, importGenerations } from './archive.ts'
import {
  lastActivated,
  latestStatus,
  readGenerations,
  selectGeneration,
} from './generations.ts'
import {
  openProfile,
  pruneStandalone,
  redoStandalone,
  removeStandalone,
  restoreGeneration,
  snapshotStandalone,
  statusStandalone,
  undoStandalone,
  type StandaloneHost,
} from './standalone.ts'
import { readTimemachineSettings, writeTimemachineSettings } from './settings.ts'
import type {
  ConfigGeneration,
  RestoreResult,
  StackRestoreResult,
  TimemachineSettings,
  TimemachineSettingsPatch,
} from './types.ts'

const NAME = 'dsh-timemachine'

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

/** Report a restore's outcome the way `restore`, `undo`, and `redo` all print it. */
function reportRestore(result: RestoreResult, verb: string, profile: string): number {
  if (!result.restored) {
    for (const line of (result.refusal ?? 'restore refused').split('\n')) {
      process.stderr.write(`${NAME}: ${line}\n`)
    }
    return 1
  }
  for (const change of result.changes) process.stdout.write(`${NAME}: ${change}\n`)
  process.stdout.write(`${NAME}: profile ${profile} ${verb} configuration ${result.id}.\n`)
  return 0
}

/** Run one undo/redo step and report it; an empty stack is a refusal (exit 1). */
function reportStep(step: StackRestoreResult, direction: 'undo' | 'redo', profile: string): number {
  if (step.empty !== undefined) {
    process.stderr.write(`${NAME}: ${direction === 'undo' ? 'nothing to undo' : 'nothing to redo'}.\n`)
    return 1
  }
  if (step.result === undefined) return 1
  return reportRestore(
    step.result,
    direction === 'undo' ? 'stepped back to' : 'stepped forward to',
    profile,
  )
}

/** Print the undo/redo availability, boot health, and latest configuration. */
function runStatus(host: StandaloneHost, generations: readonly ConfigGeneration[]): void {
  const status = statusStandalone(host)
  const latest = generations.at(-1)
  process.stdout.write(`profile: ${host.profile}\n`)
  process.stdout.write(`generations: ${status.total}\n`)
  process.stdout.write(`undo: ${status.canUndo ? 'available' : 'nothing to undo'}\n`)
  process.stdout.write(`redo: ${status.canRedo ? 'available' : 'nothing to redo'}\n`)
  process.stdout.write(`last boot: ${latest === undefined ? 'no boot recorded' : status.lastBootFailed ? 'failed' : 'ok'}\n`)
  if (latest !== undefined) {
    process.stdout.write(`latest: ${describe(latest, lastActivated(generations)?.id)}\n`)
  }
}

/** Print the effective settings, one `key: value` pair per line. */
function printSettings(settings: TimemachineSettings): void {
  process.stdout.write(`autoSave: ${settings.autoSave}\n`)
  process.stdout.write(`debounceMs: ${settings.debounceMs}\n`)
  process.stdout.write(`retention: ${settings.retention}\n`)
  process.stdout.write(`shortcuts.undo: ${settings.shortcuts.undo}\n`)
  process.stdout.write(`shortcuts.redo: ${settings.shortcuts.redo}\n`)
}

/**
 * Parse one `--set key=value` pair into a settings patch. Every pair is
 * validated BEFORE any write, so a bad pair leaves the settings file
 * untouched.
 * @param pair - the raw `key=value` text.
 * @returns the patch fragment.
 * @throws naming the pair when the key is unknown or the value invalid.
 */
function parseSettingPair(pair: string): TimemachineSettingsPatch {
  const boundary = pair.indexOf('=')
  const key = boundary < 0 ? pair : pair.slice(0, boundary)
  const value = boundary < 0 ? '' : pair.slice(boundary + 1)
  const invalid = `${NAME}: invalid --set ${JSON.stringify(pair)}`
  switch (key) {
    case 'autoSave':
      if (value === 'true') return { autoSave: true }
      if (value === 'false') return { autoSave: false }
      throw new Error(`${invalid}: autoSave is 'true' or 'false'`)
    case 'debounceMs':
    case 'retention': {
      const number = Number(value)
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`${invalid}: ${key} is a positive integer`)
      }
      return key === 'debounceMs' ? { debounceMs: number } : { retention: number }
    }
    case 'shortcuts.undo':
      if (value.length === 0) throw new Error(`${invalid}: shortcuts.undo is a non-empty string`)
      return { shortcuts: { undo: value } }
    case 'shortcuts.redo':
      if (value.length === 0) throw new Error(`${invalid}: shortcuts.redo is a non-empty string`)
      return { shortcuts: { redo: value } }
    default:
      throw new Error(`${invalid}: known keys are autoSave, debounceMs, retention, shortcuts.undo, shortcuts.redo`)
  }
}

/** Fold the `--set` pairs into one patch (shortcuts merge per key). */
function mergeSettingPairs(pairs: readonly string[]): TimemachineSettingsPatch {
  const patch: TimemachineSettingsPatch = {}
  for (const pair of pairs) {
    const fragment = parseSettingPair(pair)
    patch.autoSave = fragment.autoSave ?? patch.autoSave
    patch.debounceMs = fragment.debounceMs ?? patch.debounceMs
    patch.retention = fragment.retention ?? patch.retention
    if (fragment.shortcuts !== undefined) {
      patch.shortcuts = { ...patch.shortcuts, ...fragment.shortcuts }
    }
  }
  return patch
}

/** The default export filename: local time, sortable, spaces free. */
function defaultExportName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${NAME}-${stamp}.zip`
}

const USAGE = `usage: ${NAME} <action> --profile <name>
  log                     list recorded configurations
  show <id>               print one configuration's composition
  diff <id> [id]          compare two compositions (default: against the latest)
  restore <id>            write one configuration's input files back
  undo                    step back to the previous configuration
  redo                    step forward to the configuration an undo stepped away from
  snapshot [reason]       record the configuration as it now stands
  remove <id>             delete one record (the last known-good one is protected)
  status                  undo/redo availability, boot health, latest configuration
  export [out.zip]        zip the whole history (default: ${NAME}-<YYYYMMDD-HHmmss>.zip)
  import <zip>            unzip an archive into the history, never overwriting
  prune                   apply the retention bound now
  settings [--set k=v]    print the settings; --set updates autoSave, debounceMs,
                          retention, shortcuts.undo, shortcuts.redo (repeatable)
  gui                     serve the rescue page on 127.0.0.1 and open a browser
`

/** The parsed invocation: one verb, its arguments, and the profile it acts on. */
export type Invocation =
  | { action: 'log', profile: string }
  | { action: 'show' | 'restore' | 'remove', profile: string, id: string }
  | { action: 'diff', profile: string, id: string, against?: string }
  | { action: 'undo' | 'redo' | 'status' | 'prune' | 'gui', profile: string }
  | { action: 'snapshot', profile: string, reason?: string }
  | { action: 'export', profile: string, out?: string }
  | { action: 'import', profile: string, zip: string }
  | { action: 'settings', profile: string, sets: string[] }
  | { action: 'help' }

/**
 * Parse argv into an invocation. Hand-rolled on purpose: the CLI stands alone
 * in a profile's dependency tree and pulls in no argument parser.
 * @param argv - process arguments after the node/script pair.
 * @returns the invocation.
 * @throws a usage line when the verb set, `--profile`, or the argument counts do not parse.
 */
export function parseArgs(argv: readonly string[]): Invocation {
  let profile: string | undefined
  const sets: string[] = []
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') {
      profile = argv[index + 1]
      if (profile === undefined) throw new Error(`${NAME}: --profile needs a profile name`)
      index += 1
    } else if (arg === '--set') {
      const pair = argv[index + 1]
      if (pair === undefined) throw new Error(`${NAME}: --set needs a key=value pair`)
      sets.push(pair)
      index += 1
    } else if (arg === '-h' || arg === '--help') {
      return { action: 'help' }
    } else if (arg !== undefined && arg.startsWith('--')) {
      throw new Error(`${NAME}: unknown flag ${JSON.stringify(arg)}`)
    } else if (arg !== undefined) {
      positional.push(arg)
    }
  }
  const [action, first, second, ...rest] = positional
  if (sets.length > 0 && action !== 'settings') {
    throw new Error(`${NAME}: --set only goes with the settings action\n${USAGE}`)
  }
  if (action === undefined) throw new Error(`${NAME}: an action is required\n${USAGE}`)
  if (profile === undefined) throw new Error(`${NAME}: --profile <name> is required`)
  const name = profile
  switch (action) {
    case 'log':
    case 'undo':
    case 'redo':
    case 'status':
    case 'prune':
    case 'gui':
      if (first === undefined) return { action, profile: name }
      break
    case 'show':
    case 'restore':
    case 'remove':
      if (first !== undefined && second === undefined) return { action, profile: name, id: first }
      break
    case 'diff':
      if (first !== undefined && rest.length === 0) {
        return second === undefined
          ? { action, profile: name, id: first }
          : { action, profile: name, id: first, against: second }
      }
      break
    case 'snapshot':
      if (second === undefined) {
        return { action, profile: name, ...first === undefined ? {} : { reason: first } }
      }
      break
    case 'export':
      if (second === undefined) {
        return { action, profile: name, ...first === undefined ? {} : { out: first } }
      }
      break
    case 'import':
      if (first !== undefined && second === undefined) return { action, profile: name, zip: first }
      break
    case 'settings':
      if (first === undefined) return { action, profile: name, sets }
      break
  }
  throw new Error(`${NAME}: unknown action or wrong argument count\n${USAGE}`)
}

/**
 * Run one invocation.
 * @param invocation - the parsed verb, whose type already carries its argument count.
 * @returns the process exit code once the verb settles.
 */
export async function run(invocation: Invocation): Promise<number> {
  if (invocation.action === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    const host = openProfile(invocation.profile)
    const { generations, unreadable } = readGenerations(host.profileDir)
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
        runShow(selectGeneration(generations, invocation.id))
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
        runDiff(selectGeneration(generations, invocation.id), right)
        return 0
      }
      case 'restore':
        return reportRestore(
          await restoreGeneration(host, selectGeneration(generations, invocation.id)),
          'is back at',
          invocation.profile,
        )
      case 'undo':
        return reportStep(await undoStandalone(host, new Date().toISOString()), 'undo', invocation.profile)
      case 'redo':
        return reportStep(await redoStandalone(host), 'redo', invocation.profile)
      case 'snapshot': {
        const generation = await snapshotStandalone(host, invocation.reason, new Date().toISOString())
        process.stdout.write(`${NAME}: recorded configuration ${generation.id}`
          + `${generation.reason === undefined ? '' : ` (${generation.reason})`}.\n`)
        return 0
      }
      case 'remove': {
        const generation = selectGeneration(generations, invocation.id)
        const result = removeStandalone(host, generation.id)
        if (!result.removed) {
          process.stderr.write(`${NAME}: ${result.refusal ?? 'remove refused'}\n`)
          return 1
        }
        process.stdout.write(`${NAME}: removed configuration ${generation.id}.\n`)
        return 0
      }
      case 'status':
        runStatus(host, generations)
        return 0
      case 'export': {
        const out = invocation.out ?? defaultExportName(new Date())
        const bytes = exportGenerations(host.profileDir)
        writeFileSync(out, bytes)
        process.stdout.write(`${NAME}: wrote ${out} (${generations.length} configuration`
          + `${generations.length === 1 ? '' : 's'}).\n`)
        return 0
      }
      case 'import': {
        const result = await importGenerations(host.profileDir, readFileSync(invocation.zip))
        process.stdout.write(`${NAME}: imported ${result.imported.length}, skipped ${result.skipped.length}`
          + `${result.skipped.length === 0 ? '' : ` (${result.skipped.join(', ')})`}.\n`)
        return 0
      }
      case 'prune': {
        const removed = pruneStandalone(host)
        if (removed.length === 0) {
          process.stdout.write(`${NAME}: nothing to prune.\n`)
        } else {
          for (const id of removed) process.stdout.write(`${NAME}: pruned configuration ${id}.\n`)
        }
        return 0
      }
      case 'settings': {
        if (invocation.sets.length > 0) {
          printSettings(await writeTimemachineSettings(host.profileDir, mergeSettingPairs(invocation.sets)))
        } else {
          printSettings(readTimemachineSettings(host.profileDir))
        }
        return 0
      }
      case 'gui': {
        const { runGui } = await import('./gui.ts')
        return await runGui(host)
      }
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
