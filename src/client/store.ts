/**
 * The configuration-generation panel's store: roster read state, the selected
 * generation's detail, and the restore confirmation/result machine. The panel
 * is a frame-wide surface registered once into `sidebar.footer.action`, so one
 * root-scope instance carries everything; the apply closure drives it through
 * the baked actions the inject factory receives (RPC results never touch a
 * component).
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { GenerationSummary, TimeMachineRemoveResponse } from '../rpc.ts'
import type {
  ConfigGeneration,
  RestoreResult,
  StackRestoreResult,
  TimemachineSettings,
  TimemachineStatus,
  UnreadableGeneration,
} from '../types.ts'
import type { InputDiff } from '../diff.ts'

/** Roster read phase. `absent` is the host's `timemachine-absent` answer, not a failure. */
export type ListStatus = 'idle' | 'loading' | 'loaded' | 'absent' | 'failed'

/** Selected generation's detail read. */
export type DetailState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly id: string }
  | { readonly status: 'loaded'; readonly generation: ConfigGeneration }
  | { readonly status: 'failed'; readonly id: string; readonly message: string }

/**
 * Restore attempt state. `done` carries the business result verbatim — a
 * refusal (`restored: false` with `refusal`/`verdict`) is a normal outcome,
 * not an RPC error; only an unresolvable id or a transport failure lands in
 * `failed`.
 */
export type RestoreState =
  | { readonly status: 'idle' }
  | { readonly status: 'working'; readonly id: string }
  | { readonly status: 'done'; readonly result: RestoreResult }
  | { readonly status: 'failed'; readonly id: string; readonly message: string }

/** The selected generation's diff against the live configuration. */
export type DiffState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly diffs: InputDiff[] }
  | { readonly status: 'failed'; readonly message: string }

/**
 * Remove attempt state. A refusal (`removed: false` with `refusal`) rides the
 * ok branch like a restore refusal does; only an unresolvable id or a
 * transport failure lands in `failed`.
 */
export type RemoveState =
  | { readonly status: 'idle' }
  | { readonly status: 'working'; readonly id: string }
  | { readonly status: 'done'; readonly id: string; readonly result: TimeMachineRemoveResponse }
  | { readonly status: 'failed'; readonly id: string; readonly message: string }

/** A manual snapshot attempt (no request-side id; the record is the answer). */
export type SnapshotState =
  | { readonly status: 'idle' }
  | { readonly status: 'working' }
  | { readonly status: 'done'; readonly id: string }
  | { readonly status: 'failed'; readonly message: string }

/** The plugin settings read (`updateSettings` answers publish through `loaded`). */
export type SettingsState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly settings: TimemachineSettings; readonly saving: boolean; readonly error?: string | undefined }
  | { readonly status: 'failed'; readonly message: string }

/** An export/import attempt; `done` carries the import tally when importing. */
export type ArchiveState =
  | { readonly status: 'idle' }
  | { readonly status: 'working'; readonly direction: 'export' | 'import' }
  | { readonly status: 'done'; readonly direction: 'export' | 'import'; readonly imported?: number | undefined; readonly skipped?: number | undefined }
  | { readonly status: 'failed'; readonly direction: 'export' | 'import'; readonly message: string }

/** A prune attempt; `done` carries the removed generations' ids (possibly none). */
export type PruneState =
  | { readonly status: 'idle' }
  | { readonly status: 'working' }
  | { readonly status: 'done'; readonly removed: string[] }
  | { readonly status: 'failed'; readonly message: string }

/** One undo/redo attempt, for the header action's outcome strip. */
export type StackState =
  | { readonly status: 'idle' }
  | { readonly status: 'working'; readonly direction: 'undo' | 'redo' }
  | { readonly status: 'done'; readonly direction: 'undo' | 'redo'; readonly result: StackRestoreResult }
  | { readonly status: 'failed'; readonly direction: 'undo' | 'redo'; readonly message: string }

/** Panel state. */
export interface TimeMachineState {
  /** Roster read phase. */
  list: ListStatus
  /** Last roster read failure; kept beside the rows it failed to refresh. */
  listError: string | undefined
  /** The roster as last read, oldest `lastSeenAt` first. */
  generations: GenerationSummary[]
  /** Records the reader rejected, flagged rather than hidden. */
  unreadable: UnreadableGeneration[]
  /** The expanded row's id; `undefined` collapses the detail region. */
  selectedId: string | undefined
  /** The selected row's detail read. */
  detail: DetailState
  /** The generation a restore confirmation is open for. */
  confirmId: string | undefined
  /** The restore attempt. */
  restore: RestoreState
  /** Latest status poll (drives the boot-failure banner); absent until one answers. */
  status: TimemachineStatus | undefined
  /** The selected row's diff against the live configuration. */
  diff: DiffState
  /** The generation a remove confirmation is open for. */
  confirmRemoveId: string | undefined
  /** The remove attempt. */
  remove: RemoveState
  /** The manual snapshot attempt. */
  snapshot: SnapshotState
  /** The settings read/save. */
  settings: SettingsState
  /** The export/import attempt. */
  archive: ArchiveState
  /** The prune attempt. */
  prune: PruneState
}

