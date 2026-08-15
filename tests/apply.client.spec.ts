/**
 * The browser half on a real cordis Context with a fake Connection RPC face
 * and the real SlotRegistry: dictionaries and the footer panel entry register
 * (and fold up on fiber disposal — HMR safety), the injected face drives the
 * /timemachine RPCs into the declared store with single-flight reads and
 * stale-answer guards, and connection/reset restarts the roster read.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConfigGeneration, RestoreResult } from '../src/types.ts'
import type {
  TimeMachineListResponse,
  TimeMachineRpcResult,
  GenerationSummary,
} from '../src/rpc.ts'
import { apply, inject } from '../src/client/index.ts'
import type { TimeMachinePanelFace, TimeMachineStore } from '../src/client/index.ts'
import { createTimeMachineStore } from '../src/client/store.ts'
import { en, NS, zh } from '../src/client/locales.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function rpcOk<T>(value: T): TimeMachineRpcResult<T> {
  return { ok: true, value }
}

function rpcErr(code: string, message: string): TimeMachineRpcResult<never> {
  return { ok: false, error: { code: code as never, message, details: {} } }
}

const SUMMARY: GenerationSummary = {
  id: 'abcdef0123456789',
  scope: 'full',
  recordedAt: '2026-08-01T08:00:00',
  lastSeenAt: '2026-08-02T09:30:00',
  latestStatus: 'activated',
  bundleCount: 1,
  lastGood: true,
  booted: true,
}

const GENERATION: ConfigGeneration = {
  formatVersion: 2,
  id: 'abcdef0123456789',
  scope: 'full',
  recordedAt: '2026-08-01T08:00:00',
  lastSeenAt: '2026-08-02T09:30:00',
  profile: 'web',
  inputs: { manifest: '{}', profilePatch: null, homePatch: null },
  environment: null,
  bundles: [{ name: '@deepseek-ai/dsh-bundle-base', version: '0.1.0-rc.6' }],
  composed: { digest: 'digest', render: 'plugins: []' },
  outcomes: [],
}

/**
 * Scripted `/timemachine` channel face: `call` dispatches by endpoint
 * onto the per-endpoint mocks the specs script.
 */
