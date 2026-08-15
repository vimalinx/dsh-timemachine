/**
 * `ctx.timemachine` over derived or explicit host facts: what it serves
 * without a profile, what it records with one, and the guarantee that a
 * refused restore leaves the profile untouched.
 * @module dsh-timemachine/tests/service
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TimeMachine from '../src/service.ts'
import {
  digestText,
  readUndoState,
  recordGeneration,
  type BundleStamp,
  type ConfigGenerationHost,
  type GenerationEnvironment,
  type GenerationInputs,
} from '../src/generations.ts'

let profileDir: string

const MANIFEST = '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n'
const PATCH = '[]\n'
const RENDER = '- id: llm\n  name: dsh-llm\n'

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'dsh-config-service-'))
  writeFileSync(join(profileDir, 'package.json'), MANIFEST)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH)
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

const environment = (overrides: Partial<GenerationEnvironment> = {}): GenerationEnvironment => ({
  settings: { path: join(profileDir, 'settings.yaml'), text: 'llm-deepseek:\n  model: deepseek-chat\n' },
  presets: [],
  ...overrides,
})

/**
 * A handoff that reads the profile directory the way the launcher's closures do,
 * so a restore's verification sees whatever the restore just wrote.
 */
function host(overrides: Partial<ConfigGenerationHost> = {}): ConfigGenerationHost {
  const bundles: BundleStamp[] = [{ name: '@deepseek-ai/dsh-base', version: '0.1.0-rc.5' }]
  const readInputs = (): GenerationInputs => ({
    manifest: readFileSync(join(profileDir, 'package.json'), 'utf8'),
    // `existsSync` first, like the launcher's own reader: a restore may have
    // removed the layer the recorded configuration did not have.
    profilePatch: existsSync(join(profileDir, 'cordis.patch.yml'))
      ? readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
      : null,
    homePatch: null,
  })
  return {
    profile: 'headless',
    profileDir,
    bootedId: undefined,
    readInputs,
    // The stand-in for composition: the render tracks the patch layer, so a
    // restore that puts the recorded patch back reproduces the recorded digest.
    render: () => `${RENDER}# patch ${readInputs().profilePatch ?? 'absent'}\n`,
    readBundles: () => bundles,
    ...overrides,
  }
}

/** Mount the service, with explicit host facts or none (a profile-less tree). */
function serve(handoff?: ConfigGenerationHost): TimeMachine {
  return handoff === undefined
    ? new TimeMachine(new Context())
    : new TimeMachine(new Context(), handoff)
}

describe('without a booted profile', () => {
  it('serves an empty history rather than guessing a profile directory', () => {
    const service = serve()
    expect(service.available).toBe(false)
    expect(service.profile).toBeUndefined()
    expect(service.bootedId).toBeUndefined()
    expect(service.list()).toEqual({ generations: [], unreadable: [] })
    expect(service.lastGood()).toBeUndefined()
  })

  it('refuses to record or restore', async () => {
    const service = serve()
    expect(await service.record(environment(), '2026-08-14T00:00:00.000Z')).toBeUndefined()
    expect(await service.recordBoot('2026-08-14T00:00:00.000Z')).toBeUndefined()
    const result = await service.restore('anything')
    expect(result.restored).toBe(false)
    expect(result.refusal).toContain('no profile was handed to this composition')
  })
})

describe('recording from inside the tree', () => {
  it('records the environment the launcher could not see, as a full-scope generation', async () => {
    const service = serve(host())
    const generation = await service.record(environment(), '2026-08-14T00:00:00.000Z')
    expect(generation?.scope).toBe('full')
    expect(generation?.environment?.settings?.text).toContain('deepseek-chat')
    expect(service.profile).toBe('headless')
  })

  it('leaves the launcher composition-scope record beside it', async () => {
    const handoff = host()
    await recordGeneration({
      profileDir,
      profile: 'headless',
      inputs: handoff.readInputs(),
      bundles: handoff.readBundles(),
      render: handoff.render(),
      now: '2026-08-14T00:00:00.000Z',
    })
    const service = serve(handoff)
    await service.record(environment(), '2026-08-14T00:00:01.000Z')
    const scopes = service.list().generations.map(generation => generation.scope)
    expect(scopes).toEqual(['composition', 'full'])
  })

  it('adopts its own record when nothing changed', async () => {
    const service = serve(host())
    const first = await service.record(environment(), '2026-08-14T00:00:00.000Z')
    const second = await service.record(environment(), '2026-08-14T01:00:00.000Z')
    expect(second?.id).toBe(first?.id)
    expect(service.list().generations).toHaveLength(1)
  })

  it('adds a record when a setting changed under the same composition', async () => {
    const service = serve(host())
    await service.record(environment(), '2026-08-14T00:00:00.000Z')
    await service.record(environment({
      settings: { path: join(profileDir, 'settings.yaml'), text: 'llm-deepseek:\n  model: other\n' },
    }), '2026-08-14T01:00:00.000Z')
    expect(service.list().generations).toHaveLength(2)
  })
})

