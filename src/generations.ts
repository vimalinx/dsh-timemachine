/**
 * Version control for a `dsh` profile's plugin-tree configuration: the durable
 * inputs that compose the tree, the composition they produced, and every boot
 * attempt against it.
 *
 * A **generation** is one configuration, addressed by a digest of its inputs, so
 * the history records changes rather than launches: booting the same
 * configuration twice appends a second outcome to one record instead of adding a
 * second record. Records are one file each under
 * `<profile>/timemachine/`, which is what lets concurrent `dsh` processes
 * write without an append race.
 *
 * Reads and writes depend on no Cordis service, because the boot this records
 * has not mounted a tree yet — and a boot that fails to mount one is the case
 * the history exists for.
 *
 * This module owns the record format and the comparisons over it. Composing a
 * tree and rendering it belong to the profile host (`./host-profile.ts`),
 * which rebuilds the launcher's `loadProfile()`/`renderConfigDump()` closures;
 * callers pass the rendered result in.
 * @module dsh-timemachine/generations
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {
  BundleDrift,
  BundleStamp,
  ComposedTree,
  ConfigGeneration,
  CurrentComposition,
  GenerationEnvironment,
  GenerationInputs,
  GenerationOutcome,
  GenerationScope,
  GenerationsRead,
  OutcomeStatus,
  RestoreVerdict,
  UnreadableGeneration,
} from './types.ts'

export type * from './types.ts'

/**
 * The record format's stamp. Monotonic with no compatibility promise and no
 * migration: a record carrying another value is reported unreadable, which
 * degrades to an empty history rather than a failed boot.
 */
export const GENERATION_FORMAT_VERSION = 2

/** The generations directory inside a profile directory. */
export const GENERATIONS_DIRNAME = 'timemachine'

/**
 * How many generations one profile retains. The history answers "what did I
 * change recently", so it is bounded by count; the newest record carrying an
 * `activated` outcome is never pruned, because that is the one a recovery needs.
 */
export const GENERATION_RETENTION = 50

/** Hex characters of the input digest that form a generation id. */
const ID_LENGTH = 12

/**
 * Resolve a profile's generations directory.
 * @param profileDir - the profile directory.
 * @returns the absolute generations directory, which may not exist yet.
 */
export function resolveGenerationsDir(profileDir: string): string {
  return join(profileDir, GENERATIONS_DIRNAME)
}

/**
 * Digest one text with the algorithm every stored digest uses.
 * @param text - the exact bytes to digest.
 * @returns the lowercase hex digest.
 */
export function digestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Address one configuration by every input slot the observer could read.
 *
 * Absent slots are distinct from empty ones: the length-prefixed framing keeps a
 * missing `cordis.patch.yml` from digesting to the same value as an empty one, so
 * restoring a generation can tell "delete the file" from "write nothing into it".
 * The same framing is why a `composition`-scope record (no environment) and a
 * `full`-scope one taken at the same instant get different ids instead of
 * overwriting each other.
 * @param inputs - the generation's durable input texts.
 * @param environment - what a running tree saw beside them, or `null` from the launcher's vantage.
 * @returns the generation id.
 */
export function generationId(inputs: GenerationInputs, environment: GenerationEnvironment | null): string {
  const frame = (value: string | null): string => value === null ? 'absent\n' : `present ${value.length}\n${value}`
  const slots = [frame(inputs.manifest), frame(inputs.profilePatch), frame(inputs.homePatch)]
  if (environment === null) slots.push('environment absent\n')
  else {
    slots.push('environment present\n', frame(environment.settings?.text ?? null))
    // Preset order is the roster's, which is stable for one installation; sorting
    // by id keeps the digest from moving when only discovery order does.
    for (const preset of [...environment.presets].sort((left, right) => left.id.localeCompare(right.id))) {
      slots.push(`preset ${preset.id}\n`, frame(preset.text))
    }
  }
  return digestText(slots.join('')).slice(0, ID_LENGTH)
}

/**
 * Validate one parsed record file. The generations directory is a durable
 * boundary a person edits by hand, so every field a reader depends on is
 * checked here over `unknown` rather than trusted from a parse type.
 * @param value - the parsed JSON value.
 * @returns the generation, or a rejection reason.
 */