/** Declared action shape giving the exported factory a stable return type. */
type TimeMachineActions = {
  listBegin: (draft: TimeMachineState) => void
  listLoaded: (draft: TimeMachineState, generations: GenerationSummary[], unreadable: UnreadableGeneration[]) => void
  listAbsent: (draft: TimeMachineState) => void
  listFailed: (draft: TimeMachineState, message: string) => void
  select: (draft: TimeMachineState, id: string) => void
  closeDetail: (draft: TimeMachineState) => void
  detailLoaded: (draft: TimeMachineState, generation: ConfigGeneration) => void
  detailFailed: (draft: TimeMachineState, id: string, message: string) => void
  confirmRestore: (draft: TimeMachineState, id: string) => void
  cancelRestore: (draft: TimeMachineState) => void
  restoreWorking: (draft: TimeMachineState, id: string) => void
  restoreDone: (draft: TimeMachineState, result: RestoreResult) => void
  restoreFailed: (draft: TimeMachineState, id: string, message: string) => void
  dismissRestore: (draft: TimeMachineState) => void
  statusLoaded: (draft: TimeMachineState, status: TimemachineStatus) => void
  diffBegin: (draft: TimeMachineState) => void
  diffLoaded: (draft: TimeMachineState, diffs: InputDiff[]) => void
  diffFailed: (draft: TimeMachineState, message: string) => void
  closeDiff: (draft: TimeMachineState) => void
  confirmRemove: (draft: TimeMachineState, id: string) => void
  cancelRemove: (draft: TimeMachineState) => void
  removeWorking: (draft: TimeMachineState, id: string) => void
  removeDone: (draft: TimeMachineState, id: string, result: TimeMachineRemoveResponse) => void
  removeFailed: (draft: TimeMachineState, id: string, message: string) => void
  dismissRemove: (draft: TimeMachineState) => void
  snapshotWorking: (draft: TimeMachineState) => void
  snapshotDone: (draft: TimeMachineState, id: string) => void
  snapshotFailed: (draft: TimeMachineState, message: string) => void
  dismissSnapshot: (draft: TimeMachineState) => void
  settingsBegin: (draft: TimeMachineState) => void
  settingsLoaded: (draft: TimeMachineState, settings: TimemachineSettings) => void
  settingsFailed: (draft: TimeMachineState, message: string) => void
  settingsSaving: (draft: TimeMachineState) => void
  settingsSaveFailed: (draft: TimeMachineState, message: string) => void
  archiveWorking: (draft: TimeMachineState, direction: 'export' | 'import') => void
  archiveDone: (draft: TimeMachineState, direction: 'export' | 'import', imported?: number, skipped?: number) => void
  archiveFailed: (draft: TimeMachineState, direction: 'export' | 'import', message: string) => void
  dismissArchive: (draft: TimeMachineState) => void
  pruneWorking: (draft: TimeMachineState) => void
  pruneDone: (draft: TimeMachineState, removed: string[]) => void
  pruneFailed: (draft: TimeMachineState, message: string) => void
  dismissPrune: (draft: TimeMachineState) => void
  reset: (draft: TimeMachineState) => void
}

/** The panel store handle type, consumed type-only by the component's props. */
export type TimeMachineStore = EngineStoreHandle<TimeMachineState, TimeMachineActions>

function initialState(): TimeMachineState {
  return {
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
  }
}

/**
 * Declare the panel store.
 * @returns the store handle (the framework or a spec calls `.create()`).
 */
