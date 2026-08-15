/**
 * Undo/redo planning: which generation a step back targets, how the redo
 * stack pops, and how dangling stack entries stop masking the ones beneath.
 * @module dsh-timemachine/tests/undo
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationId, readUndoState, writeUndoState, type ConfigGeneration } from '../src/generations.ts'
import { planRedo, planUndo } from '../src/undo.ts'

let profileDir: string

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'dsh-timemachine-undo-'))
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

/** A bare-bones generation; the planners read only inputs and lastSeenAt. */
function generation(id: string, lastSeenAt: string, patch: string | null = null): ConfigGeneration {
  return {
    formatVersion: 2,
    id,
    scope: 'composition',
    recordedAt: lastSeenAt,
    lastSeenAt,
    profile: 'headless',
    inputs: { manifest: '{}', profilePatch: patch, homePatch: null },
    environment: null,
    bundles: [],
    composed: { digest: 'x', render: '[]\n' },
    outcomes: [],
  }
}

/** The composition-scope digest of one patch text, as the service computes it. */
const digestOf = (patch: string | null): string => generationId({ manifest: '{}', profilePatch: patch, homePatch: null }, null)

describe('planning an undo', () => {
  it('targets the most recently seen configuration whose inputs differ from the current ones', () => {
    const older = generation('aaaa00000000', '2026-08-14T00:00:00.000Z', '- id: old\n')
    const newer = generation('bbbb00000000', '2026-08-15T00:00:00.000Z', '- id: new\n')
    expect(planUndo([older, newer], digestOf('- id: current\n'))?.id).toBe('bbbb00000000')
    expect(planUndo([older, newer], digestOf('- id: new\n'))?.id).toBe('aaaa00000000')
  })

  it('treats a full-scope twin of the current inputs as the same configuration', () => {
    // A running tree's record of the inputs now on disk carries a different id
    // (the environment slots join the digest) but is not an undo target.
    const twin = generation('bbbb00000000', '2026-08-15T00:00:00.000Z', '- id: current\n')
    const older = generation('aaaa00000000', '2026-08-14T00:00:00.000Z', '- id: old\n')
    expect(planUndo([older, twin], digestOf('- id: current\n'))?.id).toBe('aaaa00000000')
    expect(planUndo([twin], digestOf('- id: current\n'))).toBeUndefined()
  })

  it('finds nothing when the current configuration is the only one', () => {
    const only = generation('aaaa00000000', '2026-08-14T00:00:00.000Z', '- id: x\n')
    expect(planUndo([only], digestOf('- id: x\n'))).toBeUndefined()
    expect(planUndo([], digestOf('- id: x\n'))).toBeUndefined()
  })
})

describe('planning a redo', () => {
  it('pops the newest stack entry that still names a generation', () => {
    const target = generation('bbbb00000000', '2026-08-15T00:00:00.000Z')
    const plan = planRedo(['aaaa00000000', 'bbbb00000000'], [target])
    expect(plan?.generation.id).toBe('bbbb00000000')
    // The dangling entry above... none here: the consumed target was the top.
    expect(plan?.remaining).toEqual(['aaaa00000000'])
  })

  it('drops dangling ids above the restorable one instead of being masked by them', () => {
    const target = generation('aaaa00000000', '2026-08-14T00:00:00.000Z')
    const plan = planRedo(['aaaa00000000', 'deadbeef0000'], [target])
    expect(plan?.generation.id).toBe('aaaa00000000')
    expect(plan?.remaining).toEqual([])
  })

  it('finds nothing in an empty or fully dangling stack', () => {
    expect(planRedo([], [generation('aaaa00000000', '2026-08-14T00:00:00.000Z')])).toBeUndefined()
    expect(planRedo(['deadbeef0000'], [])).toBeUndefined()
  })
})

describe('the redo stack file', () => {
  it('reads an empty stack when no file exists or it is damaged', async () => {
    expect(readUndoState(profileDir)).toEqual({ redo: [] })
    await writeUndoState(profileDir, { redo: ['aaaa00000000'] })
    expect(readUndoState(profileDir)).toEqual({ redo: ['aaaa00000000'] })
  })

  it('rejects a file whose redo is not a string list', async () => {
    await writeUndoState(profileDir, { redo: ['aaaa00000000'] })
    writeFileSync(join(profileDir, 'timemachine', 'undo-state.json'), JSON.stringify({ redo: [3] }))
    expect(readUndoState(profileDir)).toEqual({ redo: [] })
  })
})
