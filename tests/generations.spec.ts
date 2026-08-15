/**
 * Behavior of the configuration-generation store: how a configuration is
 * addressed, when a boot adds a record versus an outcome, what retention keeps,
 * and when a restore is refused.
 * @module dsh-timemachine/tests/timemachine
 */

import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendOutcome,
  compareForRestore,
  digestText,
  GENERATION_FORMAT_VERSION,
  GENERATION_RETENTION,
  generationId,
  generationOrigin,
  lastActivated,
  latestStatus,
  readGenerations,
  readUndoState,
  recordGeneration,
  resolveGenerationsDir,
  writeUndoState,
  type BundleStamp,
  type GenerationEnvironment,
  type GenerationInputs,
  type GenerationOutcome,
} from '../src/generations.ts'

let profileDir: string

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'dsh-timemachine-'))
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

const inputs = (overrides: Partial<GenerationInputs> = {}): GenerationInputs => ({
  manifest: '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n',
  profilePatch: '[]\n',
  homePatch: null,
  ...overrides,
})

const bundles: BundleStamp[] = [{ name: '@deepseek-ai/dsh-base', version: '0.1.0-rc.5' }]

const environment = (overrides: Partial<GenerationEnvironment> = {}): GenerationEnvironment => ({
  settings: { path: '/home/u/.dsh/settings.yaml', text: 'llm-deepseek:\n  model: deepseek-chat\n' },
  presets: [{ id: 'writer', path: '/home/u/.dsh/presets/writer/agent.cordis.yml', text: '- id: tools\n' }],
  ...overrides,
})

const record = (overrides: Partial<Parameters<typeof recordGeneration>[0]> = {}) => recordGeneration({
  profileDir,
  profile: 'headless',
  inputs: inputs(),
  bundles,
  render: '- id: llm\n  name: dsh-llm\n',
  now: '2026-08-14T00:00:00.000Z',
  ...overrides,
})

const outcome = (overrides: Partial<GenerationOutcome> = {}): GenerationOutcome => ({
  at: '2026-08-14T00:00:01.000Z',
  status: 'activated',
  overlays: [],
  ...overrides,
})

describe('addressing a configuration', () => {
  it('gives the same id to the same inputs and a different one to changed inputs', async () => {
    expect(generationId(inputs(), null)).toBe(generationId(inputs(), null))
    expect(generationId(inputs({ profilePatch: '- id: llm\n' }), null)).not.toBe(generationId(inputs(), null))
  })

  it('distinguishes an absent patch file from an empty one', async () => {
    expect(generationId(inputs({ profilePatch: null }), null)).not.toBe(generationId(inputs({ profilePatch: '' }), null))
  })

  it('does not let input texts run together into one digest', async () => {
    // Without framing, moving a character across the boundary would collide.
    expect(generationId({ manifest: 'ab', profilePatch: 'c', homePatch: null }, null))
      .not.toBe(generationId({ manifest: 'a', profilePatch: 'bc', homePatch: null }, null))
  })

  it('separates the launcher vantage from a running tree that saw the same files', async () => {
    // Otherwise the observer's fuller record would overwrite the launcher's, and
    // a failed boot would lose the only record written before the tree existed.
    expect(generationId(inputs(), environment())).not.toBe(generationId(inputs(), null))
  })

  it('changes when the settings document or a preset changes', async () => {
    const base = generationId(inputs(), environment())
    expect(generationId(inputs(), environment({
      settings: { path: '/home/u/.dsh/settings.yaml', text: 'llm-deepseek:\n  model: other\n' },
    }))).not.toBe(base)
    expect(generationId(inputs(), environment({
      presets: [{ id: 'writer', path: '/home/u/.dsh/presets/writer/agent.cordis.yml', text: '- id: other\n' }],
    }))).not.toBe(base)
  })

  it('ignores the order presets were discovered in', async () => {
    const first = { id: 'a', path: '/p/a/agent.cordis.yml', text: '- id: a\n' }
    const second = { id: 'b', path: '/p/b/agent.cordis.yml', text: '- id: b\n' }
    expect(generationId(inputs(), environment({ presets: [first, second] })))
      .toBe(generationId(inputs(), environment({ presets: [second, first] })))
  })
})