export function createTimeMachineStore(): TimeMachineStore {
  return defineStore({
    init: initialState,
    actions: {
      // A re-read keeps the current rows visible; only the very first read
      // shows the loading note.
      listBegin: (d) => {
        if (d.list === 'idle') d.list = 'loading'
      },
      listLoaded: (d, generations, unreadable) => {
        d.list = 'loaded'
        d.listError = undefined
        d.generations = generations
        d.unreadable = unreadable
      },
      listAbsent: (d) => {
        d.list = 'absent'
        d.listError = undefined
        d.generations = []
        d.unreadable = []
      },
      // A failed re-read keeps whatever was shown and says why: dropping the
      // rows would turn a transient wire failure into "nothing is recorded".
      listFailed: (d, message) => {
        d.list = 'failed'
        d.listError = message
      },
      // Selecting another row retracts any pending restore or remove of the
      // previous one and drops its diff preview.
      select: (d, id) => {
        d.selectedId = id
        d.detail = { status: 'loading', id }
        d.confirmId = undefined
        d.restore = { status: 'idle' }
        d.diff = { status: 'idle' }
        d.confirmRemoveId = undefined
        d.remove = { status: 'idle' }
      },
      closeDetail: (d) => {
        d.selectedId = undefined
        d.detail = { status: 'idle' }
        d.confirmId = undefined
        d.restore = { status: 'idle' }
        d.diff = { status: 'idle' }
        d.confirmRemoveId = undefined
        d.remove = { status: 'idle' }
      },
      detailLoaded: (d, generation) => {
        d.detail = { status: 'loaded', generation }
      },
      detailFailed: (d, id, message) => {
        d.detail = { status: 'failed', id, message }
      },
      confirmRestore: (d, id) => {
        d.confirmId = id
        d.restore = { status: 'idle' }
      },
      cancelRestore: (d) => {
        d.confirmId = undefined
      },
      restoreWorking: (d, id) => {
        d.restore = { status: 'working', id }
      },
      restoreDone: (d, result) => {
        d.confirmId = undefined
        d.restore = { status: 'done', result }
      },
      restoreFailed: (d, id, message) => {
        d.confirmId = undefined
        d.restore = { status: 'failed', id, message }
      },
      dismissRestore: (d) => {
        d.restore = { status: 'idle' }
      },
      statusLoaded: (d, status) => {
        d.status = status
      },
      diffBegin: (d) => {
        d.diff = { status: 'loading' }
      },
      diffLoaded: (d, diffs) => {
        d.diff = { status: 'loaded', diffs }
      },
      diffFailed: (d, message) => {
        d.diff = { status: 'failed', message }
      },
      closeDiff: (d) => {
        d.diff = { status: 'idle' }
      },
      confirmRemove: (d, id) => {
        d.confirmRemoveId = id
        d.remove = { status: 'idle' }
      },
      cancelRemove: (d) => {
        d.confirmRemoveId = undefined
      },
      removeWorking: (d, id) => {
        d.remove = { status: 'working', id }
      },
      removeDone: (d, id, result) => {
        d.confirmRemoveId = undefined
        d.remove = { status: 'done', id, result }
        // A removed row's detail is gone with it; the outcome strip lives at
        // roster level, so closing the detail does not hide the answer.
        if (result.removed && d.selectedId === id) {
          d.selectedId = undefined
          d.detail = { status: 'idle' }
          d.diff = { status: 'idle' }
          d.confirmId = undefined
          d.restore = { status: 'idle' }
        }
      },
      removeFailed: (d, id, message) => {
        d.confirmRemoveId = undefined
        d.remove = { status: 'failed', id, message }
      },
      dismissRemove: (d) => {
        d.remove = { status: 'idle' }
      },
      snapshotWorking: (d) => {
        d.snapshot = { status: 'working' }
      },
      snapshotDone: (d, id) => {
        d.snapshot = { status: 'done', id }
      },
      snapshotFailed: (d, message) => {
        d.snapshot = { status: 'failed', message }
      },
      dismissSnapshot: (d) => {
        d.snapshot = { status: 'idle' }
      },
      settingsBegin: (d) => {
        if (d.settings.status !== 'loaded') d.settings = { status: 'loading' }
      },
      settingsLoaded: (d, settings) => {
        d.settings = { status: 'loaded', settings, saving: false }
      },
      settingsFailed: (d, message) => {
        d.settings = { status: 'failed', message }
      },
      settingsSaving: (d) => {
        if (d.settings.status === 'loaded') d.settings = { ...d.settings, saving: true, error: undefined }
      },
      // A failed save keeps the loaded settings — the form stays editable.
      settingsSaveFailed: (d, message) => {
        if (d.settings.status === 'loaded') d.settings = { ...d.settings, saving: false, error: message }
      },
      archiveWorking: (d, direction) => {
        d.archive = { status: 'working', direction }
      },
      archiveDone: (d, direction, imported, skipped) => {
        d.archive = { status: 'done', direction, imported, skipped }
      },
      archiveFailed: (d, direction, message) => {
        d.archive = { status: 'failed', direction, message }
      },
      dismissArchive: (d) => {
        d.archive = { status: 'idle' }
      },
      pruneWorking: (d) => {
        d.prune = { status: 'working' }
      },
      pruneDone: (d, removed) => {
        d.prune = { status: 'done', removed }
        // A pruned row's record is gone with it; like a remove, its detail
        // closes while the outcome strip stays at roster level.
        if (d.selectedId !== undefined && removed.includes(d.selectedId)) {
          d.selectedId = undefined
          d.detail = { status: 'idle' }
          d.diff = { status: 'idle' }
          d.confirmId = undefined
          d.restore = { status: 'idle' }
          d.confirmRemoveId = undefined
          d.remove = { status: 'idle' }
        }
      },
      pruneFailed: (d, message) => {
        d.prune = { status: 'failed', message }
      },
      dismissPrune: (d) => {
        d.prune = { status: 'idle' }
      },
      reset: (d) => {
        Object.assign(d, initialState())
      },
    },
  })
}

