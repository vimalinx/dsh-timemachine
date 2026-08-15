/**
 * Panel store machine and view mappings: every roster/detail/restore branch,
 * selection retracting a pending restore, reset returning to the initial
 * snapshot, and the pure helpers (id prefix, status key, timestamp, restore
 * target list).
 */
import { describe, expect, it } from 'vitest'
import type { GenerationSummary } from '../src/rpc.ts'
import type { ConfigGeneration } from '../src/types.ts'
import { createHeaderActionsStore, createTimeMachineStore } from '../src/client/store.ts'
import {
  DEFAULT_SHORTCUTS,
  diffFileKey,
  formatTimestamp,
  isCollapsedMarker,
  isEditableTarget,
  normalizeShortcut,
  originKey,
  restoreTargets,
  shortGenerationId,
  shortcutFromEvent,
  summaryStatusKey,
} from '../src/client/views.ts'

function summary(overrides: Partial<GenerationSummary> = {}): GenerationSummary {
  return {
    id: 'abcdef0123456789',
    scope: 'full',
    origin: 'boot',
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

describe('createTimeMachineStore', () => {
  it('starts idle and only the first read shows loading', () => {
    const store = createTimeMachineStore().create()
    expect(store.getSnapshot().list).toBe('idle')
    store.actions.listBegin()
    expect(store.getSnapshot().list).toBe('loading')
    // A re-read over a loaded roster keeps the rows' phase instead of flickering.
    store.actions.listLoaded([summary()], [])
    store.actions.listBegin()
    expect(store.getSnapshot().list).toBe('loaded')
  })

  it('listLoaded publishes rows and unreadable records and clears a previous error', () => {
    const store = createTimeMachineStore().create()
    store.actions.listFailed('boom')
    store.actions.listLoaded([summary()], [{ path: '/records/xyz.json', reason: 'bad format' }])
    const state = store.getSnapshot()
    expect(state.list).toBe('loaded')
    expect(state.listError).toBeUndefined()
    expect(state.generations).toHaveLength(1)
    expect(state.unreadable).toEqual([{ path: '/records/xyz.json', reason: 'bad format' }])
  })

  it('listAbsent clears rows without an error', () => {
    const store = createTimeMachineStore().create()
    store.actions.listLoaded([summary()], [{ path: '/records/xyz.json', reason: 'bad format' }])
    store.actions.listAbsent()
    const state = store.getSnapshot()
    expect(state.list).toBe('absent')
    expect(state.generations).toEqual([])
    expect(state.unreadable).toEqual([])
    expect(state.listError).toBeUndefined()
  })

  it('listFailed keeps the previously shown rows and records the message', () => {
    const store = createTimeMachineStore().create()
    store.actions.listLoaded([summary()], [])
    store.actions.listFailed('connection refused')
    const state = store.getSnapshot()
    expect(state.list).toBe('failed')
    expect(state.listError).toBe('connection refused')
    expect(state.generations).toHaveLength(1)
  })

  it('select opens a loading detail and retracts a pending restore of the previous row', () => {
    const store = createTimeMachineStore().create()
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
    const store = createTimeMachineStore().create()
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
    const store = createTimeMachineStore().create()
    store.actions.select('aaa')
    store.actions.detailFailed('aaa', 'timemachine-not-found: nope')
    expect(store.getSnapshot().detail).toEqual({
      status: 'failed',
      id: 'aaa',
      message: 'timemachine-not-found: nope',
    })
  })

  it('the restore machine: confirm → working → done clears the confirmation', () => {
    const store = createTimeMachineStore().create()
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
    const store = createTimeMachineStore().create()
    store.actions.confirmRestore('aaa')
    store.actions.restoreWorking('aaa')
    store.actions.restoreFailed('aaa', 'timemachine-not-found: nope')
    const state = store.getSnapshot()
    expect(state.confirmId).toBeUndefined()
    expect(state.restore).toEqual({ status: 'failed', id: 'aaa', message: 'timemachine-not-found: nope' })
  })

  it('cancelRestore closes the confirmation without touching the detail', () => {
    const store = createTimeMachineStore().create()
    store.actions.select('aaa')
    store.actions.confirmRestore('aaa')
    store.actions.cancelRestore()
    const state = store.getSnapshot()
    expect(state.confirmId).toBeUndefined()
    expect(state.selectedId).toBe('aaa')
  })

  it('reset returns every field to the initial snapshot', () => {
    const store = createTimeMachineStore().create()
    store.actions.listLoaded([summary()], [{ path: '/x', reason: 'bad' }])
    store.actions.select('aaa')
    store.actions.detailLoaded(generation())
    store.actions.confirmRestore('aaa')
    store.actions.statusLoaded({ canUndo: true, canRedo: false, total: 1, lastBootFailed: true })
    store.actions.diffLoaded([])
    store.actions.confirmRemove('aaa')
    store.actions.snapshotDone('abc')
    store.actions.settingsLoaded({ autoSave: true, debounceMs: 1500, retention: 50, shortcuts: { undo: 'Ctrl+Alt+Z', redo: 'Ctrl+Alt+Y' } })
    store.actions.archiveWorking('export')
    store.actions.pruneDone(['aaa'])
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
      status: undefined,
      diff: { status: 'idle' },
      confirmRemoveId: undefined,
      remove: { status: 'idle' },
      snapshot: { status: 'idle' },
      settings: { status: 'idle' },
      archive: { status: 'idle' },
      prune: { status: 'idle' },
    })
  })

  it('statusLoaded publishes the poll', () => {
    const store = createTimeMachineStore().create()
    store.actions.statusLoaded({ canUndo: false, canRedo: true, total: 4, lastBootFailed: true })
    expect(store.getSnapshot().status).toEqual({ canUndo: false, canRedo: true, total: 4, lastBootFailed: true })
  })

  it('the diff machine: begin → loaded/failed, close returns to idle', () => {
    const store = createTimeMachineStore().create()
    store.actions.diffBegin()
    expect(store.getSnapshot().diff).toEqual({ status: 'loading' })
    const diffs = [{ file: 'manifest' as const, hunks: [{ type: 'add' as const, text: '+x' }] }]
    store.actions.diffLoaded(diffs)
    expect(store.getSnapshot().diff).toEqual({ status: 'loaded', diffs })
    store.actions.closeDiff()
    expect(store.getSnapshot().diff).toEqual({ status: 'idle' })
    store.actions.diffBegin()
    store.actions.diffFailed('boom')
    expect(store.getSnapshot().diff).toEqual({ status: 'failed', message: 'boom' })
  })

  it('the remove machine: confirm → working → done clears the confirmation', () => {
    const store = createTimeMachineStore().create()
    store.actions.confirmRemove('aaa')
    expect(store.getSnapshot().confirmRemoveId).toBe('aaa')
    store.actions.cancelRemove()
    expect(store.getSnapshot().confirmRemoveId).toBeUndefined()
    store.actions.confirmRemove('aaa')
    store.actions.removeWorking('aaa')
    store.actions.removeDone('aaa', { removed: false, refusal: 'last good' })
    const state = store.getSnapshot()
    expect(state.confirmRemoveId).toBeUndefined()
    expect(state.remove).toEqual({ status: 'done', id: 'aaa', result: { removed: false, refusal: 'last good' } })
    store.actions.dismissRemove()
    expect(store.getSnapshot().remove).toEqual({ status: 'idle' })
  })

  it('a successful remove of the selected row closes its detail; a refusal keeps it', () => {
    const store = createTimeMachineStore().create()
    store.actions.select('aaa')
    store.actions.detailLoaded(generation())
    store.actions.removeDone('aaa', { removed: true })
    expect(store.getSnapshot().selectedId).toBeUndefined()
    expect(store.getSnapshot().detail).toEqual({ status: 'idle' })

    store.actions.select('bbb')
    store.actions.detailLoaded(generation({ id: 'bbb' }))
    store.actions.removeDone('bbb', { removed: false, refusal: 'booted' })
    expect(store.getSnapshot().selectedId).toBe('bbb')
  })

  it('the snapshot machine: working → done/failed, dismiss returns to idle', () => {
    const store = createTimeMachineStore().create()
    store.actions.snapshotWorking()
    expect(store.getSnapshot().snapshot).toEqual({ status: 'working' })
    store.actions.snapshotDone('abc')
    expect(store.getSnapshot().snapshot).toEqual({ status: 'done', id: 'abc' })
    store.actions.dismissSnapshot()
    store.actions.snapshotFailed('boom')
    expect(store.getSnapshot().snapshot).toEqual({ status: 'failed', message: 'boom' })
  })

  it('the settings machine: load, save keeps the form, save failure keeps the settings', () => {
    const store = createTimeMachineStore().create()
    const settings = { autoSave: true, debounceMs: 1500, retention: 50, shortcuts: { undo: 'Ctrl+Alt+Z', redo: 'Ctrl+Alt+Y' } }
    store.actions.settingsBegin()
    expect(store.getSnapshot().settings).toEqual({ status: 'loading' })
    store.actions.settingsLoaded(settings)
    expect(store.getSnapshot().settings).toEqual({ status: 'loaded', settings, saving: false })
    // A re-read over a loaded form does not bounce it back to loading.
    store.actions.settingsBegin()
    expect(store.getSnapshot().settings.status).toBe('loaded')
    store.actions.settingsSaving()
    expect(store.getSnapshot().settings).toMatchObject({ saving: true })
    store.actions.settingsSaveFailed('bad-request: bad patch')
    expect(store.getSnapshot().settings).toEqual({ status: 'loaded', settings, saving: false, error: 'bad-request: bad patch' })
    store.actions.settingsFailed('gone')
    expect(store.getSnapshot().settings).toEqual({ status: 'failed', message: 'gone' })
  })

  it('the archive machine: working → done/failed per direction, dismiss returns to idle', () => {
    const store = createTimeMachineStore().create()
    store.actions.archiveWorking('export')
    expect(store.getSnapshot().archive).toEqual({ status: 'working', direction: 'export' })
    store.actions.archiveDone('export')
    expect(store.getSnapshot().archive).toEqual({ status: 'done', direction: 'export', imported: undefined, skipped: undefined })
    store.actions.dismissArchive()
    expect(store.getSnapshot().archive).toEqual({ status: 'idle' })
    store.actions.archiveDone('import', 2, 3)
    expect(store.getSnapshot().archive).toEqual({ status: 'done', direction: 'import', imported: 2, skipped: 3 })
    store.actions.archiveFailed('import', 'bad archive')
    expect(store.getSnapshot().archive).toEqual({ status: 'failed', direction: 'import', message: 'bad archive' })
  })

  it('the prune machine: working → done closes a pruned row\'s detail, dismiss returns to idle', () => {
    const store = createTimeMachineStore().create()
    store.actions.select('aaa')
    store.actions.detailLoaded(generation({ id: 'aaa' }))
    store.actions.pruneWorking()
    expect(store.getSnapshot().prune).toEqual({ status: 'working' })
    store.actions.pruneDone(['aaa', 'bbb'])
    const state = store.getSnapshot()
    expect(state.prune).toEqual({ status: 'done', removed: ['aaa', 'bbb'] })
    // A pruned row's record is gone with it; the strip stays at roster level.
    expect(state.selectedId).toBeUndefined()
    expect(state.detail).toEqual({ status: 'idle' })
    store.actions.dismissPrune()
    expect(store.getSnapshot().prune).toEqual({ status: 'idle' })
    store.actions.pruneFailed('boom')
    expect(store.getSnapshot().prune).toEqual({ status: 'failed', message: 'boom' })
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

  it('originKey maps every origin to its badge label', () => {
    expect(originKey('boot')).toBe('origin.boot')
    expect(originKey('auto')).toBe('origin.auto')
    expect(originKey('manual')).toBe('origin.manual')
    expect(originKey('regret')).toBe('origin.regret')
  })

  it('diffFileKey maps every compared file to its heading', () => {
    expect(diffFileKey('manifest')).toBe('diff.file.manifest')
    expect(diffFileKey('profilePatch')).toBe('diff.file.profilePatch')
    expect(diffFileKey('homePatch')).toBe('diff.file.homePatch')
    expect(diffFileKey('render')).toBe('diff.file.render')
  })

  it('isCollapsedMarker recognizes only the host diff marker', () => {
    expect(isCollapsedMarker('… (4 unchanged lines)')).toBe(true)
    expect(isCollapsedMarker('… (1 unchanged lines)')).toBe(true)
    expect(isCollapsedMarker('ordinary context')).toBe(false)
    expect(isCollapsedMarker('… (x unchanged lines)')).toBe(false)
  })

  it('normalizeShortcut canonicalizes modifier order, aliases, and case', () => {
    expect(normalizeShortcut('alt+ctrl+z')).toBe('Ctrl+Alt+Z')
    expect(normalizeShortcut('Ctrl+Alt+Z')).toBe('Ctrl+Alt+Z')
    expect(normalizeShortcut('control+shift+f9')).toBe('Ctrl+Shift+F9')
    expect(normalizeShortcut('Cmd+P')).toBe('Meta+P')
    expect(normalizeShortcut(DEFAULT_SHORTCUTS.undo)).toBe('Ctrl+Alt+Z')
    expect(normalizeShortcut(DEFAULT_SHORTCUTS.redo)).toBe('Ctrl+Alt+Y')
  })

  it('shortcutFromEvent reduces an event to the canonical combination', () => {
    const event = (init: Record<string, unknown>) => init as unknown as KeyboardEvent
    expect(shortcutFromEvent(event({ key: 'z', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+Z')
    expect(shortcutFromEvent(event({ key: 'Y', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+Y')
    // A pure modifier press normalizes to the modifiers alone.
    expect(shortcutFromEvent(event({ key: 'Control', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt')
    expect(shortcutFromEvent(event({ key: 'F9', metaKey: true }))).toBe('Meta+F9')
  })

  it('isEditableTarget guards inputs, textareas, selects, and contentEditable', () => {
    const target = (shape: Record<string, unknown>) => shape as unknown as EventTarget
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(target({ tagName: 'INPUT' }))).toBe(true)
    expect(isEditableTarget(target({ tagName: 'TEXTAREA' }))).toBe(true)
    expect(isEditableTarget(target({ tagName: 'SELECT' }))).toBe(true)
    expect(isEditableTarget(target({ tagName: 'DIV', isContentEditable: true }))).toBe(true)
    expect(isEditableTarget(target({ tagName: 'DIV', isContentEditable: false }))).toBe(false)
    // A non-element target (window, a plain event source) is not editable.
    expect(isEditableTarget(target({}))).toBe(false)
  })
})

describe('createHeaderActionsStore', () => {
  it('runs the stack confirmation machine', () => {
    const store = createHeaderActionsStore().create()
    store.actions.statusLoaded({ canUndo: true, canRedo: false, total: 1, lastBootFailed: false })
    expect(store.getSnapshot().status?.canUndo).toBe(true)
    store.actions.confirmStack('undo')
    expect(store.getSnapshot().confirm).toBe('undo')
    store.actions.cancelStack()
    expect(store.getSnapshot().confirm).toBeUndefined()
    store.actions.confirmStack('redo')
    store.actions.stackWorking('redo')
    store.actions.stackDone('redo', { changed: false, empty: 'nothing-to-redo' })
    expect(store.getSnapshot().confirm).toBeUndefined()
    expect(store.getSnapshot().stack).toEqual({ status: 'done', direction: 'redo', result: { changed: false, empty: 'nothing-to-redo' } })
    store.actions.dismissStack()
    expect(store.getSnapshot().stack).toEqual({ status: 'idle' })
    store.actions.stackFailed('undo', 'boom')
    expect(store.getSnapshot().stack).toEqual({ status: 'failed', direction: 'undo', message: 'boom' })
  })

  it('runs the snapshot popover machine and reset restores the initial snapshot', () => {
    const store = createHeaderActionsStore().create()
    store.actions.openSnapshot()
    expect(store.getSnapshot().snapshotOpen).toBe(true)
    store.actions.closeSnapshot()
    expect(store.getSnapshot().snapshotOpen).toBe(false)
    store.actions.openSnapshot()
    store.actions.snapshotWorking()
    store.actions.snapshotDone('abc')
    expect(store.getSnapshot().snapshotOpen).toBe(false)
    expect(store.getSnapshot().snapshot).toEqual({ status: 'done', id: 'abc' })
    store.actions.snapshotFailed('boom')
    expect(store.getSnapshot().snapshot).toEqual({ status: 'failed', message: 'boom' })
    store.actions.dismissSnapshot()
    expect(store.getSnapshot().snapshot).toEqual({ status: 'idle' })
    store.actions.reset()
    expect(store.getSnapshot()).toEqual({
      status: undefined,
      confirm: undefined,
      stack: { status: 'idle' },
      snapshotOpen: false,
      snapshot: { status: 'idle' },
    })
  })
})