describe('recording a boot', () => {
  it('stores the composition under the generation id and digests the render', async () => {
    const generation = await record()
    expect(generation.id).toBe(generationId(inputs(), null))
    expect(generation.composed.digest).toBe(digestText(generation.composed.render))
    expect(readdirSync(resolveGenerationsDir(profileDir))).toEqual([`${generation.id}.json`])
  })

  it('reads back exactly what it wrote', async () => {
    const written = await record()
    const { generations, unreadable } = readGenerations(profileDir)
    expect(unreadable).toEqual([])
    expect(generations).toEqual([written])
  })

  it('adopts the existing record when the same configuration boots again', async () => {
    const first = await record()
    await appendOutcome(profileDir, first.id, outcome())
    const second = await record({ now: '2026-08-15T00:00:00.000Z' })
    expect(second.id).toBe(first.id)
    expect(second.recordedAt).toBe(first.recordedAt)
    expect(second.lastSeenAt).toBe('2026-08-15T00:00:00.000Z')
    // Re-observing a configuration must not discard what its boots did.
    expect(second.outcomes).toEqual([outcome()])
    expect(readGenerations(profileDir).generations).toHaveLength(1)
  })

  it('adds a record when the inputs change', async () => {
    await record()
    await record({ inputs: inputs({ homePatch: '- id: llm\n' }), now: '2026-08-15T00:00:00.000Z' })
    expect(readGenerations(profileDir).generations).toHaveLength(2)
  })

  it('orders generations by when they were last composed', async () => {
    const older = await record()
    const newer = await record({ inputs: inputs({ profilePatch: null }), now: '2026-08-16T00:00:00.000Z' })
    expect(readGenerations(profileDir).generations.map(generation => generation.id)).toEqual([older.id, newer.id])
    await record({ now: '2026-08-17T00:00:00.000Z' })
    expect(readGenerations(profileDir).generations.map(generation => generation.id)).toEqual([newer.id, older.id])
  })

  it('orders two configurations composed at the same instant by id', async () => {
    // Concurrent launches of different configurations can share a timestamp;
    // the order still has to be the same on every read.
    const ids = [
      (await record({ inputs: inputs({ profilePatch: '- id: a\n' }) })).id,
      (await record({ inputs: inputs({ profilePatch: '- id: b\n' }) })).id,
    ].sort((left, right) => left.localeCompare(right))
    expect(readGenerations(profileDir).generations.map(generation => generation.id)).toEqual(ids)
  })
})

describe('settling a boot attempt', () => {
  it('appends outcomes in order', async () => {
    const generation = await record()
    expect(await appendOutcome(profileDir, generation.id, outcome({ status: 'failed', error: 'boom' }))).toBe(true)
    expect(await appendOutcome(profileDir, generation.id, outcome({ at: '2026-08-14T00:00:02.000Z' }))).toBe(true)
    const stored = readGenerations(profileDir).generations[0]
    expect(stored?.outcomes.map(entry => entry.status)).toEqual(['failed', 'activated'])
    expect(latestStatus(stored!)).toBe('activated')
  })

  it('reports an unknown generation instead of inventing one', async () => {
    expect(await appendOutcome(profileDir, 'deadbeefcafe', outcome())).toBe(false)
    expect(readGenerations(profileDir).generations).toEqual([])
  })

  it('finds the newest activated generation and ignores failed ones', async () => {
    const good = await record()
    await appendOutcome(profileDir, good.id, outcome())
    const bad = await record({ inputs: inputs({ profilePatch: '- id: nope\n' }), now: '2026-08-15T00:00:00.000Z' })
    await appendOutcome(profileDir, bad.id, outcome({ status: 'failed', error: 'boom' }))
    const { generations } = readGenerations(profileDir)
    expect(lastActivated(generations)?.id).toBe(good.id)
    expect(latestStatus(generations.at(-1)!)).toBe('failed')
  })

  it('has no activated generation before any boot settles', async () => {
    await record()
    expect(lastActivated(readGenerations(profileDir).generations)).toBeUndefined()
    expect(latestStatus(readGenerations(profileDir).generations[0]!)).toBeUndefined()
  })
})

