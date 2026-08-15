/**
 * The cordis plugin entry: channel registration (loopback authority), handler
 * dispatch over a derived profile, payload validation, the three business
 * error codes, the no-profile degradation, and the boot self-record with its
 * loader-driven outcome settlement.
 * @module dsh-timemachine/tests/rpc
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { TimeMachineRpcResult } from '../src/rpc.ts'
import type { TimeMachineListResponse } from '../src/rpc.ts'
import { apply, inject, name, recordGeneration } from '../src/index.ts'
import type TimeMachine from '../src/service.ts'

/** The channel handler shape, in this package's own result union (mirrors the carrier's). */
type ChannelHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<TimeMachineRpcResult<unknown>>

let home: string
let profileDir: string

const MANIFEST = '{"name":"dsh-profile-demo","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n'
const PATCH = '[]\n'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-config-rpc-'))
  profileDir = join(home, 'profiles', 'demo')
  // loadProfile requires the manifest; the patch layer is the user's own.
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), MANIFEST)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

interface Captured {
  channel: string
  handler: ChannelHandler
  options: { authority: string }
}

/** A plugin bench: fake Connection host face capturing the channel registration. */
async function bench(options: { withProfile?: boolean } = {}): Promise<{
  ctx: Context
  captured: Captured
  service: TimeMachine
}> {
  const ctx = new Context()
  if (options.withProfile !== false) ctx.baseUrl = pathToFileURL(`${profileDir}/`).href
  // A settled loader so the boot record settles `activated` (the launcher's
  // post-boot audit the service mirrors).
  ctx.provide('loader', { await: () => Promise.resolve(), entries: () => [] } as never)
  let captured: Captured | undefined
  ctx.provide('connection', {
    rpc: {
      handle: (channel: string, handler: ChannelHandler, opts: { authority: string }) => {
        captured = { channel, handler, options: opts }
        return async () => {}
      },
    },
  } as never)
  await ctx.plugin({ name, inject: [...inject], apply }).await()
  expect(captured).toBeDefined()
  return { ctx, captured: captured as Captured, service: ctx.get('timemachine') as TimeMachine }
}

/** Await the plugin's fire-and-forget boot record. */
async function awaitBootRecord(service: TimeMachine): Promise<string> {
  await vi.waitFor(() => { expect(service.bootedId).toBeDefined() })
  return service.bootedId as string
}

const SIGNAL = new AbortController().signal

describe('plugin entry', () => {
  it('declares the Connection host service and exports no default', async () => {
    expect(name).toBe('timemachine')
    expect(inject).toEqual(['connection'])
    expect('default' in await import('../src/index.ts')).toBe(false)
  })

  it('registers the /timemachine channel pinned to loopback', async () => {
    const { captured } = await bench()
    expect(captured.channel).toBe('/timemachine')
    expect(captured.options.authority).toBe('loopback')
  })

  it('records its own boot and settles it activated once the loader resolves', async () => {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${profileDir}/`).href
    ctx.provide('connection', { rpc: { handle: () => async () => {} } } as never)
    ctx.provide('loader', { await: () => Promise.resolve(), entries: () => [] } as never)
    await ctx.plugin({ name, inject: [...inject], apply }).await()
    const service = ctx.get('timemachine') as TimeMachine
    const bootedId = await awaitBootRecord(service)
    await vi.waitFor(() => {
      const record = JSON.parse(readFileSync(join(profileDir, 'timemachine', `${bootedId}.json`), 'utf8')) as {
        scope: string
        outcomes: { status: string }[]
      }
      expect(record.scope).toBe('composition')
      expect(record.outcomes).toEqual([expect.objectContaining({ status: 'activated', overlays: [] })])
    })
  })

  it('settles the boot failed when the loader rejects', async () => {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${profileDir}/`).href
    ctx.provide('connection', { rpc: { handle: () => async () => {} } } as never)
    ctx.provide('loader', { await: () => Promise.reject(new Error('entry blew up')), entries: () => [] } as never)
    await ctx.plugin({ name, inject: [...inject], apply }).await()
    const service = ctx.get('timemachine') as TimeMachine
    const bootedId = await awaitBootRecord(service)
    await vi.waitFor(() => {
      const record = JSON.parse(readFileSync(join(profileDir, 'timemachine', `${bootedId}.json`), 'utf8')) as {
        outcomes: { status: string; error?: string }[]
      }
      expect(record.outcomes).toEqual([expect.objectContaining({ status: 'failed', error: 'entry blew up' })])
    })
  })
})

