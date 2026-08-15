/**
 * `ctx.timemachine` over derived or explicit host facts: what it serves
 * without a profile, what it records with one, and the guarantee that a
 * refused restore leaves the profile untouched.
 * @module dsh-timemachine/tests/service
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TimeMachine from '../src/service.ts'
import {
  digestText,
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
