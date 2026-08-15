/**
 * The plugin's own settings, persisted at `<profile>/timemachine/settings.json`.
 *
 * The file is a durable boundary a person edits by hand, like the generation
 * records themselves: a missing file reads as the defaults, and fields that are
 * missing or hold the wrong type merge over the defaults rather than failing
 * the read. Writes take a patch and merge it (`shortcuts` per key), so one
 * surface updating `retention` cannot clobber another's `shortcuts` edit.
 * @module dsh-timemachine/settings
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveGenerationsDir, SETTINGS_FILENAME } from './generations.ts'
import type { TimemachineSettings, TimemachineSettingsPatch } from './types.ts'

/** The settings every absent or unreadable field falls back to. */
export const DEFAULT_TIMEMACHINE_SETTINGS: TimemachineSettings = {
  autoSave: true,
  debounceMs: 1500,
  retention: 50,
  shortcuts: { undo: 'Ctrl+Alt+Z', redo: 'Ctrl+Alt+Y' },
}

/**
 * Read the settings, merging whatever the file holds over the defaults.
 * @param profileDir - the profile directory.
 * @returns the effective settings.
 */
export function readTimemachineSettings(profileDir: string): TimemachineSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(resolveGenerationsDir(profileDir), SETTINGS_FILENAME), 'utf8'))
  } catch {
    // No file (never configured) or a damaged one (hand-edit gone wrong):
    // both read as the defaults; the next write reports any real failure.
    return DEFAULT_TIMEMACHINE_SETTINGS
  }
  return mergeSettings(DEFAULT_TIMEMACHINE_SETTINGS, parsed)
}

/**
 * Apply a patch over the stored settings and write the result atomically.
 * @param profileDir - the profile directory.
 * @param patch - the fields to change; absent fields keep their stored values.
 * @returns the effective settings after the write.
 */
export async function writeTimemachineSettings(
  profileDir: string, patch: TimemachineSettingsPatch,
): Promise<TimemachineSettings> {
  const next = mergeSettings(readTimemachineSettings(profileDir), patch)
  await writeFileAtomic(
    join(resolveGenerationsDir(profileDir), SETTINGS_FILENAME),
    JSON.stringify(next, undefined, 2) + '\n',
    { mode: 0o600, dirMode: 0o700 },
  )
  return next
}

/**
 * Merge a patch (typed) or a parsed file (untrusted) over a base, field by
 * field. Untrusted input contributes only the fields that hold the right type;
 * everything else leaves the base untouched.
 */
function mergeSettings(base: TimemachineSettings, patch: unknown): TimemachineSettings {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return base
  const record = patch as Record<string, unknown>
  const shortcuts = typeof record.shortcuts === 'object' && record.shortcuts !== null
    ? record.shortcuts as Record<string, unknown>
    : {}
  return {
    autoSave: typeof record.autoSave === 'boolean' ? record.autoSave : base.autoSave,
    debounceMs: positiveNumber(record.debounceMs) ?? base.debounceMs,
    retention: positiveNumber(record.retention) ?? base.retention,
    shortcuts: {
      undo: typeof shortcuts.undo === 'string' && shortcuts.undo.length > 0 ? shortcuts.undo : base.shortcuts.undo,
      redo: typeof shortcuts.redo === 'string' && shortcuts.redo.length > 0 ? shortcuts.redo : base.shortcuts.redo,
    },
  }
}

/** Narrow an untrusted value to a positive finite number, or `undefined`. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