describe('reading a damaged history', () => {
  it('reads an empty history for a profile that never booted', async () => {
    expect(readGenerations(profileDir)).toEqual({ generations: [], unreadable: [] })
  })

  it('reports a corrupt record without losing the readable ones', async () => {
    const good = await record()
    const dir = resolveGenerationsDir(profileDir)
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    const { generations, unreadable } = readGenerations(profileDir)
    expect(generations.map(generation => generation.id)).toEqual([good.id])
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]?.path).toBe(join(dir, 'broken.json'))
  })

  it('rejects a record from another format version', async () => {
    await record()
    const dir = resolveGenerationsDir(profileDir)
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ formatVersion: GENERATION_FORMAT_VERSION + 1 }))
    const { unreadable } = readGenerations(profileDir)
    expect(unreadable[0]?.reason).toContain(`is not ${GENERATION_FORMAT_VERSION}`)
  })

  it.each([
    ['[]', 'not a JSON object'],
    [JSON.stringify({ formatVersion: GENERATION_FORMAT_VERSION }), '`id` must be a string'],
    [JSON.stringify({
      formatVersion: GENERATION_FORMAT_VERSION, id: 'a', recordedAt: 'b', lastSeenAt: 'c', profile: 'd',
      scope: 'composition', environment: null,
    }), '`inputs` must be a JSON object'],
    [JSON.stringify({
      formatVersion: GENERATION_FORMAT_VERSION, id: 'a', recordedAt: 'b', lastSeenAt: 'c', profile: 'd',
      scope: 'composition', environment: null,
      inputs: {},
    }), '`inputs.manifest` must be a string'],
    [JSON.stringify({
      formatVersion: GENERATION_FORMAT_VERSION, id: 'a', recordedAt: 'b', lastSeenAt: 'c', profile: 'd',
      scope: 'composition', environment: null,
      inputs: { manifest: 'm', profilePatch: 1, homePatch: null },
    }), '`inputs.profilePatch` must be a string or null'],
    [JSON.stringify({
      formatVersion: GENERATION_FORMAT_VERSION, id: 'a', recordedAt: 'b', lastSeenAt: 'c', profile: 'd',
      scope: 'composition', environment: null,
      inputs: { manifest: 'm', profilePatch: null, homePatch: null },
    }), '`composed` must carry a digest and a render'],
    [JSON.stringify({
      formatVersion: GENERATION_FORMAT_VERSION, id: 'a', recordedAt: 'b', lastSeenAt: 'c', profile: 'd',
      scope: 'composition', environment: null,
      inputs: { manifest: 'm', profilePatch: null, homePatch: null },
      composed: { digest: 'x' },
    }), '`composed` must carry a digest and a render'],
    [JSON.stringify({
      formatVersion: GENERATION_FORMAT_VERSION, id: 'a', recordedAt: 'b', lastSeenAt: 'c', profile: 'd',
      scope: 'composition', environment: null,
      inputs: { manifest: 'm', profilePatch: null, homePatch: null },
      composed: { digest: 'x', render: 'y' },
    }), '`bundles` and `outcomes` must be arrays'],
  ])('names the field a hand-edited record got wrong (%#)', (text, reason) => {
    mkdirSync(resolveGenerationsDir(profileDir), { recursive: true })
    writeFileSync(join(resolveGenerationsDir(profileDir), 'hand-edited.json'), text)
    expect(readGenerations(profileDir).unreadable[0]?.reason).toBe(reason)
  })

  it('ignores files that are not records', async () => {
    const good = await record()
    writeFileSync(join(resolveGenerationsDir(profileDir), 'notes.txt'), 'ignored')
    const { generations, unreadable } = readGenerations(profileDir)
    expect(generations.map(generation => generation.id)).toEqual([good.id])
    expect(unreadable).toEqual([])
  })
})

describe('retention', () => {
  /** Record `count` distinct configurations, oldest first. */
  const fill = async (count: number): Promise<string[]> => {
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      ids.push((await record({
        inputs: inputs({ profilePatch: `- id: row-${index}\n` }),
        now: `2026-08-14T00:${String(index).padStart(2, '0')}:00.000Z`,
      })).id)
    }
    return ids
  }

  it('keeps the newest generations up to the retention bound', async () => {
    const ids = await fill(GENERATION_RETENTION + 5)
    const kept = readGenerations(profileDir).generations.map(generation => generation.id)
    expect(kept).toHaveLength(GENERATION_RETENTION)
    expect(kept).toEqual(ids.slice(5))
  })

  it('keeps the last known-good configuration however old it is', async () => {
    const oldest = await record({ inputs: inputs({ profilePatch: '- id: good\n' }), now: '2026-08-01T00:00:00.000Z' })
    await appendOutcome(profileDir, oldest.id, outcome())
    await fill(GENERATION_RETENTION + 5)
    const kept = readGenerations(profileDir).generations
    expect(kept.map(generation => generation.id)).toContain(oldest.id)
    expect(lastActivated(kept)?.id).toBe(oldest.id)
  })
})

describe('origins', () => {
  it('stamps a new record with the given origin and reason', async () => {
    const manual = await record({ origin: 'manual', reason: 'before the experiment' })
    expect(manual.origin).toBe('manual')
    expect(manual.reason).toBe('before the experiment')
    expect(readGenerations(profileDir).generations[0]).toEqual(manual)
  })

  it('defaults a new record to the boot origin', async () => {
    expect((await record()).origin).toBe('boot')
  })

  it('reads a pre-origin record as a boot observation', async () => {
    const written = await record()
    const dir = resolveGenerationsDir(profileDir)
    const { origin: _origin, ...preOrigin } = written
    writeFileSync(join(dir, `${written.id}.json`), JSON.stringify(preOrigin))
    const [read] = readGenerations(profileDir).generations
    expect(read!.origin).toBeUndefined()
    expect(generationOrigin(read!)).toBe('boot')
  })

  it('rejects a hand-edited record with an unknown origin', async () => {
    const written = await record()
    writeFileSync(
      join(resolveGenerationsDir(profileDir), `${written.id}.json`),
      JSON.stringify({ ...written, origin: 'conjured' }),
    )
    expect(readGenerations(profileDir).unreadable[0]?.reason).toContain('`origin`')
  })

  it('keeps the creating origin when the configuration is re-observed', async () => {
    const manual = await record({ origin: 'manual' })
    // A later boot of the same inputs adopts the record; it must not demote
    // the snapshot to an auto-cleanable boot observation.
    const adopted = await record({ now: '2026-08-15T00:00:00.000Z' })
    expect(adopted.id).toBe(manual.id)
    expect(generationOrigin(adopted)).toBe('manual')
  })
})