/** Header-action state: one status poll, the undo/redo flow, and the snapshot popover. */
export interface HeaderActionsState {
  /** Latest status poll; absent until one answers (buttons stay disabled). */
  status: TimemachineStatus | undefined
  /** The direction a stack confirmation is open for. */
  confirm: 'undo' | 'redo' | undefined
  /** The undo/redo attempt. */
  stack: StackState
  /** Whether the snapshot reason popover is open. */
  snapshotOpen: boolean
  /** The manual snapshot attempt. */
  snapshot: SnapshotState
}

/** Declared action shape giving the exported factory a stable return type. */
type HeaderActionsActions = {
  statusLoaded: (draft: HeaderActionsState, status: TimemachineStatus) => void
  confirmStack: (draft: HeaderActionsState, direction: 'undo' | 'redo') => void
  cancelStack: (draft: HeaderActionsState) => void
  stackWorking: (draft: HeaderActionsState, direction: 'undo' | 'redo') => void
  stackDone: (draft: HeaderActionsState, direction: 'undo' | 'redo', result: StackRestoreResult) => void
  stackFailed: (draft: HeaderActionsState, direction: 'undo' | 'redo', message: string) => void
  dismissStack: (draft: HeaderActionsState) => void
  openSnapshot: (draft: HeaderActionsState) => void
  closeSnapshot: (draft: HeaderActionsState) => void
  snapshotWorking: (draft: HeaderActionsState) => void
  snapshotDone: (draft: HeaderActionsState, id: string) => void
  snapshotFailed: (draft: HeaderActionsState, message: string) => void
  dismissSnapshot: (draft: HeaderActionsState) => void
  reset: (draft: HeaderActionsState) => void
}

/** The header store handle type, consumed type-only by the component's props. */
export type HeaderActionsStore = EngineStoreHandle<HeaderActionsState, HeaderActionsActions>

function initialHeaderState(): HeaderActionsState {
  return {
    status: undefined,
    confirm: undefined,
    stack: { status: 'idle' },
    snapshotOpen: false,
    snapshot: { status: 'idle' },
  }
}

/**
 * Declare the session-header action store. Separate from the panel store
 * because the two entries mount under different slot scopes (session vs
 * root), and one shared handle cannot span scopes.
 * @returns the store handle (the framework or a spec calls `.create()`).
 */
export function createHeaderActionsStore(): HeaderActionsStore {
  return defineStore({
    init: initialHeaderState,
    actions: {
      statusLoaded: (d, status) => {
        d.status = status
      },
      confirmStack: (d, direction) => {
        d.confirm = direction
        d.stack = { status: 'idle' }
      },
      cancelStack: (d) => {
        d.confirm = undefined
      },
      stackWorking: (d, direction) => {
        d.stack = { status: 'working', direction }
      },
      stackDone: (d, direction, result) => {
        d.confirm = undefined
        d.stack = { status: 'done', direction, result }
      },
      stackFailed: (d, direction, message) => {
        d.confirm = undefined
        d.stack = { status: 'failed', direction, message }
      },
      dismissStack: (d) => {
        d.stack = { status: 'idle' }
      },
      openSnapshot: (d) => {
        d.snapshotOpen = true
        d.snapshot = { status: 'idle' }
      },
      closeSnapshot: (d) => {
        d.snapshotOpen = false
      },
      snapshotWorking: (d) => {
        d.snapshot = { status: 'working' }
      },
      snapshotDone: (d, id) => {
        d.snapshotOpen = false
        d.snapshot = { status: 'done', id }
      },
      snapshotFailed: (d, message) => {
        d.snapshot = { status: 'failed', message }
      },
      dismissSnapshot: (d) => {
        d.snapshot = { status: 'idle' }
      },
      reset: (d) => {
        Object.assign(d, initialHeaderState())
      },
    },
  })
}
