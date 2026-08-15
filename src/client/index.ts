/**
 * Configuration-generation panel plugin, browser half: one
 * `sidebar.footer.action` entry over the host's `/timemachine`
 * Connection RPC channel, plus one `conversation.session.header.actions`
 * entry (undo / redo / snapshot) and the keydown listener that matches the
 * configured shortcuts against the header entry's confirmation flow. There
 * is no event push for the history, so rosters and status are re-read on
 * open and after every operation; a reconnect drops in-flight reads and
 * starts over (the new host may hold a different history).
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-sidebar SlotMap merge (the 'sidebar.footer.action'
// declaration) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import {
  TIMEMACHINE_CHANNEL,
  type TimeMachineDiffResponse,
  type TimeMachineExportResponse,
  type TimeMachineGetSettingsResponse,
  type TimeMachineImportResponse,
  type TimeMachineListResponse,
  type TimeMachinePruneResponse,
  type TimeMachineReadResponse,
  type TimeMachineRemoveResponse,
  type TimeMachineRestoreResponse,
  type TimeMachineRpcResult,
  type TimeMachineSnapshotResponse,
  type TimeMachineStackResponse,
  type TimeMachineStatusResponse,
  type TimeMachineUpdateSettingsResponse,
} from '../rpc.ts'
import type { TimemachineSettings, TimemachineSettingsPatch } from '../types.ts'
import { HeaderActions } from './HeaderActions.tsx'
import type { TimeMachineHeaderActionsFace } from './HeaderActions.tsx'
import { TimeMachinePanel } from './TimeMachinePanel.tsx'
import type { TimeMachinePanelFace } from './TimeMachinePanel.tsx'
import { createHeaderActionsStore, createTimeMachineStore } from './store.ts'
import type { HeaderActionsStore, TimeMachineStore } from './store.ts'
import { en, NS, zh } from './locales.ts'
import { DEFAULT_SHORTCUTS, isEditableTarget, normalizeShortcut, shortcutFromEvent } from './views.ts'
import { downloadZip, exportFilename } from './download.ts'

/** Owner share of the header action row: the owner passes nothing. */
interface HeaderActionOwnerProps {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The session-header action row, declared by ui-conversation's header
     * occupant. That package is not a dependency of this plugin, so the entry
     * is redeclared here with the same shape — an empty owner interface
     * merges structurally with the real declaration in the assembled app.
     */
    'conversation.session.header.actions': { kind: 'list'; scope: 'session'; owner: HeaderActionOwnerProps }
  }
}

export type { TimeMachineStore, HeaderActionsStore } from './store.ts'
export type {
  TimeMachineState,
  DetailState,
  ListStatus,
  RestoreState,
  DiffState,
  RemoveState,
  SnapshotState,
  SettingsState,
  ArchiveState,
  PruneState,
  HeaderActionsState,
  StackState,
} from './store.ts'
export type { TimeMachinePanelFace, TimeMachinePanelProps } from './TimeMachinePanel.tsx'
export type { TimeMachineHeaderActionsFace, TimeMachineHeaderActionsProps } from './HeaderActions.tsx'
export type { TimeMachineKey } from './locales.ts'

/** Required services: slot registry, dictionary registry, and the wire client. */
export const inject = ['slots', 'locale', 'connection']

type Actions = BoundActions<TimeMachineStore>
type HeaderBound = BoundActions<HeaderActionsStore>

/** Wire error line: code plus message, so a refusal-shaped RPC error stays distinguishable. */
function rpcMessage(error: { code: string; message: string }): string {
  return `${error.code}: ${error.message}`
}