describe('reading one generation', () => {
  it('resolves an unambiguous prefix and names the profile with no records', async () => {
    const service = serve(host())
    const generation = await service.record(environment(), '2026-08-14T00:00:00.000Z')
    expect(service.read(generation!.id.slice(0, 6)).id).toBe(generation?.id)
    expect(() => service.read('ffffffffffff')).toThrow('no recorded configuration')
  })

  it('reports the last known-good configuration', async () => {
    const service = serve(host())
    const generation = await service.record(environment(), '2026-08-14T00:00:00.000Z')
    expect(service.lastGood()).toBeUndefined()
    writeFileSync(
      join(profileDir, 'timemachine', `${generation!.id}.json`),
      JSON.stringify({
        ...generation,
        outcomes: [{ at: '2026-08-14T00:00:01.000Z', status: 'activated', overlays: [] }],
      }, undefined, 2),
    )
    expect(service.lastGood()?.id).toBe(generation?.id)
  })
})

describe('restoring from inside the tree', () => {
  it('writes the composition inputs and recorded preset files back', async () => {
    const presetPath = join(profileDir, 'presets', 'writer', 'agent.cordis.yml')
    mkdirSync(join(profileDir, 'presets', 'writer'), { recursive: true })
    writeFileSync(presetPath, '- id: original\n')
    const service = serve(host())
    const good = await service.record(environment({
      presets: [{ id: 'writer', path: presetPath, text: '- id: original\n' }],
    }), '2026-08-14T00:00:00.000Z')

    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: drifted\n  disabled: true\n')
    writeFileSync(presetPath, '- id: edited\n')

    const result = await service.restore(good!.id)
    expect(result.restored).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(PATCH)
    expect(readFileSync(presetPath, 'utf8')).toBe('- id: original\n')
    expect(result.changes.some(change => change.includes('cordis.patch.yml'))).toBe(true)
  })

  it('refuses and leaves the profile untouched when the composition no longer reproduces', async () => {
    const service = serve(host())
    const generation = await service.record(environment(), '2026-08-14T00:00:00.000Z')
    // A stored digest the current installation cannot produce stands in for a
    // bundle that moved under the same manifest.
    writeFileSync(
      join(profileDir, 'timemachine', `${generation!.id}.json`),
      JSON.stringify({ ...generation, composed: { ...generation!.composed, digest: '0'.repeat(64) } }, undefined, 2),
    )
    const edited = '- id: my-own-edit\n  disabled: true\n'
    writeFileSync(join(profileDir, 'cordis.patch.yml'), edited)

    const result = await service.restore(generation!.id)
    expect(result.restored).toBe(false)
    expect(result.refusal).toContain('can no longer be reproduced')
    expect(result.verdict?.digestChanged).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(edited)
  })

  it('names every bundle whose version moved', async () => {
    const service = serve(host())
    const generation = await service.record(environment(), '2026-08-14T00:00:00.000Z')
    writeFileSync(
      join(profileDir, 'timemachine', `${generation!.id}.json`),
      JSON.stringify({
        ...generation,
        bundles: [{ name: '@deepseek-ai/dsh-base', version: '0.0.1-recorded' }],
      }, undefined, 2),
    )
    const result = await service.restore(generation!.id)
    expect(result.restored).toBe(false)
    expect(result.refusal).toContain('recorded 0.0.1-recorded, installed 0.1.0-rc.5')
  })

  it('refuses and rolls back when composing the recorded configuration throws', async () => {
    const service = serve(host({
      render: () => { throw new Error('cannot resolve profile bundle "@deepseek-ai/dsh-gone"') },
    }))
    // Recorded through the store directly: the handoff's render now throws, which
    // is the state a bundle uninstalled since the recording leaves behind.
    const generation = await recordGeneration({
      profileDir,
      profile: 'headless',
      inputs: { manifest: MANIFEST, profilePatch: PATCH, homePatch: null },
      environment: environment(),
      bundles: [{ name: '@deepseek-ai/dsh-base', version: '0.1.0-rc.5' }],
      render: RENDER,
      now: '2026-08-14T00:00:00.000Z',
    })
    const edited = '- id: my-own-edit\n  disabled: true\n'
    writeFileSync(join(profileDir, 'cordis.patch.yml'), edited)

    const result = await service.restore(generation.id)
    expect(result.restored).toBe(false)
    expect(result.refusal).toContain('no longer composes')
    expect(result.verdict).toBeUndefined()
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(edited)
  })

  it('removes a patch file the recorded configuration did not have', async () => {
    const handoff = host()
    const service = serve(handoff)
    const generation = await recordGeneration({
      profileDir,
      profile: 'headless',
      inputs: { manifest: MANIFEST, profilePatch: null, homePatch: null },
      environment: environment(),
      bundles: handoff.readBundles(),
      // The render a profile with no patch layer produces, which is what the
      // handoff will recompose once the file is gone.
      render: `${RENDER}# patch absent\n`,
      now: '2026-08-14T00:00:00.000Z',
    })
    const result = await service.restore(generation.id)
    expect(result.restored).toBe(true)
    expect(result.changes.some(change => change.startsWith('removed'))).toBe(true)
    expect(digestText(handoff.render())).toBe(generation.composed.digest)
  })
})

