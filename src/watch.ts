/**
 * The auto-save filesystem watcher: observe the three durable input files and
 * fire once they settle into a configuration that was not just seen.
 *
 * The watched files may not exist (both patch layers are optional), and the
 * service's own restores replace them atomically (write temp, rename over) —
 * an `fs.watch` on the file dies with the inode in both cases. So the watcher
 * observes the containing DIRECTORIES and filters by basename, which sees
 * creations, deletions, and atomic replacements alike.
 *
 * Firing is debounced (`debounceMs`), and a settled state whose input digest
 * equals the last seen one does not fire at all — editors that rewrite a file
 * without changing it, and the several events one save produces, collapse to
 * silence. The `shouldIgnore` callback is the service's self-write suppression:
 * a digest the service itself just wrote (a restore, an undo) is consumed
 * without firing, so an automatic record never tramples the redo stack its own
 * write would otherwise clear.
 * @module dsh-timemachine/watch
 */

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { generationId } from './generations.ts'
import type { GenerationInputs } from './types.ts'

/** What {@link watchInputs} needs to observe one profile's inputs. */
export interface WatchInputsOptions {
  /** The profile directory (its `package.json` and `cordis.patch.yml` are watched). */
  profileDir: string
  /** The Harness home (`cordis.patch.yml` is watched); omit to skip the home layer. */
  homeDir?: string
  /** How long edits settle before the state is re-read, in milliseconds. */
  debounceMs: number
  /** Self-write suppression: whether this digest was written by the service itself. */
  shouldIgnore: (digest: string) => boolean
  /** Called once per settled, genuinely changed, not-self-written input state. */
  onChange: () => void
}

/** The watched basenames per directory. */
const PROFILE_FILES = new Set(['package.json', 'cordis.patch.yml'])
const HOME_FILES = new Set(['cordis.patch.yml'])

/**
 * Digest the inputs as they now stand on disk. Same framing as a
 * `composition`-scope generation id, so the service can register the digest a
 * restore is about to produce and have it recognized here verbatim.
 */
function readInputsDigest(profileDir: string, homeDir: string | undefined): string {
  const read = (path: string): string | null => existsSync(path) ? readFileSync(path, 'utf8') : null
  const inputs: GenerationInputs = {
    manifest: read(join(profileDir, 'package.json')) ?? '',
    profilePatch: read(join(profileDir, 'cordis.patch.yml')),
    homePatch: homeDir === undefined ? null : read(join(homeDir, 'cordis.patch.yml')),
  }
  return generationId(inputs, null)
}

/**
 * Start watching. The watcher is best-effort: a directory that cannot be
 * watched (permissions, removal mid-boot) is skipped rather than failing the
 * caller, and a state that cannot be re-read fires nothing.
 * @param options - what to watch and how to answer.
 * @returns a stop function closing every underlying watcher and pending timer.
 */
export function watchInputs(options: WatchInputsOptions): () => void {
  let last = readInputsDigest(options.profileDir, options.homeDir)
  let timer: NodeJS.Timeout | undefined
  const watchers: FSWatcher[] = []

  const settle = (): void => {
    let digest: string
    try {
      digest = readInputsDigest(options.profileDir, options.homeDir)
    } catch {
      // A manifest mid-replacement reads as garbage; the next event retries.
      return
    }
    if (digest === last) return
    last = digest
    if (options.shouldIgnore(digest)) return
    options.onChange()
  }

  const onEvent = (names: Set<string>) => (_event: string, filename: string | null): void => {
    if (filename === null || !names.has(filename)) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(settle, options.debounceMs)
  }

  const observe = (dir: string, names: Set<string>): void => {
    try {
      watchers.push(watch(dir, { persistent: false }, onEvent(names)))
    } catch {
      // Best-effort: an unwatchable directory silently narrows coverage.
    }
  }
  observe(options.profileDir, PROFILE_FILES)
  if (options.homeDir !== undefined && options.homeDir !== options.profileDir) {
    observe(options.homeDir, HOME_FILES)
  }

  return () => {
    if (timer !== undefined) clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
  }
}