function validateGeneration(value: unknown): { generation: ConfigGeneration } | { reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { reason: 'not a JSON object' }
  const record = value as Record<string, unknown>
  if (record.formatVersion !== GENERATION_FORMAT_VERSION) {
    return { reason: `format version ${JSON.stringify(record.formatVersion)} is not ${GENERATION_FORMAT_VERSION}` }
  }
  for (const field of ['id', 'recordedAt', 'lastSeenAt', 'profile']) {
    if (typeof record[field] !== 'string') return { reason: `\`${field}\` must be a string` }
  }
  if (record.scope !== 'composition' && record.scope !== 'full') {
    return { reason: '`scope` must be "composition" or "full"' }
  }
  if (record.environment !== null && (typeof record.environment !== 'object' || Array.isArray(record.environment))) {
    return { reason: '`environment` must be a JSON object or null' }
  }
  const inputs = record.inputs
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    return { reason: '`inputs` must be a JSON object' }
  }
  const inputFields = inputs as Record<string, unknown>
  if (typeof inputFields.manifest !== 'string') return { reason: '`inputs.manifest` must be a string' }
  for (const field of ['profilePatch', 'homePatch']) {
    const patch = inputFields[field]
    if (patch !== null && typeof patch !== 'string') {
      return { reason: `\`inputs.${field}\` must be a string or null` }
    }
  }
  const composed = record.composed
  if (typeof composed !== 'object' || composed === null || Array.isArray(composed)) {
    return { reason: '`composed` must carry a digest and a render' }
  }
  const composedFields = composed as Record<string, unknown>
  if (typeof composedFields.digest !== 'string' || typeof composedFields.render !== 'string') {
    return { reason: '`composed` must carry a digest and a render' }
  }
  if (!Array.isArray(record.bundles) || !Array.isArray(record.outcomes)) {
    return { reason: '`bundles` and `outcomes` must be arrays' }
  }
  return { generation: value as ConfigGeneration }
}

/**
 * Read every generation one profile currently holds.
 *
 * A directory that does not exist reads as an empty history — a profile that
 * has never booted has no generations, which is not an error.
 * @param profileDir - the profile directory.
 * @returns the readable generations oldest `lastSeenAt` first, plus every rejected file.
 */
export function readGenerations(profileDir: string): GenerationsRead {
  const dir = resolveGenerationsDir(profileDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    // A profile that never booted has no directory, and an unreadable one
    // leaves nothing to recover from; both are an empty history, and the
    // caller's next write reports any real permission failure.
    return { generations: [], unreadable: [] }
  }
  const generations: ConfigGeneration[] = []
  const unreadable: UnreadableGeneration[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      unreadable.push({ path, reason: String(error) })
      continue
    }
    const checked = validateGeneration(parsed)
    if ('reason' in checked) unreadable.push({ path, reason: checked.reason })
    else generations.push(checked.generation)
  }
  generations.sort((left, right) => left.lastSeenAt === right.lastSeenAt
    ? left.id.localeCompare(right.id)
    : left.lastSeenAt.localeCompare(right.lastSeenAt))
  return { generations, unreadable }
}

/** Write one record so a concurrent reader never sees a partial file. */
async function writeGeneration(dir: string, generation: ConfigGeneration): Promise<void> {
  await writeFileAtomic(
    join(dir, `${generation.id}.json`),
    JSON.stringify(generation, undefined, 2) + '\n',
    { mode: 0o600, dirMode: 0o700 },
  )
}

/**
 * Drop the oldest records beyond {@link GENERATION_RETENTION}, keeping the
 * newest one that carries an `activated` outcome whatever its age — a recovery
 * needs the last known-good configuration, not the last N launches.
 */
function prune(dir: string, generations: readonly ConfigGeneration[]): void {
  if (generations.length <= GENERATION_RETENTION) return
  const keepActivated = [...generations].reverse()
    .find(generation => generation.outcomes.some(outcome => outcome.status === 'activated'))
  for (const generation of generations.slice(0, generations.length - GENERATION_RETENTION)) {
    if (generation.id === keepActivated?.id) continue
    try {
      unlinkSync(join(dir, `${generation.id}.json`))
    } catch {
      // Retention is housekeeping: another process pruning the same record, or
      // a read-only history directory, must not fail the boot being recorded.
    }
  }
}

/** What {@link recordGeneration} needs to describe one observed configuration. */
export interface RecordGenerationOptions {
  /** The profile directory the record lands under. */
  profileDir: string
  /** The profile name. */
  profile: string
  /** The durable input texts this composition read. */
  inputs: GenerationInputs
  /**
   * What a running tree saw beside the composition. Omit (or pass `null`) from
   * the launcher, whose vantage cannot reach it.
   */
  environment?: GenerationEnvironment | null
  /** The resolved bundle layers, in composition order. */
  bundles: BundleStamp[]
  /** The durable-only composition, rendered as loadable YAML. */
  render: string
  /** ISO timestamp for this observation. */
  now: string
}

/**
 * Record one observed configuration, or adopt the existing record when this
 * configuration has been seen before.
 *
 * The returned generation's `id` is what {@link appendOutcome} settles once the
 * boot it precedes resolves. Recording never fails a boot: an unwritable
 * history directory throws, so callers that must survive it catch — the record
 * is a recovery aid, not a boot precondition.
 * @param options - the composition to record.
 * @returns the stored generation once written, whether newly created or adopted.
 */
