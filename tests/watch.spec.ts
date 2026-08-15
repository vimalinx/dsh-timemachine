/**
 * The auto-save watcher over real temporary directories: settling debounce,
 * digest-based silence for no-op writes, self-write suppression, and watching
 * files that do not exist yet. Short debounces, no fake timers — `fs.watch`
 * behaves differently enough under both that only the real thing is evidence.
 * @module dsh-timemachine/tests/watch
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generationId } from '../src/generations.ts'
import { watchInputs } from '../src/watch.ts'

let profileDir: string
let homeDir: string
const stops: (() => void)[] = []

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'dsh-timemachine-watch-'))
  homeDir = mkdtempSync(join(tmpdir(), 'dsh-timemachine-watch-home-'))
  writeFileSync(join(profileDir, 'package.json'), '{}\n')
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  rmSync(profileDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

/** Start a watcher with the test debounce, tracking its stop for cleanup. */
function watch(options: Partial<Parameters<typeof watchInputs>[0]> & Pick<Parameters<typeof watchInputs>[0], 'onChange'>): () => void {
  const stop = watchInputs({
    profileDir,
    homeDir,
    debounceMs: 20,
    shouldIgnore: () => false,
    ...options,
  })
  stops.push(stop)
  return stop
}

const writePatch = (text: string) => writeFileSync(join(profileDir, 'cordis.patch.yml'), text)

describe('watching the input files', () => {
  it('fires once the edits settle', async () => {
    const onChange = vi.fn()
    watch({ onChange })
    writePatch('- id: a\n')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
  })

  it('debounces a burst of saves into one firing', async () => {
    const onChange = vi.fn()
    watch({ onChange })
    writePatch('- id: a\n')
    writePatch('- id: ab\n')
    writePatch('- id: abc\n')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('stays silent when a rewrite changes nothing', async () => {
    const onChange = vi.fn()
    writePatch('- id: a\n')
    watch({ onChange })
    writePatch('- id: a\n')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('sees a patch file created that did not exist at watch time', async () => {
    const onChange = vi.fn()
    watch({ onChange })
    // The patch did not exist when the watcher started; the directory watch
    // still sees it appear.
    writePatch('- id: new\n')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
  })

  it('watches the home patch layer too', async () => {
    const onChange = vi.fn()
    watch({ onChange })
    writeFileSync(join(homeDir, 'cordis.patch.yml'), '- id: home\n')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
  })

  it('suppresses a self-write the service registered', async () => {
    const onChange = vi.fn()
    const ignored: string[] = []
    watch({ onChange, shouldIgnore: digest => ignored.includes(digest) })
    const text = '- id: restore\n'
    // The registration digest is the composition-scope id of the post-write
    // inputs — what the service computes before writing the files.
    ignored.push(generationId({ manifest: '{}\n', profilePatch: text, homePatch: null }, null))
    writePatch(text)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stops firing once stopped', async () => {
    const onChange = vi.fn()
    const stop = watch({ onChange })
    stop()
    writePatch('- id: a\n')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('narrows coverage rather than throwing when a directory is unwatchable', () => {
    const missing = join(profileDir, 'gone')
    expect(() => watchInputs({
      profileDir: missing,
      homeDir: missing,
      debounceMs: 20,
      shouldIgnore: () => false,
      onChange: () => {},
    })).not.toThrow()
  })
})