describe('the redo stack and recording', () => {
  it('clears the redo stack when a genuinely new configuration is recorded', async () => {
    await record()
    await writeUndoState(profileDir, { redo: ['aaaa00000000'] })
    await record({ inputs: inputs({ profilePatch: '- id: changed\n' }), now: '2026-08-15T00:00:00.000Z' })
    expect(readUndoState(profileDir)).toEqual({ redo: [] })
  })

  it('keeps the redo stack when the new record is a regret (the undo way-back)', async () => {
    await record()
    await writeUndoState(profileDir, { redo: ['aaaa00000000'] })
    await record({
      inputs: inputs({ profilePatch: '- id: changed\n' }),
      now: '2026-08-15T00:00:00.000Z',
      origin: 'regret',
    })
    expect(readUndoState(profileDir)).toEqual({ redo: ['aaaa00000000'] })
  })

  it('keeps the redo stack when an existing configuration is merely adopted', async () => {
    await record()
    await writeUndoState(profileDir, { redo: ['aaaa00000000'] })
    await record({ now: '2026-08-15T00:00:00.000Z' })
    expect(readUndoState(profileDir)).toEqual({ redo: ['aaaa00000000'] })
  })
})

describe('retention layering', () => {
  /** Record `count` distinct configurations, oldest first. */
  const fill = async (count: number): Promise<string[]> => {
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      ids.push((await record({
        inputs: inputs({ profilePatch: `- id: row-${index}\n` }),
        now: `2026-08-14T00:${String(index).padStart(2, '0')}:00.000Z`,
      })).id)
    }
    return ids
  }

  it('keeps manual and regret records however far past the bound they are', async () => {
    const manual = await record({ origin: 'manual', now: '2026-08-01T00:00:00.000Z' })
    const regret = await record({
      inputs: inputs({ profilePatch: '- id: regret\n' }),
      origin: 'regret',
      now: '2026-08-01T01:00:00.000Z',
    })
    await fill(GENERATION_RETENTION + 5)
    const kept = readGenerations(profileDir).generations.map(generation => generation.id)
    expect(kept).toContain(manual.id)
    expect(kept).toContain(regret.id)
    // Only the boot records count against the bound: 50 of them remain.
    expect(kept).toHaveLength(GENERATION_RETENTION + 2)
  })

  it('honors a caller-supplied retention over the default', async () => {
    for (let index = 0; index < 5; index++) {
      await record({
        inputs: inputs({ profilePatch: `- id: row-${index}\n` }),
        now: `2026-08-14T00:${String(index).padStart(2, '0')}:00.000Z`,
        retention: 3,
      })
    }
    expect(readGenerations(profileDir).generations).toHaveLength(3)
  })
})

describe('checking a restore', () => {
  const current = { digest: digestText('- id: llm\n  name: dsh-llm\n'), bundles }

  it('accepts a generation the current installation still reproduces', async () => {
    expect(compareForRestore(await record(), current)).toEqual({ reproducible: true, drift: [], digestChanged: false })
  })

  it('refuses and names a bundle whose version moved', async () => {
    const verdict = compareForRestore(await record(), {
      ...current,
      bundles: [{ name: '@deepseek-ai/dsh-base', version: '0.2.0' }],
    })
    expect(verdict.reproducible).toBe(false)
    expect(verdict.drift).toEqual([
      { name: '@deepseek-ai/dsh-base', recorded: '0.1.0-rc.5', current: '0.2.0' },
    ])
  })

  it('names a bundle that disappeared and one that appeared', async () => {
    const verdict = compareForRestore(await record(), {
      ...current,
      bundles: [{ name: '@deepseek-ai/dsh-web-app', version: '0.1.0-rc.5' }],
    })
    expect(verdict.drift).toEqual([
      { name: '@deepseek-ai/dsh-base', recorded: '0.1.0-rc.5' },
      { name: '@deepseek-ai/dsh-web-app', current: '0.1.0-rc.5' },
    ])
  })

  it('refuses when the same bundles compose a different tree', async () => {
    const verdict = compareForRestore(await record(), { ...current, digest: digestText('- id: other\n') })
    expect(verdict).toEqual({ reproducible: false, drift: [], digestChanged: true })
  })
})