export function recordGeneration(options: RecordGenerationOptions): Promise<ConfigGeneration> {
  const dir = resolveGenerationsDir(options.profileDir)
  const environment = options.environment ?? null
  const id = generationId(options.inputs, environment)
  const scope: GenerationScope = environment === null ? 'composition' : 'full'
  const existing = readGenerations(options.profileDir).generations
  const previous = existing.find(generation => generation.id === id)
  const composed: ComposedTree = { digest: digestText(options.render), render: options.render }
  const generation: ConfigGeneration = {
    formatVersion: GENERATION_FORMAT_VERSION,
    id,
    scope,
    // First sighting is identity; a hand-reverted configuration is the same
    // configuration and keeps the timestamp it was first seen with.
    recordedAt: previous?.recordedAt ?? options.now,
    lastSeenAt: options.now,
    profile: options.profile,
    inputs: options.inputs,
    environment,
    bundles: options.bundles,
    composed,
    outcomes: previous?.outcomes ?? [],
  }
  return writeGeneration(dir, generation).then(() => {
    if (previous === undefined) prune(dir, [...existing, generation])
    return generation
  })
}

/**
 * Settle one boot attempt against the generation it composed.
 *
 * A record that vanished between the attempt and its settlement is not
 * recreated: the outcome describes a generation, and inventing one from an
 * outcome would record a configuration nobody observed.
 * @param profileDir - the profile directory.
 * @param id - the generation id {@link recordGeneration} returned.
 * @param outcome - the settled attempt.
 * @returns whether the outcome was appended once written.
 */
export async function appendOutcome(
  profileDir: string, id: string, outcome: GenerationOutcome,
): Promise<boolean> {
  const dir = resolveGenerationsDir(profileDir)
  const generation = readGenerations(profileDir).generations.find(candidate => candidate.id === id)
  if (generation === undefined) return false
  await writeGeneration(dir, { ...generation, outcomes: [...generation.outcomes, outcome] })
  return true
}

/**
 * The newest generation that reached an activated tree — the configuration a
 * recovery restores to.
 * @param generations - generations in `readGenerations` order.
 * @returns the newest activated generation, or `undefined` when none has activated.
 */
export function lastActivated(generations: readonly ConfigGeneration[]): ConfigGeneration | undefined {
  return [...generations].reverse().find(
    generation => generation.outcomes.some(outcome => outcome.status === 'activated'),
  )
}

/**
 * The status of a generation's most recent boot attempt.
 * @param generation - the generation to summarize.
 * @returns the latest outcome's status, or `undefined` when no attempt settled.
 */
export function latestStatus(generation: ConfigGeneration): OutcomeStatus | undefined {
  return generation.outcomes.at(-1)?.status
}

/**
 * Resolve one generation by id, or by an unambiguous id prefix.
 *
 * A prefix is how a person addresses a record they read off a `log` line, so an
 * ambiguous one names every candidate instead of picking the first.
 * @param generations - the generations to search.
 * @param id - the full id or a prefix of one.
 * @returns the single match.
 * @throws when nothing matches, naming that the profile has no records at all when it has none.
 * @throws when the prefix matches more than one record, naming every candidate.
 */
export function selectGeneration(generations: readonly ConfigGeneration[], id: string): ConfigGeneration {
  const matches = generations.filter(generation => generation.id === id || generation.id.startsWith(id))
  const [first, ...rest] = matches
  if (first === undefined) {
    throw new Error(
      `no recorded configuration ${JSON.stringify(id)}`
      + (generations.length === 0 ? ' (this profile has none yet)' : ''),
    )
  }
  if (rest.length > 0) {
    throw new Error(
      `${JSON.stringify(id)} matches ${matches.length} configurations: `
      + matches.map(generation => generation.id).join(', '),
    )
  }
  return first
}

/**
 * Compare one bundle list against another, in composition order.
 * @param recorded - the bundle layers stored with the generation.
 * @param current - the bundle layers the installation resolves now.
 * @returns one entry per differing package.
 */
function compareBundles(recorded: readonly BundleStamp[], current: readonly BundleStamp[]): BundleDrift[] {
  const currentByName = new Map(current.map(bundle => [bundle.name, bundle]))
  const drift: BundleDrift[] = []
  for (const bundle of recorded) {
    const match = currentByName.get(bundle.name)
    if (match === undefined) {
      drift.push({ name: bundle.name, recorded: bundle.version })
      continue
    }
    if (match.version !== bundle.version) {
      drift.push({ name: bundle.name, recorded: bundle.version, current: match.version })
    }
  }
  const recordedNames = new Set(recorded.map(bundle => bundle.name))
  for (const bundle of current) {
    if (!recordedNames.has(bundle.name)) drift.push({ name: bundle.name, current: bundle.version })
  }
  return drift
}

/**
 * Decide whether writing a generation's inputs back would reproduce the tree it
 * was recorded with.
 *
 * The composition is not self-contained — it names installed bundle packages —
 * so a restore that only replaced the input files could compose a different tree
 * than the one recorded and still report success. This comparison is what keeps
 * that from happening; a caller recomposes the generation's inputs against the
 * current installation and passes the result in.
 * @param generation - the generation being restored.
 * @param current - what the current installation composes from those same inputs.
 * @returns the verdict, naming every drifted bundle.
 */
export function compareForRestore(generation: ConfigGeneration, current: CurrentComposition): RestoreVerdict {
  const drift = compareBundles(generation.bundles, current.bundles)
  const digestChanged = current.digest !== generation.composed.digest
  return { reproducible: drift.length === 0 && !digestChanged, drift, digestChanged }
}
