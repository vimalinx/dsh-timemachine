/**
 * Export/import of a profile's whole history as one zip: every generation
 * record, the redo stack, and a manifest naming the archive format.
 *
 * The archive is a copy-out, copy-in format, not a sync protocol: importing
 * never overwrites an existing record (a content-addressed id already present
 * is skipped, not merged), and the redo stack imports only when the target has
 * none. `fflate`'s synchronous codec is enough at this size — a history is
 * dozens of small JSON records, so the archive stays in the kilobytes.
 * @module dsh-timemachine/archive
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  GENERATION_FORMAT_VERSION,
  readGenerations,
  readUndoState,
  resolveGenerationsDir,
  UNDO_STATE_FILENAME,
} from './generations.ts'

/** The archive format's stamp, carried in `manifest.json`. */
export const ARCHIVE_FORMAT_VERSION = 1

/** The archive layout's manifest filename. */
export const ARCHIVE_MANIFEST_FILENAME = 'manifest.json'

/** What an import did, per generation id it touched. */
export interface ImportResult {
  /** Ids written into the history. */
  imported: string[]
  /** Ids skipped because the record already exists locally (or is unreadable). */
  skipped: string[]
}

/**
 * Zip the history directory. Records are written from the readable set (a
 * corrupt record is not exported into someone else's history), keyed by id.
 * @param profileDir - the profile directory.
 * @returns the zip bytes.
 */
export function exportGenerations(profileDir: string): Uint8Array {
  const { generations } = readGenerations(profileDir)
  const files: Record<string, Uint8Array> = {}
  for (const generation of generations) {
    files[`${generation.id}.json`] = new TextEncoder().encode(JSON.stringify(generation, undefined, 2) + '\n')
  }
  const undo = readUndoState(profileDir)
  if (undo.redo.length > 0) {
    files[UNDO_STATE_FILENAME] = new TextEncoder().encode(JSON.stringify(undo, undefined, 2) + '\n')
  }
  files[ARCHIVE_MANIFEST_FILENAME] = new TextEncoder().encode(JSON.stringify({
    format: ARCHIVE_FORMAT_VERSION,
    recordFormat: GENERATION_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    generations: generations.length,
  }, undefined, 2) + '\n')
  return zipSync(files)
}

/**
 * Unzip an archive into the history directory without overwriting anything.
 * @param profileDir - the profile directory.
 * @param data - the zip bytes.
 * @returns which ids landed and which were skipped.
 */
export async function importGenerations(profileDir: string, data: Uint8Array): Promise<ImportResult> {
  const entries = unzipSync(data)
  const dir = resolveGenerationsDir(profileDir)
  const existing = new Set(readdirSafe(dir))
  const result: ImportResult = { imported: [], skipped: [] }
  for (const [name, bytes] of Object.entries(entries)) {
    if (!/^[0-9a-f]{12}\.json$/.test(name)) continue // manifest and undo-state are handled below
    const id = name.slice(0, -'.json'.length)
    if (existing.has(name)) {
      result.skipped.push(id)
      continue
    }
    // A record that does not parse as this format version belongs in the
    // skipped list, not in the history where it would read as corruption.
    let text: string
    try {
      text = new TextDecoder().decode(bytes)
      const parsed = JSON.parse(text) as { formatVersion?: unknown }
      if (parsed.formatVersion !== GENERATION_FORMAT_VERSION) throw new Error('format mismatch')
    } catch {
      result.skipped.push(id)
      continue
    }
    await writeFileAtomic(join(dir, name), text, { mode: 0o600, dirMode: 0o700 })
    result.imported.push(id)
  }
  // The redo stack imports only into a history that has none of its own.
  const undoBytes = entries[UNDO_STATE_FILENAME]
  if (undoBytes !== undefined && !existing.has(UNDO_STATE_FILENAME)) {
    await writeFileAtomic(
      join(dir, UNDO_STATE_FILENAME),
      new TextDecoder().decode(undoBytes),
      { mode: 0o600, dirMode: 0o700 },
    )
  }
  return result
}

/** List a directory that may not exist yet. */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