describe('manual snapshots', () => {
  it('stamps the snapshot with the manual origin and its reason', async () => {
    const service = serve(host())
    const generation = await service.snapshot('before the experiment', '2026-08-14T00:00:00.000Z')
    expect(generation?.origin).toBe('manual')
    expect(generation?.reason).toBe('before the experiment')
    expect(generation?.scope).toBe('composition')
  })

  it('adopts the existing record when nothing changed, keeping its origin', async () => {
    const service = serve(host())
    const first = await service.snapshot(undefined, '2026-08-14T00:00:00.000Z')
    const second = await service.snapshot('same again', '2026-08-14T01:00:00.000Z')
    expect(second?.id).toBe(first?.id)
    // The first snapshot had no reason; adoption does not invent one either.
    expect(service.list().generations).toHaveLength(1)
  })

  it('records nothing without a profile', async () => {
    expect(await serve().snapshot('x', '2026-08-14T00:00:00.000Z')).toBeUndefined()
  })
})

describe('undo and redo', () => {
  /** Record the patch states `a` then `b`, leaving `b` on disk. */
  const recordTwo = async (service: TimeMachine) => {
    const a = await service.snapshot(undefined, '2026-08-14T00:00:00.000Z')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: changed\n')
    const b = await service.snapshot(undefined, '2026-08-14T01:00:00.000Z')
    return { a: a!, b: b! }
  }

  it('steps back to the previous configuration and records the regret', async () => {
    const service = serve(host())
    const { a, b } = await recordTwo(service)
    const step = await service.undo('2026-08-14T02:00:00.000Z')
    expect(step.changed).toBe(true)
    expect(step.result?.id).toBe(a.id)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(PATCH)
    // The stepped-away-from configuration waits on the redo stack.
    expect(readUndoState(profileDir).redo).toEqual([b.id])
    // It was already recorded (as the manual snapshot), so undo adopted it
    // rather than writing a regret twin.
    expect(service.list().generations).toHaveLength(2)
  })

  it('records an unrecorded current configuration as a regret generation', async () => {
    const service = serve(host())
    const a = await service.snapshot(undefined, '2026-08-14T00:00:00.000Z')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: never-recorded\n')
    const step = await service.undo('2026-08-14T02:00:00.000Z')
    expect(step.changed).toBe(true)
    expect(step.result?.id).toBe(a!.id)
    const regret = service.list().generations.find(generation => generation.origin === 'regret')
    expect(regret?.inputs.profilePatch).toBe('- id: never-recorded\n')
    expect(readUndoState(profileDir).redo).toEqual([regret!.id])
  })

  it('answers nothing-to-undo when no earlier configuration exists', async () => {
    const service = serve(host())
    await service.snapshot(undefined, '2026-08-14T00:00:00.000Z')
    expect(await service.undo('2026-08-14T02:00:00.000Z')).toEqual({ changed: false, empty: 'nothing-to-undo' })
    expect(await serve().undo('2026-08-14T02:00:00.000Z')).toEqual({ changed: false, empty: 'nothing-to-undo' })
  })

  it('redoes an undone step and empties the stack', async () => {
    const service = serve(host())
    const { b } = await recordTwo(service)
    await service.undo('2026-08-14T02:00:00.000Z')
    const step = await service.redo()
    expect(step.changed).toBe(true)
    expect(step.result?.id).toBe(b.id)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: changed\n')
    expect(readUndoState(profileDir)).toEqual({ redo: [] })
    expect(await service.redo()).toEqual({ changed: false, empty: 'nothing-to-redo' })
  })

  it('drops a redo entry whose record is gone and reports nothing-to-redo', async () => {
    const service = serve(host())
    const { b } = await recordTwo(service)
    await service.undo('2026-08-14T02:00:00.000Z')
    // Someone deletes the redo target by hand.
    rmSync(join(profileDir, 'timemachine', `${b.id}.json`))
    expect(await service.redo()).toEqual({ changed: false, empty: 'nothing-to-redo' })
    expect(readUndoState(profileDir)).toEqual({ redo: [] })
  })

  it('clears the redo stack when a new configuration is recorded after an undo', async () => {
    const service = serve(host())
    await recordTwo(service)
    await service.undo('2026-08-14T02:00:00.000Z')
    expect(readUndoState(profileDir).redo).toHaveLength(1)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: third\n')
    await service.snapshot(undefined, '2026-08-14T03:00:00.000Z')
    expect(readUndoState(profileDir)).toEqual({ redo: [] })
    expect(await service.redo()).toEqual({ changed: false, empty: 'nothing-to-redo' })
  })

  it('keeps a refusal reachable: undo into drift refuses and the redo entry stays', async () => {
    const handoff = host()
    const service = serve(handoff)
    const { a } = await recordTwo(service)
    // Make the target no longer reproduce: stored digest the stand-in render
    // cannot produce.
    writeFileSync(
      join(profileDir, 'timemachine', `${a.id}.json`),
      JSON.stringify({ ...a, composed: { ...a.composed, digest: '0'.repeat(64) } }, undefined, 2),
    )
    const step = await service.undo('2026-08-14T02:00:00.000Z')
    expect(step.changed).toBe(false)
    expect(step.result?.refusal).toContain('can no longer be reproduced')
    expect(readUndoState(profileDir).redo).toHaveLength(1)
  })
})