/** Thrown transport failure to a display message. */
function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Client plugin body: register the dictionaries, the footer panel, the
 * session-header actions, and the shortcut listener; re-read on reconnect.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-timemachine: dictionaries')

  const rpc = (ctx.get('connection') as unknown as ConnectionHandle).rpc
  // Narrow the carrier's `RpcResult<unknown>` to this channel's vocabulary;
  // the channel's wire contract lives in ../rpc.ts.
  const call = <T>(endpoint: string, payload: unknown): Promise<TimeMachineRpcResult<T>> =>
    rpc.call(TIMEMACHINE_CHANNEL, endpoint, payload) as Promise<TimeMachineRpcResult<T>>
  const store = createTimeMachineStore()
  const headerStore = createHeaderActionsStore()
  // The store instances are framework-made; the inject factories hand their
  // baked actions up so the connection/reset path below can drive them.
  let bound: Actions | undefined
  let headerBound: HeaderBound | undefined
  // Bumped on connection/reset: a read issued against the previous connection
  // publishes nothing.
  let epoch = 0
  // Roster reads are single-flight; a reset frees the slot for a fresh one.
  let listInFlight = false
  // Bumped on every selection change: a detail read answered after the user
  // moved on (or after a reset) publishes nothing.
  let detailEpoch = 0
  // Same guard for the diff preview of the selected row.
  let diffEpoch = 0
  // The combos the keydown listener matches, hot-swapped by settings reads.
  let undoCombo = normalizeShortcut(DEFAULT_SHORTCUTS.undo)
  let redoCombo = normalizeShortcut(DEFAULT_SHORTCUTS.redo)

  const applyShortcuts = (settings: TimemachineSettings): void => {
    undoCombo = normalizeShortcut(settings.shortcuts.undo)
    redoCombo = normalizeShortcut(settings.shortcuts.redo)
  }

  /** One status poll into the panel store; failures leave the last status in place. */
  const refreshStatus = (actions: Actions): void => {
    const issued = epoch
    void call<TimeMachineStatusResponse>('status', {}).then((result) => {
      if (issued !== epoch) return
      // A refused status read (e.g. timemachine-absent) is not roster-worthy.
      if (result.ok) actions.statusLoaded(result.value)
    }, () => {
      // A dropped status read only means the boot banner stays stale.
    })
  }

  const refresh = (actions: Actions): void => {
    refreshStatus(actions)
    if (listInFlight) return
    listInFlight = true
    const issued = epoch
    actions.listBegin()
    void call<TimeMachineListResponse>('list', {}).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        if (result.error.code === 'timemachine-absent') actions.listAbsent()
        else actions.listFailed(rpcMessage(result.error))
        return
      }
      actions.listLoaded(result.value.generations, result.value.unreadable)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.listFailed(thrownMessage(error))
    }).then(() => {
      if (issued === epoch) listInFlight = false
    })
  }

  const select = (actions: Actions, id: string): void => {
    detailEpoch += 1
    diffEpoch += 1
    const issued = detailEpoch
    actions.select(id)
    void call<TimeMachineReadResponse>('read', { id }).then((result) => {
      if (issued !== detailEpoch) return
      if (!result.ok) {
        actions.detailFailed(id, rpcMessage(result.error))
        return
      }
      actions.detailLoaded(result.value)
    }, (error: unknown) => {
      if (issued !== detailEpoch) return
      actions.detailFailed(id, thrownMessage(error))
    })
  }

  const restore = (actions: Actions, id: string): void => {
    const issued = epoch
    actions.restoreWorking(id)
    void call<TimeMachineRestoreResponse>('restore', { id }).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.restoreFailed(id, rpcMessage(result.error))
        return
      }
      actions.restoreDone(result.value)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.restoreFailed(id, thrownMessage(error))
    }).then(() => {
      if (issued !== epoch) return
      refresh(actions)
    })
  }

  const loadDiff = (actions: Actions, id: string): void => {
    diffEpoch += 1
    const issued = diffEpoch
    actions.diffBegin()
    void call<TimeMachineDiffResponse>('diff', { id }).then((result) => {
      if (issued !== diffEpoch) return
      if (!result.ok) {
        actions.diffFailed(rpcMessage(result.error))
        return
      }
      actions.diffLoaded(result.value)
    }, (error: unknown) => {
      if (issued !== diffEpoch) return
      actions.diffFailed(thrownMessage(error))
    })
  }

  const remove = (actions: Actions, id: string): void => {
    const issued = epoch
    actions.removeWorking(id)
    void call<TimeMachineRemoveResponse>('remove', { id }).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.removeFailed(id, rpcMessage(result.error))
        return
      }
      actions.removeDone(id, result.value)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.removeFailed(id, thrownMessage(error))
    }).then(() => {
      if (issued !== epoch) return
      refresh(actions)
    })
  }

  const snapshot = (actions: Actions, reason: string | undefined): void => {
    const issued = epoch
    actions.snapshotWorking()
    void call<TimeMachineSnapshotResponse>('snapshot', reason === undefined ? {} : { reason }).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.snapshotFailed(rpcMessage(result.error))
        return
      }
      actions.snapshotDone(result.value.id)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.snapshotFailed(thrownMessage(error))
    }).then(() => {
      if (issued !== epoch) return
      refresh(actions)
    })
  }

  const exportArchive = (actions: Actions): void => {
    const issued = epoch
    actions.archiveWorking('export')
    void call<TimeMachineExportResponse>('export', {}).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.archiveFailed('export', rpcMessage(result.error))
        return
      }
      try {
        downloadZip(result.value.data, exportFilename(new Date()))
      } catch (error: unknown) {
        // A browser that refuses the object-URL download surfaces as an
        // export failure rather than an unhandled rejection.
        actions.archiveFailed('export', thrownMessage(error))
        return
      }
      actions.archiveDone('export')
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.archiveFailed('export', thrownMessage(error))
    })
  }

  const importArchive = (actions: Actions, data: string): void => {
    const issued = epoch
    actions.archiveWorking('import')
    void call<TimeMachineImportResponse>('import', { data }).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.archiveFailed('import', rpcMessage(result.error))
        return
      }
      actions.archiveDone('import', result.value.imported.length, result.value.skipped.length)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.archiveFailed('import', thrownMessage(error))
    }).then(() => {
      if (issued !== epoch) return
      refresh(actions)
    })
  }

  const prune = (actions: Actions): void => {
    const issued = epoch
    actions.pruneWorking()
    void call<TimeMachinePruneResponse>('prune', {}).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.pruneFailed(rpcMessage(result.error))
        return
      }
      actions.pruneDone(result.value.removed)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.pruneFailed(thrownMessage(error))
    }).then(() => {
      if (issued !== epoch) return
      refresh(actions)
    })
  }

  const loadSettings = (actions: Actions): void => {
    const issued = epoch
    actions.settingsBegin()
    void call<TimeMachineGetSettingsResponse>('getSettings', {}).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.settingsFailed(rpcMessage(result.error))
        return
      }
      applyShortcuts(result.value)
      actions.settingsLoaded(result.value)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.settingsFailed(thrownMessage(error))
    })
  }

  const saveSettings = (actions: Actions, patch: TimemachineSettingsPatch): void => {
    const issued = epoch
    actions.settingsSaving()
    void call<TimeMachineUpdateSettingsResponse>('updateSettings', { patch }).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.settingsSaveFailed(rpcMessage(result.error))
        return
      }
      applyShortcuts(result.value)
      actions.settingsLoaded(result.value)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.settingsSaveFailed(thrownMessage(error))
    })
  }

  /**
   * Read the settings once so the shortcuts work before the panel's settings
   * section is ever opened; failures keep the defaults.
   */
  const fetchSettings = (): void => {
    const issued = epoch
    void call<TimeMachineGetSettingsResponse>('getSettings', {}).then((result) => {
      if (issued !== epoch || !result.ok) return
      applyShortcuts(result.value)
    }, () => {
      // No settings read, no custom shortcuts: the defaults stay in effect.
    })
  }

  /** One status poll into the header store; failures leave the buttons as they are. */
  const refreshHeaderStatus = (actions: HeaderBound): void => {
    const issued = epoch
    void call<TimeMachineStatusResponse>('status', {}).then((result) => {
      if (issued !== epoch || !result.ok) return
      actions.statusLoaded(result.value)
    }, () => {
      // A dropped status read only means the disabled states stay stale.
    })
  }

  const stack = (actions: HeaderBound, direction: 'undo' | 'redo'): void => {
    const issued = epoch
    actions.stackWorking(direction)
    void call<TimeMachineStackResponse>(direction, {}).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.stackFailed(direction, rpcMessage(result.error))
        return
      }
      actions.stackDone(direction, result.value)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.stackFailed(direction, thrownMessage(error))
    }).then(() => {
      if (issued !== epoch) return
      refreshHeaderStatus(actions)
      if (bound !== undefined) refresh(bound)
    })
  }

  const headerSnapshot = (actions: HeaderBound, reason: string | undefined): void => {
    const issued = epoch
    actions.snapshotWorking()
    void call<TimeMachineSnapshotResponse>('snapshot', reason === undefined ? {} : { reason }).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        actions.snapshotFailed(rpcMessage(result.error))
        return
      }
      actions.snapshotDone(result.value.id)
    }, (error: unknown) => {
      if (issued !== epoch) return
      actions.snapshotFailed(thrownMessage(error))
    }).then(() => {
      if (issued !== epoch) return
      refreshHeaderStatus(actions)
      if (bound !== undefined) refresh(bound)
    })
  }

  const injected = (actions: Actions): TimeMachinePanelFace => {
    bound = actions
    return {
      onRefresh: () => { refresh(actions) },
      onSelect: (id) => { select(actions, id) },
      onDeselect: () => {
        detailEpoch += 1
        diffEpoch += 1
        actions.closeDetail()
      },
      onConfirmRestore: (id) => { actions.confirmRestore(id) },
      onCancelRestore: () => { actions.cancelRestore() },
      onRestore: (id) => { restore(actions, id) },
      onDismissRestoreResult: () => { actions.dismissRestore() },
      onRollback: (id) => {
        // The banner shortcut: open the ordinary restore confirmation for the
        // last-good generation (the detail read resolves through select).
        select(actions, id)
        actions.confirmRestore(id)
      },
      onDiff: (id) => { loadDiff(actions, id) },
      onCloseDiff: () => {
        diffEpoch += 1
        actions.closeDiff()
      },
      onConfirmRemove: (id) => { actions.confirmRemove(id) },
      onCancelRemove: () => { actions.cancelRemove() },
      onRemove: (id) => { remove(actions, id) },
      onDismissRemoveResult: () => { actions.dismissRemove() },
      onSnapshot: (reason) => { snapshot(actions, reason) },
      onDismissSnapshotResult: () => { actions.dismissSnapshot() },
      onExport: () => { exportArchive(actions) },
      onImport: (data) => { importArchive(actions, data) },
      onDismissArchive: () => { actions.dismissArchive() },
      onPrune: () => { prune(actions) },
      onDismissPrune: () => { actions.dismissPrune() },
      onLoadSettings: () => { loadSettings(actions) },
      onSaveSettings: (patch) => { saveSettings(actions, patch) },
    }
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'timemachine-panel',
    locale: NS,
    store,
    inject: injected,
  }, TimeMachinePanel))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'timemachine-actions',
    // After the job list (order 20); negative values are reserved for static
    // session context.
    order: 30,
    locale: NS,
    store: headerStore,
    inject: (_sessionId, actions): TimeMachineHeaderActionsFace => {
      headerBound = actions
      return {
        onRefreshStatus: () => { refreshHeaderStatus(actions) },
        onConfirmStack: (direction) => { actions.confirmStack(direction) },
        onCancelStack: () => { actions.cancelStack() },
        onStack: (direction) => { stack(actions, direction) },
        onDismissStackResult: () => { actions.dismissStack() },
        onOpenSnapshot: () => { actions.openSnapshot() },
        onCancelSnapshot: () => { actions.closeSnapshot() },
        onSnapshot: (reason) => { headerSnapshot(actions, reason) },
        onDismissSnapshotResult: () => { actions.dismissSnapshot() },
      }
    },
  }, HeaderActions))

  ctx.effect(() => {
    // A non-browser host (node test processes) has no window to listen on.
    if (typeof window === 'undefined') return () => {}
    const onKeyDown = (event: KeyboardEvent): void => {
      // Keys landing in editable content are never hijacked, modifiers or not.
      if (isEditableTarget(event.target)) return
      const combo = shortcutFromEvent(event)
      const direction = combo === undoCombo ? 'undo' as const : combo === redoCombo ? 'redo' as const : undefined
      if (direction === undefined || headerBound === undefined) return
      event.preventDefault()
      // The shortcut opens the same confirmation the button does.
      headerBound.confirmStack(direction)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, 'ui-timemachine: shortcuts')

  fetchSettings()

  ctx.on('connection/reset', () => {
    epoch += 1
    detailEpoch += 1
    diffEpoch += 1
    listInFlight = false
    fetchSettings()
    if (headerBound !== undefined) {
      headerBound.reset()
      refreshHeaderStatus(headerBound)
    }
    // The entry may not have materialized yet; its first inject runs a fresh
    // read through the mount effect, so nothing is lost by skipping it.
    if (bound === undefined) return
    bound.reset()
    refresh(bound)
  })
}