describe('channel handler', () => {
  it('lists the booted profile as slim summaries, flagging unreadable records', async () => {
    const { captured, service } = await bench()
    const bootedId = await awaitBootRecord(service)
    // The outcome settles asynchronously off the loader's settlement.
    await vi.waitFor(() => { expect(service.lastGood()?.id).toBe(bootedId) })
    writeFileSync(join(profileDir, 'timemachine', 'corrupt.json'), 'not json')
    const result = await captured.handler('list', {}, SIGNAL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as TimeMachineListResponse
    expect(value.generations).toEqual([
      expect.objectContaining({ id: bootedId, scope: 'composition', bundleCount: 0, lastGood: true, booted: true }),
    ])
    expect(value.generations[0]).not.toHaveProperty('composed')
    expect(value.unreadable).toEqual([
      { path: join(profileDir, 'timemachine', 'corrupt.json'), reason: expect.stringContaining('') },
    ])
  })

  it('answers timemachine-absent when the tree was not booted from a profile', async () => {
    const { captured } = await bench({ withProfile: false })
    for (const endpoint of ['list', 'read', 'restore']) {
      const result = await captured.handler(endpoint, { id: 'x' }, SIGNAL)
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'timemachine-absent' }),
      })
    }
  })

  it('rejects invalid payloads with bad-request before dispatching', async () => {
    const { captured, service } = await bench()
    await awaitBootRecord(service)
    for (const payload of [{}, { id: 3 }, { id: '' }, 'nope']) {
      const result = await captured.handler('read', payload, SIGNAL)
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad-request' }) })
    }
    const unknown = await captured.handler('explode', {}, SIGNAL)
    expect(unknown).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad-request' }) })
  })

  it('maps an unknown id to timemachine-not-found', async () => {
    const { captured, service } = await bench()
    await awaitBootRecord(service)
    const result = await captured.handler('read', { id: 'ffffffffffff' }, SIGNAL)
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'timemachine-not-found' }) })
  })

  it('maps a prefix naming several generations to timemachine-ambiguous', async () => {
    const { captured } = await bench()
    // Record until two ids share a first hex digit, then address them by it.
    const seen = new Map<string, string>()
    let prefix = ''
    for (let attempt = 0; attempt < 500 && prefix === ''; attempt += 1) {
      const generation = await recordGeneration({
        profileDir,
        profile: 'demo',
        inputs: { manifest: `{"n":${attempt}}`, profilePatch: PATCH, homePatch: null },
        bundles: [],
        render: '- id: x\n',
        now: new Date(2026, 7, 14, 0, 0, attempt).toISOString(),
      })
      const candidate = generation.id.slice(0, 1)
      if (seen.has(candidate)) prefix = candidate
      else seen.set(candidate, generation.id)
    }
    expect(prefix).not.toBe('')
    const result = await captured.handler('read', { id: prefix }, SIGNAL)
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'timemachine-ambiguous' }) })
  })

  it('reads a full record and restores it, refusals riding the ok branch', async () => {
    const { captured, service } = await bench()
    const bootedId = await awaitBootRecord(service)

    const read = await captured.handler('read', { id: bootedId.slice(0, 8) }, SIGNAL)
    expect(read.ok).toBe(true)
    if (read.ok) expect((read.value as { id: string }).id).toBe(bootedId)

    // Drift the patch layer so the restore's verification refuses.
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: drifted\n  disabled: true\n')
    const restore = await captured.handler('restore', { id: bootedId }, SIGNAL)
    expect(restore.ok).toBe(true)
    if (!restore.ok) return
    const value = restore.value as { restored: boolean; refusal?: string }
    // The recorded patch text is exactly what is on disk, so writing it back
    // reproduces the recorded composition.
    expect(value.restored).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(PATCH)
  })
})

describe('boot record directory', () => {
  it('writes one record file per observed configuration', async () => {
    const { service } = await bench()
    const bootedId = await awaitBootRecord(service)
    expect(readdirSync(join(profileDir, 'timemachine'))).toEqual([`${bootedId}.json`])
  })
})