describe('removing a generation', () => {
  it('deletes a plain record', async () => {
    const service = serve(host())
    const generation = (await service.snapshot(undefined, '2026-08-14T00:00:00.000Z'))!
    expect(service.remove(generation.id)).toEqual({ removed: true })
    expect(service.list().generations).toEqual([])
  })

  it('protects the booted configuration and the last known-good one', async () => {
    const handoff = host()
    const service = serve(handoff)
    const booted = (await service.recordBoot('2026-08-14T00:00:00.000Z'))!
    expect(service.remove(booted.id).refusal).toContain('what this process booted')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: other\n')
    const good = (await service.snapshot(undefined, '2026-08-14T01:00:00.000Z'))!
    writeFileSync(
      join(profileDir, 'timemachine', `${good.id}.json`),
      JSON.stringify({ ...good, outcomes: [{ at: '2026-08-14T01:01:00.000Z', status: 'activated', overlays: [] }] }, undefined, 2),
    )
    expect(service.remove(good.id).refusal).toContain('last known-good')
    expect(service.list().generations).toHaveLength(2)
  })

  it('refuses without a profile', () => {
    expect(serve().remove('anything').removed).toBe(false)
  })
})

describe('diffing generations', () => {
  it('diffs two recorded generations file by file', async () => {
    const service = serve(host())
    const a = (await service.snapshot(undefined, '2026-08-14T00:00:00.000Z'))!
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: changed\n')
    const b = (await service.snapshot(undefined, '2026-08-14T01:00:00.000Z'))!
    const diffs = service.diff(a.id, b.id)
    expect(diffs.map(diff => diff.file)).toEqual(['profilePatch', 'render'])
    expect(diffs[0]!.hunks.some(hunk => hunk.type === 'add' && hunk.text === '- id: changed')).toBe(true)
  })

  it('diffs a generation against the current disk state', async () => {
    const service = serve(host())
    const a = (await service.snapshot(undefined, '2026-08-14T00:00:00.000Z'))!
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: drifted\n')
    const diffs = service.diff(a.id)
    expect(diffs.map(diff => diff.file)).toContain('profilePatch')
    // Identical configurations diff to nothing.
    writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH)
    expect(service.diff(a.id)).toEqual([])
  })

  it('answers an empty diff without a profile', () => {
    expect(serve().diff('anything')).toEqual([])
  })
})

