/**
 * History export/import: the archive carries records plus the redo stack,
 * importing never overwrites, and unreadable entries skip instead of landing.
 * @module dsh-timemachine/tests/archive
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ARCHIVE_FORMAT_VERSION,
  exportGenerations,
  importGenerations,
} from '../src/archive.ts'
import {
  generationId,
  readGenerations,
  recordGeneration,
  resolveGenerationsDir,
  writeUndoState,
  type GenerationInputs,
} from '../src/generations.ts'

let profileDir: string
let targetDir: string

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'dsh-timemachine-archive-'))
  targetDir = mkdtempSync(join(tmpdir(), 'dsh-timemachine-archive-target-'))
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
  rmSync(targetDir, { recursive: true, force: true })
})

const inputs = (patch: string): GenerationInputs => ({ manifest: '{}\n', profilePatch: patch, homePatch: null })

const record = (patch: string) => recordGeneration({
  profileDir,
  profile: 'headless',
  inputs: inputs(patch),
  bundles: [],
  render: `- id: ${patch}\n`,
  now: '2026-08-14T00:00:00.000Z',
})

describe('exporting', () => {
  it('packs every record plus a manifest naming the format', async () => {
    const first = await record('- id: a\n')
    const second = await record('- id: b\n')
    const entries = unzipSync(exportGenerations(profileDir))
    expect(Object.keys(entries).sort()).toEqual([
      'manifest.json', `${first.id}.json`, `${second.id}.json`,
    ].sort())
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']!)) as Record<string, unknown>
    expect(manifest.format).toBe(ARCHIVE_FORMAT_VERSION)
    expect(manifest.generations).toBe(2)
    const packed = JSON.parse(new TextDecoder().decode(entries[`${first.id}.json`]!)) as { id: string }
    expect(packed.id).toBe(first.id)
  })

  it('packs the redo stack only when there is one', async () => {
    await record('- id: a\n')
    expect(Object.keys(unzipSync(exportGenerations(profileDir)))).not.toContain('undo-state.json')
    await writeUndoState(profileDir, { redo: ['aaaa00000000'] })
    expect(Object.keys(unzipSync(exportGenerations(profileDir)))).toContain('undo-state.json')
  })
})

describe('importing', () => {
  it('round-trips into an empty history', async () => {
    const first = await record('- id: a\n')
    await writeUndoState(profileDir, { redo: [first.id] })
    const archive = exportGenerations(profileDir)
    const result = await importGenerations(targetDir, archive)
    expect(result).toEqual({ imported: [first.id], skipped: [] })
    expect(readGenerations(targetDir).generations.map(generation => generation.id)).toEqual([first.id])
    // The redo stack landed beside it.
    expect(readFileSync(join(resolveGenerationsDir(targetDir), 'undo-state.json'), 'utf8')).toContain(first.id)
  })

  it('skips records that already exist instead of overwriting them', async () => {
    const first = await record('- id: a\n')
    const archive = exportGenerations(profileDir)
    // The target holds a hand-edited same-id record; importing must keep it.
    await recordGeneration({
      profileDir: targetDir,
      profile: 'headless',
      inputs: inputs('- id: a\n'),
      bundles: [],
      render: 'hand-edited\n',
      now: '2026-08-01T00:00:00.000Z',
    })
    const result = await importGenerations(targetDir, archive)
    expect(result).toEqual({ imported: [], skipped: [first.id] })
    const kept = readGenerations(targetDir).generations[0]!
    expect(kept.composed.render).toBe('hand-edited\n')
  })

  it('never imports a redo stack over an existing one', async () => {
    await record('- id: a\n')
    await writeUndoState(profileDir, { redo: ['aaaa00000000'] })
    const archive = exportGenerations(profileDir)
    await writeUndoState(targetDir, { redo: ['bbbb00000000'] })
    await importGenerations(targetDir, archive)
    expect(readFileSync(join(resolveGenerationsDir(targetDir), 'undo-state.json'), 'utf8')).toContain('bbbb00000000')
  })

  it('skips an entry that is not a record of the current format', async () => {
    await record('- id: a\n')
    const archive = exportGenerations(profileDir)
    // Corrupt one entry in a copy of the archive.
    const entries = unzipSync(archive)
    const id = generationId(inputs('- id: a\n'), null)
    entries[`${id}.json`] = new TextEncoder().encode('{ nope')
    const result = await importGenerations(targetDir, zipSync(entries))
    expect(result).toEqual({ imported: [], skipped: [id] })
    expect(readGenerations(targetDir).unreadable).toEqual([])
  })
})
