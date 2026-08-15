/**
 * The configuration-generation panel's store: roster read state, the selected
 * generation's detail, and the restore confirmation/result machine. The panel
 * is a frame-wide surface registered once into `sidebar.footer.action`, so one
 * root-scope instance carries everything; the apply closure drives it through
 * the baked actions the inject factory receives (RPC results never touch a
 * component).
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { GenerationSummary } from '../rpc.ts'
import type { ConfigGeneration, RestoreResult, UnreadableGeneration } from '../types.ts'

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
      // Selecting another row retracts any pending restore of the previous one.
      select: (d, id) => {
        d.selectedId = id
        d.detail = { status: 'loading', id }
        d.confirmId = undefined
        d.restore = { status: 'idle' }
      },
      closeDetail: (d) => {
        d.selectedId = undefined
        d.detail = { status: 'idle' }
        d.confirmId = undefined
        d.restore = { status: 'idle' }
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
      reset: (d) => {
        Object.assign(d, initialState())
      },
    },
  })
}