function fakeApi() {
  const api = {
    list: vi.fn((_payload: Record<string, never>) => Promise.resolve(rpcOk<TimeMachineListResponse>({ generations: [SUMMARY], unreadable: [] }))),
    read: vi.fn((_payload: { id: string }) => Promise.resolve(rpcOk(GENERATION))),
    restore: vi.fn((_payload: { id: string }) => Promise.resolve(rpcOk<RestoreResult>({
      id: GENERATION.id,
      restored: true,
      changes: ['wrote package.json'],
    }))),
  }
  const call = vi.fn((channel: string, endpoint: string, payload: unknown): Promise<TimeMachineRpcResult<unknown>> => {
    if (channel !== '/timemachine') throw new Error(`unexpected channel ${channel}`)
    if (endpoint === 'list') return api.list(payload as Record<string, never>)
    if (endpoint === 'read') return api.read(payload as { id: string })
    if (endpoint === 'restore') return api.restore(payload as { id: string })
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  return { call, ...api }
}

type FakeApi = ReturnType<typeof fakeApi>

async function bench(api: FakeApi) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { rpc: { call: api.call } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

/** Materialize the panel entry's inject face over a test-created store instance. */
function faceOf(ctx: Context): { face: TimeMachinePanelFace; store: ReturnType<TimeMachineStore['create']> } {
  const entry = ctx.slots.entries('sidebar.footer.action').find(candidate => candidate.options.id === 'timemachine-panel')
  expect(entry).toBeDefined()
  const store = createTimeMachineStore().create()
  const factory = entry!.inject as unknown as (actions: ReturnType<TimeMachineStore['create']>['actions']) => TimeMachinePanelFace
  return { face: factory(store.actions), store }
}

describe('timemachine browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('exports no default from the client half (the Loader would discard the function plugin)', async () => {
    expect('default' in await import('../src/client/index.ts')).toBe(false)
  })

  it('registers both dictionaries and the footer entry, and folds up on disposal (HMR safety)', async () => {
    const api = fakeApi()
    const { ctx, fiber } = await bench(api)
    const translate = ctx.locale.bind(NS)
    expect(translate('panel.title')).toBe(zh['panel.title'])
    ctx.locale.setLocale('en')
    expect(translate('panel.title')).toBe(en['panel.title'])
    expect(ctx.slots.entries('sidebar.footer.action').map(entry => entry.options.id)).toEqual(['timemachine-panel'])
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(translate('panel.title')).not.toBe(en['panel.title'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('onRefresh reads the roster once (single-flight) and publishes rows', async () => {
    const api = fakeApi()
    const { ctx } = await bench(api)
    const { face, store } = faceOf(ctx)
    const pending = deferred<TimeMachineRpcResult<TimeMachineListResponse>>()
    api.list.mockReturnValueOnce(pending.promise)
    face.onRefresh()
    face.onRefresh()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().list).toBe('loading')
    pending.resolve(rpcOk({ generations: [SUMMARY], unreadable: [] }))
    await vi.waitFor(() => { expect(store.getSnapshot().list).toBe('loaded') })
    expect(store.getSnapshot().generations).toEqual([SUMMARY])
    // The freed slot admits the next read.
    face.onRefresh()
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledTimes(2) })
  })

  it('maps timemachine-absent to the absent phase, other RPC errors and throws to a kept roster plus message', async () => {
    const api = fakeApi()
    const { ctx } = await bench(api)
    const { face, store } = faceOf(ctx)

    api.list.mockResolvedValueOnce(rpcErr('timemachine-absent', 'no profile boot'))
    face.onRefresh()
    await vi.waitFor(() => { expect(store.getSnapshot().list).toBe('absent') })

    api.list.mockResolvedValueOnce(rpcErr('timemachine-not-found', 'gone'))
    face.onRefresh()
    await vi.waitFor(() => { expect(store.getSnapshot().list).toBe('failed') })
    expect(store.getSnapshot().listError).toBe('timemachine-not-found: gone')

    api.list.mockRejectedValueOnce(new Error('connection refused'))
    face.onRefresh()
    await vi.waitFor(() => { expect(store.getSnapshot().listError).toBe('connection refused') })

    api.list.mockRejectedValueOnce('plain rejection')
    face.onRefresh()
    await vi.waitFor(() => { expect(store.getSnapshot().listError).toBe('plain rejection') })
  })

  it('onSelect reads the detail; a superseded or deselected read publishes nothing', async () => {
    const api = fakeApi()
    const { ctx } = await bench(api)
    const { face, store } = faceOf(ctx)

    const first = deferred<TimeMachineRpcResult<ConfigGeneration>>()
    const second = deferred<TimeMachineRpcResult<ConfigGeneration>>()
    api.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    face.onSelect('aaa')
    face.onSelect('bbb')
    expect(store.getSnapshot().detail).toEqual({ status: 'loading', id: 'bbb' })
    first.resolve(rpcOk(GENERATION))
    await Promise.resolve()
    expect(store.getSnapshot().detail).toEqual({ status: 'loading', id: 'bbb' })
    second.resolve(rpcOk(GENERATION))
    await vi.waitFor(() => { expect(store.getSnapshot().detail).toEqual({ status: 'loaded', generation: GENERATION }) })

    const orphan = deferred<TimeMachineRpcResult<ConfigGeneration>>()
    api.read.mockReturnValueOnce(orphan.promise)
    face.onSelect('ccc')
    face.onDeselect()
    expect(store.getSnapshot().detail).toEqual({ status: 'idle' })
    orphan.resolve(rpcOk(GENERATION))
    await Promise.resolve()
    expect(store.getSnapshot().detail).toEqual({ status: 'idle' })

    const rejected = deferred<TimeMachineRpcResult<ConfigGeneration>>()
    const current = deferred<TimeMachineRpcResult<ConfigGeneration>>()
    api.read.mockReturnValueOnce(rejected.promise).mockReturnValueOnce(current.promise)
    face.onSelect('ddd')
    face.onSelect('eee')
    rejected.reject(new Error('stale socket'))
    await Promise.resolve()
    // A superseded read's failure must not fail the newer selection's detail.
    expect(store.getSnapshot().detail).toEqual({ status: 'loading', id: 'eee' })
    current.resolve(rpcOk(GENERATION))
    await vi.waitFor(() => { expect(store.getSnapshot().detail.status).toBe('loaded') })
  })

  it('maps read RPC errors and throws into the detail failure', async () => {
    const api = fakeApi()
    const { ctx } = await bench(api)
    const { face, store } = faceOf(ctx)

    api.read.mockResolvedValueOnce(rpcErr('timemachine-ambiguous', 'two matches'))
    face.onSelect('ab')
    await vi.waitFor(() => {
      expect(store.getSnapshot().detail).toEqual({ status: 'failed', id: 'ab', message: 'timemachine-ambiguous: two matches' })
    })

    api.read.mockRejectedValueOnce(new Error('socket closed'))
    face.onSelect('abc')
    await vi.waitFor(() => {
      expect(store.getSnapshot().detail).toEqual({ status: 'failed', id: 'abc', message: 'socket closed' })
    })

    api.read.mockRejectedValueOnce('plain rejection')
    face.onSelect('abcd')
    await vi.waitFor(() => {
      expect(store.getSnapshot().detail).toEqual({ status: 'failed', id: 'abcd', message: 'plain rejection' })
    })
  })

  it('onRestore publishes the business result (success and refusal) and re-reads the roster', async () => {
    const api = fakeApi()
    const { ctx } = await bench(api)
    const { face, store } = faceOf(ctx)

    face.onConfirmRestore(GENERATION.id)
    expect(store.getSnapshot().confirmId).toBe(GENERATION.id)
    face.onCancelRestore()
    expect(store.getSnapshot().confirmId).toBeUndefined()
    face.onConfirmRestore(GENERATION.id)
    face.onRestore(GENERATION.id)
    await vi.waitFor(() => { expect(store.getSnapshot().restore.status).toBe('done') })
    expect(store.getSnapshot().confirmId).toBeUndefined()
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledTimes(1) })
    face.onDismissRestoreResult()
    expect(store.getSnapshot().restore).toEqual({ status: 'idle' })

    const refusal: RestoreResult = {
      id: GENERATION.id,
      restored: false,
      changes: [],
      refusal: 'bundle drift',
      verdict: {
        reproducible: false,
        digestChanged: true,
        drift: [{ name: '@deepseek-ai/dsh-bundle-base', recorded: '0.1.0-rc.6', current: '0.2.0' }],
      },
    }
    api.restore.mockResolvedValueOnce(rpcOk(refusal))
    face.onConfirmRestore(GENERATION.id)
    face.onRestore(GENERATION.id)
    await vi.waitFor(() => { expect(store.getSnapshot().restore).toEqual({ status: 'done', result: refusal }) })
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledTimes(2) })
  })

  it('onRestore maps RPC errors and throws to the failed state and still re-reads', async () => {
    const api = fakeApi()
    const { ctx } = await bench(api)
    const { face, store } = faceOf(ctx)

    api.restore.mockResolvedValueOnce(rpcErr('timemachine-not-found', 'gone'))
    face.onRestore('ghost')
    await vi.waitFor(() => {
      expect(store.getSnapshot().restore).toEqual({ status: 'failed', id: 'ghost', message: 'timemachine-not-found: gone' })
    })
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledTimes(1) })

    api.restore.mockRejectedValueOnce(new Error('socket closed'))
    face.onRestore('ghost')
    await vi.waitFor(() => {
      expect(store.getSnapshot().restore).toEqual({ status: 'failed', id: 'ghost', message: 'socket closed' })
    })

    api.restore.mockRejectedValueOnce('plain rejection')
    face.onRestore('ghost')
    await vi.waitFor(() => {
      expect(store.getSnapshot().restore).toEqual({ status: 'failed', id: 'ghost', message: 'plain rejection' })
    })
  })

  it('connection/reset drops in-flight work, resets the store, and re-reads against the new connection', async () => {
    const api = fakeApi()
    const { ctx } = await bench(api)
    const { face, store } = faceOf(ctx)

    face.onRefresh()
    await vi.waitFor(() => { expect(store.getSnapshot().list).toBe('loaded') })
    face.onSelect('aaa')
    await vi.waitFor(() => { expect(store.getSnapshot().detail.status).toBe('loaded') })

    const staleList = deferred<TimeMachineRpcResult<TimeMachineListResponse>>()
    const freshList = deferred<TimeMachineRpcResult<TimeMachineListResponse>>()
    const staleRestore = deferred<TimeMachineRpcResult<RestoreResult>>()
    api.list.mockReturnValueOnce(staleList.promise).mockReturnValueOnce(freshList.promise)
    api.restore.mockReturnValueOnce(staleRestore.promise)
    face.onRefresh()
    face.onRestore('aaa')
    ctx.emit('connection/reset')
    expect(store.getSnapshot().list).toBe('loading')
    expect(store.getSnapshot().detail).toEqual({ status: 'idle' })
    staleList.resolve(rpcOk({ generations: [], unreadable: [] }))
    staleRestore.resolve(rpcOk({ id: 'aaa', restored: true, changes: ['wrote package.json'] }))
    await Promise.resolve()
    await Promise.resolve()
    // Neither the old connection's roster read nor its restore answer publishes.
    expect(store.getSnapshot().list).toBe('loading')
    expect(store.getSnapshot().restore).toEqual({ status: 'idle' })
    // The reset's own re-read does.
    freshList.resolve(rpcOk({ generations: [], unreadable: [] }))
    await vi.waitFor(() => { expect(store.getSnapshot().list).toBe('loaded') })
    expect(store.getSnapshot().generations).toEqual([])
    // Reset re-read plus the two scripted reads: one stale, one fresh.
    expect(api.list).toHaveBeenCalledTimes(3)
  })

  it('connection/reset before the entry materializes is a no-op', async () => {
    const api = fakeApi()
    const { ctx } = await bench(api)
    ctx.emit('connection/reset')
    await Promise.resolve()
    expect(api.list).not.toHaveBeenCalled()
  })

  it('stale rejections after connection/reset publish nothing', async () => {
    const api = fakeApi()
    const { ctx } = await bench(api)
    const { face, store } = faceOf(ctx)

    const staleList = deferred<TimeMachineRpcResult<TimeMachineListResponse>>()
    const freshList = deferred<TimeMachineRpcResult<TimeMachineListResponse>>()
    const staleRestore = deferred<TimeMachineRpcResult<RestoreResult>>()
    api.list.mockReturnValueOnce(staleList.promise).mockReturnValueOnce(freshList.promise)
    api.restore.mockReturnValueOnce(staleRestore.promise)
    face.onRefresh()
    face.onRestore('aaa')
    ctx.emit('connection/reset')
    staleList.reject(new Error('old socket closed'))
    staleRestore.reject(new Error('old socket closed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().list).toBe('loading')
    expect(store.getSnapshot().listError).toBeUndefined()
    expect(store.getSnapshot().restore).toEqual({ status: 'idle' })
    freshList.resolve(rpcOk({ generations: [SUMMARY], unreadable: [] }))
    await vi.waitFor(() => { expect(store.getSnapshot().list).toBe('loaded') })
  })
})
