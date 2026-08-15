/**
 * The plugin settings file: defaults for what is absent, per-field merge for
 * what is present, and patch writes that keep the fields nobody touched.
 * @module dsh-timemachine/tests/settings
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveGenerationsDir } from '../src/generations.ts'
import {
  DEFAULT_TIMEMACHINE_SETTINGS,
  readTimemachineSettings,
  writeTimemachineSettings,
} from '../src/settings.ts'

let profileDir: string

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'dsh-timemachine-settings-'))
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

/** Write a raw settings file (as a hand edit would). */
function writeRaw(value: unknown): void {
  mkdirSync(resolveGenerationsDir(profileDir), { recursive: true })
  writeFileSync(join(resolveGenerationsDir(profileDir), 'settings.json'), JSON.stringify(value))
}

describe('reading settings', () => {
  it('answers the defaults when no file exists', () => {
    expect(readTimemachineSettings(profileDir)).toEqual(DEFAULT_TIMEMACHINE_SETTINGS)
    expect(DEFAULT_TIMEMACHINE_SETTINGS).toEqual({
      autoSave: true,
      debounceMs: 1500,
      retention: 50,
      shortcuts: { undo: 'Ctrl+Alt+Z', redo: 'Ctrl+Alt+Y' },
    })
  })

  it('answers the defaults for a damaged file', () => {
    mkdirSync(resolveGenerationsDir(profileDir), { recursive: true })
    writeFileSync(join(resolveGenerationsDir(profileDir), 'settings.json'), '{ nope')
    expect(readTimemachineSettings(profileDir)).toEqual(DEFAULT_TIMEMACHINE_SETTINGS)
  })

  it('merges stored fields over the defaults, one shortcut at a time', () => {
    writeRaw({ retention: 10, shortcuts: { undo: 'Ctrl+Z' } })
    expect(readTimemachineSettings(profileDir)).toEqual({
      ...DEFAULT_TIMEMACHINE_SETTINGS,
      retention: 10,
      shortcuts: { undo: 'Ctrl+Z', redo: 'Ctrl+Alt+Y' },
    })
  })

  it('ignores fields holding the wrong type', () => {
    writeRaw({ autoSave: 'yes', debounceMs: -5, retention: 'lots', shortcuts: { undo: 3 } })
    expect(readTimemachineSettings(profileDir)).toEqual(DEFAULT_TIMEMACHINE_SETTINGS)
  })
})

describe('writing settings', () => {
  it('round-trips a patch and keeps the fields it did not touch', async () => {
    await writeTimemachineSettings(profileDir, { autoSave: false, debounceMs: 20 })
    const next = await writeTimemachineSettings(profileDir, { shortcuts: { redo: 'Ctrl+Y' } })
    expect(next).toEqual({
      autoSave: false,
      debounceMs: 20,
      retention: 50,
      shortcuts: { undo: 'Ctrl+Alt+Z', redo: 'Ctrl+Y' },
    })
    expect(JSON.parse(readFileSync(join(resolveGenerationsDir(profileDir), 'settings.json'), 'utf8'))).toEqual(next)
  })

  it('recovers a mergeable base from a damaged file', async () => {
    mkdirSync(resolveGenerationsDir(profileDir), { recursive: true })
    writeFileSync(join(resolveGenerationsDir(profileDir), 'settings.json'), '{ nope')
    expect(await writeTimemachineSettings(profileDir, { retention: 5 }))
      .toEqual({ ...DEFAULT_TIMEMACHINE_SETTINGS, retention: 5 })
  })
})