describe('status', () => {
  it('derives undo/redo availability and boot health from the store', async () => {
    const service = serve(host())
    expect(service.status()).toEqual({ canUndo: false, canRedo: false, total: 0, lastBootFailed: false })
    await service.snapshot(undefined, '2026-08-14T00:00:00.000Z')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: changed\n')
    const b = (await service.snapshot(undefined, '2026-08-14T01:00:00.000Z'))!
    // The current configuration is the newest record, and an earlier one
    // exists, so undo is available.
    expect(service.status()).toMatchObject({ canUndo: true, canRedo: false, total: 2, lastBootFailed: false })
    writeFileSync(
      join(profileDir, 'timemachine', `${b.id}.json`),
      JSON.stringify({ ...b, outcomes: [{ at: '2026-08-14T02:00:00.000Z', status: 'failed', overlays: [], error: 'boom' }] }, undefined, 2),
    )
    expect(service.status().lastBootFailed).toBe(true)
    await service.undo('2026-08-14T03:00:00.000Z')
    expect(service.status()).toMatchObject({ canRedo: true, canUndo: true })
  })

  it('reports a zeroed status without a profile', () => {
    expect(serve().status()).toEqual({ canUndo: false, canRedo: false, total: 0, lastBootFailed: false })
  })
})

describe('prune', () => {
  it('reaps boot/auto records beyond the retention bound and spares the rest', async () => {
    const service = serve(host())
    const booted: string[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: boot-${attempt}\n`)
      const generation = (await service.record(environment(), `2026-08-14T0${attempt}:00:00.000Z`, 'boot'))!
      booted.push(generation.id)
    }
    // A manual snapshot is somebody's deliberate record: never reaped.
    const manual = (await service.snapshot(undefined, '2026-08-14T04:00:00.000Z'))!
    await service.updateSettings({ retention: 1 })
    expect(service.prune()).toEqual(booted.slice(0, 2))
    expect(service.list().generations.map(generation => generation.id)).toEqual([booted[2], manual.id])
  })

  it('answers undefined without a profile', () => {
    expect(serve().prune()).toBeUndefined()
  })
})

describe('settings', () => {
  it('reads defaults and applies patches', async () => {
    const service = serve(host())
    expect(service.getSettings().retention).toBe(50)
    const next = await service.updateSettings({ retention: 10, shortcuts: { redo: 'Ctrl+Y' } })
    expect(next?.retention).toBe(10)
    expect(next?.shortcuts).toEqual({ undo: 'Ctrl+Alt+Z', redo: 'Ctrl+Y' })
    expect(service.getSettings().retention).toBe(10)
  })

  it('answers defaults and undefined without a profile', async () => {
    const service = serve()
    expect(service.getSettings().autoSave).toBe(true)
    expect(await service.updateSettings({ autoSave: false })).toBeUndefined()
  })
})

describe('auto-save watcher', () => {
  /** Arm the service's watcher with a test-speed debounce. */
  const arm = async (service: TimeMachine): Promise<void> => {
    await service.updateSettings({ debounceMs: 20 })
    service.startAutoSave()
  }

  it('records a changed input on its own, with the auto origin', async () => {
    const service = serve(host())
    await service.snapshot(undefined, '2026-08-14T00:00:00.000Z')
    await arm(service)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: auto\n')
    await vi.waitFor(() => {
      expect(service.list().generations.some(generation => generation.origin === 'auto')).toBe(true)
    })
    service.stopAutoSave()
  })

  it('stays disarmed when the settings switch auto-save off, live', async () => {
    const service = serve(host())
    await arm(service)
    await service.updateSettings({ autoSave: false })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: ignored\n')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(service.list().generations.some(generation => generation.origin === 'auto')).toBe(false)
    // Switching back on re-arms without a reboot.
    await service.updateSettings({ autoSave: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: seen\n')
    await vi.waitFor(() => {
      expect(service.list().generations.some(generation => generation.origin === 'auto')).toBe(true)
    })
    service.stopAutoSave()
  })

  it('does not auto-record its own restore write-back', async () => {
    const service = serve(host())
    const a = (await service.snapshot(undefined, '2026-08-14T00:00:00.000Z'))!
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: changed\n')
    await service.snapshot(undefined, '2026-08-14T01:00:00.000Z')
    await arm(service)
    const before = service.list().generations.length
    await service.restore(a.id)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(service.list().generations).toHaveLength(before)
    service.stopAutoSave()
  })

  it('stops recording after stopAutoSave', async () => {
    const service = serve(host())
    await arm(service)
    service.stopAutoSave()
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: late\n')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(service.list().generations).toHaveLength(0)
  })
})
