/**
 * The standalone CLI's verbs against a real profile directory under a
 * temporary `$DSH_HOME`: argument parsing, the undo/redo loop, snapshot
 * reasons, remove protection, export/import round-trips, settings, and prune.
 * @module dsh-timemachine/tests/cli
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, run } from '../src/cli.ts'
import { readGenerations, recordGeneration } from '../src/generations.ts'
import { readTimemachineSettings, writeTimemachineSettings } from '../src/settings.ts'
import { anchorOutsideProfiles } from '../src/standalone.ts'

let home: string
let profileDir: string
let patchPath: string
let savedHome: string | undefined

const MANIFEST = '{"dsh":{"profile":{"bundles":[]}}}\n'

beforeEach(() => {
  savedHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-timemachine-cli-'))
  process.env.DSH_HOME = home
  profileDir = join(home, 'profiles', 'headless')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), MANIFEST)
  patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchPath, '[]\n')
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

/** Run one CLI invocation with its output captured. */
async function cli(argv: readonly string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write)
  try {
    return { code: await run(parseArgs(argv)), stdout, stderr }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

describe('parseArgs', () => {
  it('parses every verb shape and the help flags', () => {
    expect(parseArgs(['log', '--profile', 'x'])).toEqual({ action: 'log', profile: 'x' })
    expect(parseArgs(['show', 'abc', '--profile', 'x'])).toEqual({ action: 'show', profile: 'x', id: 'abc' })
    expect(parseArgs(['diff', 'a', 'b', '--profile', 'x'])).toEqual({ action: 'diff', profile: 'x', id: 'a', against: 'b' })
    expect(parseArgs(['undo', '--profile', 'x'])).toEqual({ action: 'undo', profile: 'x' })
    expect(parseArgs(['snapshot', 'why', '--profile', 'x']))
      .toEqual({ action: 'snapshot', profile: 'x', reason: 'why' })
    expect(parseArgs(['export', '--profile', 'x'])).toEqual({ action: 'export', profile: 'x' })
    expect(parseArgs(['import', 'a.zip', '--profile', 'x'])).toEqual({ action: 'import', profile: 'x', zip: 'a.zip' })
    expect(parseArgs(['settings', '--set', 'retention=10', '--set', 'autoSave=false', '--profile', 'x']))
      .toEqual({ action: 'settings', profile: 'x', sets: ['retention=10', 'autoSave=false'] })
    expect(parseArgs(['gui', '--profile', 'x'])).toEqual({ action: 'gui', profile: 'x' })
    expect(parseArgs(['-h'])).toEqual({ action: 'help' })
    expect(parseArgs(['--help'])).toEqual({ action: 'help' })
  })

  it('rejects bad invocations', () => {
    expect(() => parseArgs([])).toThrow('an action is required')
    expect(() => parseArgs(['log'])).toThrow('--profile <name> is required')
    expect(() => parseArgs(['log', '--bogus', '--profile', 'x'])).toThrow('unknown flag')
    expect(() => parseArgs(['show', '--profile', 'x'])).toThrow('wrong argument count')
    expect(() => parseArgs(['log', '--set', 'retention=10', '--profile', 'x']))
      .toThrow('--set only goes with the settings action')
    expect(() => parseArgs(['settings', '--set', 'bogus=1', '--profile', 'x'])).not.toThrow()
  })
})

describe('snapshot', () => {
  it('records the configuration with the manual origin and its reason', async () => {
    const result = await cli(['snapshot', 'before the experiment', '--profile', 'headless'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('before the experiment')
    const { generations } = readGenerations(profileDir)
    expect(generations).toHaveLength(1)
    expect(generations[0]!.origin).toBe('manual')
    expect(generations[0]!.reason).toBe('before the experiment')
  })

  it('adopts the existing record when nothing changed', async () => {
    expect((await cli(['snapshot', '--profile', 'headless'])).code).toBe(0)
    expect((await cli(['snapshot', 'again', '--profile', 'headless'])).code).toBe(0)
    expect(readGenerations(profileDir).generations).toHaveLength(1)
  })
})

describe('undo and redo', () => {
  /** Snapshot the base patch, change it, snapshot again. */
  const recordTwo = async (): Promise<void> => {
    expect((await cli(['snapshot', '--profile', 'headless'])).code).toBe(0)
    writeFileSync(patchPath, '- id: changed\n')
    expect((await cli(['snapshot', '--profile', 'headless'])).code).toBe(0)
  }

  it('steps back and forward, writing the input files for real', async () => {
    await recordTwo()
    const undo = await cli(['undo', '--profile', 'headless'])
    expect(undo.code).toBe(0)
    expect(undo.stdout).toContain('stepped back to configuration')
    expect(readFileSync(patchPath, 'utf8')).toBe('[]\n')
    const redo = await cli(['redo', '--profile', 'headless'])
    expect(redo.code).toBe(0)
    expect(redo.stdout).toContain('stepped forward to configuration')
    expect(readFileSync(patchPath, 'utf8')).toBe('- id: changed\n')
  })

  it('refuses with a nonzero exit when there is nothing to undo or redo', async () => {
    const undo = await cli(['undo', '--profile', 'headless'])
    expect(undo.code).toBe(1)
    expect(undo.stderr).toContain('nothing to undo')
    const redo = await cli(['redo', '--profile', 'headless'])
    expect(redo.code).toBe(1)
    expect(redo.stderr).toContain('nothing to redo')
  })

  it('clears the redo stack when a new configuration is recorded after an undo', async () => {
    await recordTwo()
    expect((await cli(['undo', '--profile', 'headless'])).code).toBe(0)
    writeFileSync(patchPath, '- id: third\n')
    expect((await cli(['snapshot', '--profile', 'headless'])).code).toBe(0)
    const redo = await cli(['redo', '--profile', 'headless'])
    expect(redo.code).toBe(1)
    expect(redo.stderr).toContain('nothing to redo')
  })
})

describe('restore', () => {
  it('writes a recorded configuration back and composes it for verification', async () => {
    await cli(['snapshot', '--profile', 'headless'])
    writeFileSync(patchPath, '- id: drifted\n')
    const generation = readGenerations(profileDir).generations[0]!
    const result = await cli(['restore', generation.id, '--profile', 'headless'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`is back at configuration ${generation.id}`)
    expect(readFileSync(patchPath, 'utf8')).toBe('[]\n')
  })

  it('refuses a drifted configuration and leaves the profile untouched', async () => {
    await cli(['snapshot', '--profile', 'headless'])
    const generation = readGenerations(profileDir).generations[0]!
    // A stored digest the installation cannot produce stands in for drift.
    writeFileSync(
      join(profileDir, 'timemachine', `${generation.id}.json`),
      JSON.stringify({ ...generation, composed: { ...generation.composed, digest: '0'.repeat(64) } }),
    )
    writeFileSync(patchPath, '- id: my-own-edit\n')
    const result = await cli(['restore', generation.id, '--profile', 'headless'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('can no longer be reproduced')
    expect(result.stderr).toContain('the profile is unchanged')
    expect(readFileSync(patchPath, 'utf8')).toBe('- id: my-own-edit\n')
  })
})

describe('remove', () => {
  it('deletes a plain record and protects the last known-good one', async () => {
    await cli(['snapshot', '--profile', 'headless'])
    const good = readGenerations(profileDir).generations[0]!
    writeFileSync(
      join(profileDir, 'timemachine', `${good.id}.json`),
      JSON.stringify({ ...good, outcomes: [{ at: '2026-08-14T00:00:01.000Z', status: 'activated', overlays: [] }] }),
    )
    const refused = await cli(['remove', good.id, '--profile', 'headless'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('last known-good')

    writeFileSync(patchPath, '- id: other\n')
    await cli(['snapshot', '--profile', 'headless'])
    const plain = readGenerations(profileDir).generations.find(generation => generation.id !== good.id)!
    const removed = await cli(['remove', plain.id, '--profile', 'headless'])
    expect(removed.code).toBe(0)
    expect(removed.stdout).toContain(`removed configuration ${plain.id}`)
    expect(readGenerations(profileDir).generations).toHaveLength(1)
  })
})

describe('status', () => {
  it('reports undo/redo availability, the total, and boot health', async () => {
    const empty = await cli(['status', '--profile', 'headless'])
    expect(empty.code).toBe(0)
    expect(empty.stdout).toContain('generations: 0')
    expect(empty.stdout).toContain('undo: nothing to undo')
    expect(empty.stdout).toContain('no boot recorded')

    await cli(['snapshot', '--profile', 'headless'])
    writeFileSync(patchPath, '- id: changed\n')
    await cli(['snapshot', '--profile', 'headless'])
    const full = await cli(['status', '--profile', 'headless'])
    expect(full.stdout).toContain('generations: 2')
    expect(full.stdout).toContain('undo: available')
    expect(full.stdout).toContain('redo: nothing to redo')
    expect(full.stdout).toContain('latest: ')
  })
})

describe('export and import', () => {
  it('round-trips the history through a zip', async () => {
    await cli(['snapshot', 'kept', '--profile', 'headless'])
    const zip = join(home, 'backup.zip')
    const exported = await cli(['export', zip, '--profile', 'headless'])
    expect(exported.code).toBe(0)
    expect(exported.stdout).toContain(`wrote ${zip}`)
    expect(existsSync(zip)).toBe(true)

    const id = readGenerations(profileDir).generations[0]!.id
    expect((await cli(['remove', id, '--profile', 'headless'])).code).toBe(0)
    expect(readGenerations(profileDir).generations).toHaveLength(0)

    const imported = await cli(['import', zip, '--profile', 'headless'])
    expect(imported.code).toBe(0)
    expect(imported.stdout).toContain('imported 1')
    const generation = readGenerations(profileDir).generations[0]!
    expect(generation.id).toBe(id)
    expect(generation.reason).toBe('kept')

    const again = await cli(['import', zip, '--profile', 'headless'])
    expect(again.stdout).toContain('skipped 1')
  })

  it('uses a timestamped default filename in the working directory', async () => {
    await cli(['snapshot', '--profile', 'headless'])
    const workdir = mkdtempSync(join(tmpdir(), 'dsh-timemachine-export-'))
    const cwd = process.cwd()
    process.chdir(workdir)
    try {
      const result = await cli(['export', '--profile', 'headless'])
      expect(result.code).toBe(0)
      const match = /wrote (dsh-timemachine-\d{8}-\d{6}\.zip)/.exec(result.stdout)
      expect(match).not.toBeNull()
      expect(existsSync(join(workdir, match![1]!))).toBe(true)
    } finally {
      process.chdir(cwd)
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})

describe('settings', () => {
  it('prints the defaults and applies --set patches', async () => {
    const printed = await cli(['settings', '--profile', 'headless'])
    expect(printed.code).toBe(0)
    expect(printed.stdout).toContain('autoSave: true')
    expect(printed.stdout).toContain('retention: 50')

    const updated = await cli([
      'settings', '--set', 'retention=10', '--set', 'shortcuts.redo=Ctrl+Y', '--profile', 'headless',
    ])
    expect(updated.code).toBe(0)
    expect(updated.stdout).toContain('retention: 10')
    expect(updated.stdout).toContain('shortcuts.redo: Ctrl+Y')
    expect(updated.stdout).toContain('shortcuts.undo: Ctrl+Alt+Z')
    const stored = readTimemachineSettings(profileDir)
    expect(stored.retention).toBe(10)
    expect(stored.shortcuts.redo).toBe('Ctrl+Y')
  })

  it('rejects an invalid value without writing anything', async () => {
    await cli(['settings', '--set', 'retention=10', '--profile', 'headless'])
    const bad = await cli(['settings', '--set', 'retention=-3', '--profile', 'headless'])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('positive integer')
    expect(readTimemachineSettings(profileDir).retention).toBe(10)
    const unknown = await cli(['settings', '--set', 'bogus=1', '--profile', 'headless'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('known keys')
  })
})

describe('prune', () => {
  it('removes auto-cleanable records past the retention bound, keeping the rest', async () => {
    // Boot-origin records are the auto-cleanable kind; manual snapshots are not.
    for (const [index, patch] of ['- id: a\n', '- id: b\n', '- id: c\n'].entries()) {
      writeFileSync(patchPath, patch)
      await recordGeneration({
        profileDir,
        profile: 'headless',
        inputs: {
          manifest: MANIFEST,
          profilePatch: patch,
          homePatch: null,
        },
        bundles: [],
        render: `render ${index}\n`,
        now: `2026-08-14T0${index}:00:00.000Z`,
        origin: 'boot',
      })
    }
    writeFileSync(patchPath, '- id: manual\n')
    await cli(['snapshot', '--profile', 'headless']) // manual record: never pruned
    await writeTimemachineSettings(profileDir, { retention: 1 })

    const pruned = await cli(['prune', '--profile', 'headless'])
    expect(pruned.code).toBe(0)
    expect(pruned.stdout.match(/pruned configuration/g)).toHaveLength(2)
    expect(readGenerations(profileDir).generations).toHaveLength(2)

    const again = await cli(['prune', '--profile', 'headless'])
    expect(again.stdout).toContain('nothing to prune')
  })
})

describe('log, show, diff, help', () => {
  it('keeps the original verbs working', async () => {
    const empty = await cli(['log', '--profile', 'headless'])
    expect(empty.code).toBe(0)
    expect(empty.stdout).toContain('has recorded no configuration')

    await cli(['snapshot', '--profile', 'headless'])
    writeFileSync(patchPath, '- id: changed\n')
    await cli(['snapshot', '--profile', 'headless'])
    const [first, second] = readGenerations(profileDir).generations

    const log = await cli(['log', '--profile', 'headless'])
    expect(log.stdout).toContain(first!.id)
    expect(log.stdout).toContain(second!.id)

    const show = await cli(['show', first!.id.slice(0, 8), '--profile', 'headless'])
    expect(show.code).toBe(0)
    expect(show.stdout).toContain(`# configuration ${first!.id}`)

    const diff = await cli(['diff', first!.id, second!.id, '--profile', 'headless'])
    expect(diff.code).toBe(0)
    expect(diff.stdout).toContain(`--- ${first!.id}`)

    const help = await cli(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('usage: dsh-timemachine')
    expect(help.stdout).toContain('gui')
  })
})

describe('anchorOutsideProfiles', () => {
  it('permits the heal only from an anchor outside the profiles tree', () => {
    expect(anchorOutsideProfiles(home, join(home, 'profiles', 'web', 'node_modules', 'dsh-timemachine', 'package.json'))).toBe(false)
    expect(anchorOutsideProfiles(home, join(home, 'profiles', 'node_modules', 'dsh-timemachine', 'package.json'))).toBe(false)
    expect(anchorOutsideProfiles(home, join('/usr/lib', 'node_modules', 'dsh-timemachine', 'package.json'))).toBe(true)
    // The package's own anchor (the repository checkout) sits outside the temp home.
    expect(anchorOutsideProfiles(home)).toBe(true)
  })
})
