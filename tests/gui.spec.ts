/**
 * The rescue GUI's loopback server: HTML page delivery, every JSON endpoint
 * against a real profile directory under a temporary `$DSH_HOME`, the
 * language resolution, and the running-dsh probe.
 * @module dsh-timemachine/tests/gui
 */

import { createServer as createTcpServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGenerations } from '../src/generations.ts'
import { probeDshRunning, resolveLang, startGuiServer, type GuiServer } from '../src/gui.ts'
import { readTimemachineSettings } from '../src/settings.ts'
import { openProfile } from '../src/standalone.ts'
import type { ConfigGeneration } from '../src/types.ts'

let home: string
let profileDir: string
let patchPath: string
let savedHome: string | undefined
let server: GuiServer

const MANIFEST = '{"dsh":{"profile":{"bundles":[]}}}\n'

beforeEach(async () => {
  savedHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-timemachine-gui-'))
  process.env.DSH_HOME = home
  profileDir = join(home, 'profiles', 'headless')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), MANIFEST)
  patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchPath, '[]\n')
  server = await startGuiServer(openProfile('headless'), { lang: 'en' })
})

afterEach(async () => {
  await server.close()
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

/** One JSON GET/POST against the test server. */
async function api<T>(path: string, init?: RequestInit): Promise<{ status: number, body: T }> {
  const response = await fetch(new URL(path, server.url), init)
  return { status: response.status, body: await response.json() as T }
}

/** POST a JSON document. */
function post<T>(path: string, body: unknown): Promise<{ status: number, body: T }> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Snapshot through the endpoint and return the stored generation. */
async function snapshot(reason?: string): Promise<ConfigGeneration> {
  const { status, body } = await post<ConfigGeneration>(
    '/api/snapshot', reason === undefined ? {} : { reason },
  )
  expect(status).toBe(200)
  return body
}

describe('the page', () => {
  it('serves the self-contained HTML at the root', async () => {
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('dsh-timemachine rescue')
    expect(html).toContain('headless')
    expect(html).toContain('/api/status')
  })

  it('renders Chinese when the language resolves to zh', async () => {
    const zh = await startGuiServer(openProfile('headless'), { lang: 'zh' })
    try {
      const html = await (await fetch(zh.url)).text()
      expect(html).toContain('配置历史')
      expect(html).toContain('回退到 last good')
    } finally {
      await zh.close()
    }
  })
})

describe('status and generations', () => {
  it('answers the status payload with the race probe and the restore paths', async () => {
    const { status, body } = await api<{
      profile: string
      status: { canUndo: boolean, total: number, lastBootFailed: boolean }
      dshRunning: boolean
      lastGoodId: string | null
      paths: string[]
      settings: { retention: number }
    }>('/api/status')
    expect(status).toBe(200)
    expect(body.profile).toBe('headless')
    expect(body.status.total).toBe(0)
    expect(typeof body.dshRunning).toBe('boolean')
    expect(body.lastGoodId).toBeNull()
    expect(body.paths).toHaveLength(3)
    expect(body.settings.retention).toBe(50)
  })

  it('lists generations with their origin, reason, and badges', async () => {
    const generation = await snapshot('before the experiment')
    const { body } = await api<{
      generations: {
        id: string
        origin: string
        reason: string | null
        lastGood: boolean
        bundleCount: number
      }[]
    }>('/api/generations')
    expect(body.generations).toHaveLength(1)
    expect(body.generations[0]).toMatchObject({
      id: generation.id,
      origin: 'manual',
      reason: 'before the experiment',
      lastGood: false,
    })
  })

  it('flags the last known-good configuration', async () => {
    const generation = await snapshot()
    writeFileSync(
      join(profileDir, 'timemachine', `${generation.id}.json`),
      JSON.stringify({ ...generation, outcomes: [{ at: '2026-08-14T00:00:01.000Z', status: 'activated', overlays: [] }] }),
    )
    const { body } = await api<{ generations: { lastGood: boolean }[] }>('/api/generations')
    expect(body.generations[0]!.lastGood).toBe(true)
    const status = await api<{ lastGoodId: string | null }>('/api/status')
    expect(status.body.lastGoodId).toBe(generation.id)
  })
})

describe('diff, restore, undo, redo', () => {
  it('diffs a generation against the current files on disk', async () => {
    const generation = await snapshot()
    writeFileSync(patchPath, '- id: changed\n')
    const { status, body } = await api<{ diffs: { file: string, hunks: { type: string, text: string }[] }[] }>(
      `/api/diff?id=${generation.id}`,
    )
    expect(status).toBe(200)
    const patch = body.diffs.find(diff => diff.file === 'profilePatch')
    expect(patch).toBeDefined()
    expect(patch!.hunks.some(hunk => hunk.type === 'add' && hunk.text === '- id: changed')).toBe(true)
    // An unchanged configuration diffs to nothing.
    writeFileSync(patchPath, '[]\n')
    const same = await api<{ diffs: unknown[] }>(`/api/diff?id=${generation.id}`)
    expect(same.body.diffs).toEqual([])
  })

  it('restores a recorded configuration for real', async () => {
    const generation = await snapshot()
    writeFileSync(patchPath, '- id: drifted\n')
    const { status, body } = await post<{ restored: boolean, changes: string[] }>(
      '/api/restore', { id: generation.id },
    )
    expect(status).toBe(200)
    expect(body.restored).toBe(true)
    expect(readFileSync(patchPath, 'utf8')).toBe('[]\n')
  })

  it('steps back and forward through the endpoints', async () => {
    await snapshot()
    writeFileSync(patchPath, '- id: changed\n')
    const second = await snapshot()
    const undo = await post<{ changed: boolean }>('/api/undo', {})
    expect(undo.body.changed).toBe(true)
    expect(readFileSync(patchPath, 'utf8')).toBe('[]\n')
    const redo = await post<{ changed: boolean, result?: { id: string } }>('/api/redo', {})
    expect(redo.body.changed).toBe(true)
    expect(redo.body.result?.id).toBe(second.id)
    expect(readFileSync(patchPath, 'utf8')).toBe('- id: changed\n')
    const again = await post<{ empty?: string }>('/api/redo', {})
    expect(again.body.empty).toBe('nothing-to-redo')
  })
})

describe('remove and prune', () => {
  it('removes a plain record and protects the last known-good one', async () => {
    const generation = await snapshot()
    writeFileSync(
      join(profileDir, 'timemachine', `${generation.id}.json`),
      JSON.stringify({ ...generation, outcomes: [{ at: '2026-08-14T00:00:01.000Z', status: 'activated', overlays: [] }] }),
    )
    const refused = await post<{ removed: boolean, refusal?: string }>('/api/remove', { id: generation.id })
    expect(refused.body.removed).toBe(false)
    expect(refused.body.refusal).toContain('last known-good')

    writeFileSync(patchPath, '- id: other\n')
    const plain = await snapshot()
    const removed = await post<{ removed: boolean }>('/api/remove', { id: plain.id })
    expect(removed.body.removed).toBe(true)
  })

  it('prunes on demand', async () => {
    await snapshot()
    const { body } = await post<{ removed: string[] }>('/api/prune', {})
    expect(body.removed).toEqual([])
  })
})

describe('settings', () => {
  it('reads and patches the settings over HTTP', async () => {
    const before = await api<{ autoSave: boolean }>('/api/settings')
    expect(before.status).toBe(200)
    expect(before.body.autoSave).toBe(true)
    const updated = await post<{ retention: number, shortcuts: { redo: string } }>(
      '/api/settings', { patch: { retention: 10, shortcuts: { redo: 'Ctrl+Y' } } },
    )
    expect(updated.body.retention).toBe(10)
    expect(readTimemachineSettings(profileDir).shortcuts.redo).toBe('Ctrl+Y')
  })
})

describe('export and import', () => {
  it('downloads the history as a zip and imports it back', async () => {
    const generation = await snapshot('kept')
    const exported = await fetch(new URL('/api/export', server.url))
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toBe('application/zip')
    const bytes = Buffer.from(await exported.arrayBuffer())

    const removed = await post<{ removed: boolean }>('/api/remove', { id: generation.id })
    expect(removed.body.removed).toBe(true)
    expect(readGenerations(profileDir).generations).toHaveLength(0)

    const imported = await api<{ imported: string[], skipped: string[] }>('/api/import', {
      method: 'POST',
      body: bytes,
    })
    expect(imported.status).toBe(200)
    expect(imported.body.imported).toEqual([generation.id])
    expect(readGenerations(profileDir).generations[0]?.reason).toBe('kept')
  })

  it('rejects a corrupt archive as a bad request', async () => {
    const response = await api<{ error: string }>('/api/import', {
      method: 'POST',
      body: Buffer.from('not a zip'),
    })
    expect(response.status).toBe(400)
  })
})

describe('routing edge cases', () => {
  it('answers 404 for unknown routes and 500 for a missing generation', async () => {
    expect((await api('/api/nope')).status).toBe(404)
    const missing = await post('/api/restore', { id: 'ffffffffffff' })
    expect(missing.status).toBe(500)
  })
})

describe('language resolution', () => {
  it('prefers DSH_TIMEMACHINE_LANG, then the locale', () => {
    expect(resolveLang({ DSH_TIMEMACHINE_LANG: 'zh' })).toBe('zh')
    expect(resolveLang({ DSH_TIMEMACHINE_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toBe('en')
    expect(resolveLang({ LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(resolveLang({ LC_ALL: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh')
    expect(resolveLang({ LANG: 'en_US.UTF-8' })).toBe('en')
    expect(resolveLang({})).toBe('en')
  })
})

describe('the running-dsh probe', () => {
  it('is false on a closed port and true on a listening one', async () => {
    // Port 1 is never assignable to user processes; the probe refused fast.
    expect(await probeDshRunning(1)).toBe(false)
    const listener = createTcpServer()
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      expect(await probeDshRunning(port)).toBe(true)
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()))
    }
  })
})
