/**
 * Panel store machine and view mappings: every roster/detail/restore branch,
 * selection retracting a pending restore, reset returning to the initial
 * snapshot, and the pure helpers (id prefix, status key, timestamp, restore
 * target list).
 */
import { describe, expect, it } from 'vitest'
import type { GenerationSummary } from '../src/rpc.ts'
import type { ConfigGeneration } from '../src/types.ts'
import { createConfigGenerationsStore } from '../src/client/store.ts'
import { formatTimestamp, restoreTargets, shortGenerationId, summaryStatusKey } from '../src/client/views.ts'

function summary(overrides: Partial<GenerationSummary> = {}): GenerationSummary {
  return {
    id: 'abcdef0123456789',
    scope: 'full',
    recordedAt: '2026-08-01T08:00:00',
    lastSeenAt: '2026-08-02T09:30:00',
    bundleCount: 2,
    lastGood: false,
    booted: false,
    ...overrides,
  }
}

function generation(overrides: Partial<ConfigGeneration> = {}): ConfigGeneration {
  return {
    formatVersion: 1,
    id: 'abcdef0123456789',
    scope: 'full',
    recordedAt: '2026-08-01T08:00:00',
    lastSeenAt: '2026-08-02T09:30:00',
    profile: 'web',
    inputs: { manifest: '{}', profilePatch: 'patch: yes', homePatch: null },
    environment: {
      settings: { path: '/home/u/.dsh/settings.yml', text: null },
      presets: [{ id: 'mine', path: '/home/u/.dsh/.agent-presets/mine/cordis.yml', text: '[]' }],
    },
    bundles: [{ name: '@deepseek-ai/dsh-bundle-base', version: '0.1.0-rc.5' }],
    composed: { digest: 'digest', render: 'plugins: []' },
    outcomes: [],
    ...overrides,
  }
}

describe('createConfigGenerationsStore', () => {
  it('starts idle and only the first read shows loading', () => {
    const store = createConfigGenerationsStore().create()
    expect(store.getSnapshot().list).toBe('idle')
    store.actions.listBegin()
    expect(store.getSnapshot().list).toBe('loading')
    // A re-read over a loaded roster keeps the rows' phase instead of flickering.
    store.actions.listLoaded([summary()], [])
    store.actions.listBegin()
    expect(store.getSnapshot().list).toBe('loaded')
  })

  it('listLoaded publishes rows and unreadable records and clears a previous error', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.listFailed('boom')
    store.actions.listLoaded([summary()], [{ path: '/records/xyz.json', reason: 'bad format' }])
    const state = store.getSnapshot()
    expect(state.list).toBe('loaded')
    expect(state.listError).toBeUndefined()
    expect(state.generations).toHaveLength(1)
    expect(state.unreadable).toEqual([{ path: '/records/xyz.json', reason: 'bad format' }])
  })

  it('listAbsent clears rows without an error', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.listLoaded([summary()], [{ path: '/records/xyz.json', reason: 'bad format' }])
    store.actions.listAbsent()
    const state = store.getSnapshot()
    expect(state.list).toBe('absent')
    expect(state.generations).toEqual([])
    expect(state.unreadable).toEqual([])
    expect(state.listError).toBeUndefined()
  })

  it('listFailed keeps the previously shown rows and records the message', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.listLoaded([summary()], [])
    store.actions.listFailed('connection refused')
    const state = store.getSnapshot()
    expect(state.list).toBe('failed')
    expect(state.listError).toBe('connection refused')
    expect(state.generations).toHaveLength(1)
  })

  it('select opens a loading detail and retracts a pending restore of the previous row', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.select('aaa')
    expect(store.getSnapshot().detail).toEqual({ status: 'loading', id: 'aaa' })
    store.actions.detailLoaded(generation())
    store.actions.confirmRestore('abcdef0123456789')
    store.actions.select('bbb')
    const state = store.getSnapshot()
    expect(state.selectedId).toBe('bbb')
    expect(state.detail).toEqual({ status: 'loading', id: 'bbb' })
    expect(state.confirmId).toBeUndefined()
    expect(state.restore).toEqual({ status: 'idle' })
  })

  it('closeDetail collapses the detail and any pending restore', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.select('aaa')
    store.actions.detailLoaded(generation())
    store.actions.confirmRestore('abcdef0123456789')
    store.actions.closeDetail()
    const state = store.getSnapshot()
    expect(state.selectedId).toBeUndefined()
    expect(state.detail).toEqual({ status: 'idle' })
    expect(state.confirmId).toBeUndefined()
  })

  it('detailFailed records the message against the queried id', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.select('aaa')
    store.actions.detailFailed('aaa', 'config-generation-not-found: nope')
    expect(store.getSnapshot().detail).toEqual({
      status: 'failed',
      id: 'aaa',
      message: 'config-generation-not-found: nope',
    })
  })

  it('the restore machine: confirm → working → done clears the confirmation', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.select('aaa')
    store.actions.detailLoaded(generation())
    store.actions.confirmRestore('abcdef0123456789')
    expect(store.getSnapshot().confirmId).toBe('abcdef0123456789')
    store.actions.restoreWorking('abcdef0123456789')
    expect(store.getSnapshot().restore).toEqual({ status: 'working', id: 'abcdef0123456789' })
    const result = { id: 'abcdef0123456789', restored: true, changes: ['wrote package.json'] }
    store.actions.restoreDone(result)
    const state = store.getSnapshot()
    expect(state.confirmId).toBeUndefined()
    expect(state.restore).toEqual({ status: 'done', result })
    store.actions.dismissRestore()
    expect(store.getSnapshot().restore).toEqual({ status: 'idle' })
  })

  it('restoreFailed clears the confirmation and keeps the message', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.confirmRestore('aaa')
    store.actions.restoreWorking('aaa')
    store.actions.restoreFailed('aaa', 'config-generation-not-found: nope')
    const state = store.getSnapshot()
    expect(state.confirmId).toBeUndefined()
    expect(state.restore).toEqual({ status: 'failed', id: 'aaa', message: 'config-generation-not-found: nope' })
  })

  it('cancelRestore closes the confirmation without touching the detail', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.select('aaa')
    store.actions.confirmRestore('aaa')
    store.actions.cancelRestore()
    const state = store.getSnapshot()
    expect(state.confirmId).toBeUndefined()
    expect(state.selectedId).toBe('aaa')
  })

  it('reset returns every field to the initial snapshot', () => {
    const store = createConfigGenerationsStore().create()
    store.actions.listLoaded([summary()], [{ path: '/x', reason: 'bad' }])
    store.actions.select('aaa')
    store.actions.detailLoaded(generation())
    store.actions.confirmRestore('aaa')
    store.actions.reset()
    expect(store.getSnapshot()).toEqual({
      list: 'idle',
      listError: undefined,
      generations: [],
      unreadable: [],
      selectedId: undefined,
      detail: { status: 'idle' },
      confirmId: undefined,
      restore: { status: 'idle' },
    })
  })
})

describe('view mappings', () => {
  it('shortGenerationId keeps an 8-character prefix', () => {
    expect(shortGenerationId('abcdef0123456789')).toBe('abcdef01')
  })

  it('summaryStatusKey maps the latest outcome, defaulting to never-booted', () => {
    expect(summaryStatusKey(summary({ latestStatus: 'activated' }))).toBe('status.activated')
    expect(summaryStatusKey(summary({ latestStatus: 'failed' }))).toBe('status.failed')
    expect(summaryStatusKey(summary())).toBe('status.never')
  })

  it('formatTimestamp renders second-precision local time and keeps unparseable input verbatim', () => {
    const time = new Date(2026, 7, 14, 9, 5, 3)
    expect(formatTimestamp(time.toISOString())).toBe('2026-08-14 09:05:03')
    expect(formatTimestamp('not-a-date')).toBe('not-a-date')
  })

  it('restoreTargets mirrors the host write list: manifest always, patch and presets when recorded', () => {
    expect(restoreTargets(generation())).toEqual([
      'package.json',
      'cordis.patch.yml',
      '/home/u/.dsh/.agent-presets/mine/cordis.yml',
    ])
  })

  it('restoreTargets drops the patch when the record has none and lists nothing for a composition-scope record', () => {
    expect(restoreTargets(generation({
      inputs: { manifest: '{}', profilePatch: null, homePatch: null },
      environment: null,
    }))).toEqual(['package.json'])
  })
})
