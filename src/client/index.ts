/**
 * Configuration-generation panel plugin, browser half: one
 * `sidebar.footer.action` entry over the host's `/configGenerations`
 * Connection RPC channel (list / read / restore). There is no event push for
 * the history, so the roster is re-read on open and after every operation; a
 * reconnect drops in-flight reads and starts over (the new host may hold a
 * different history).
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
  CONFIG_GENERATIONS_CHANNEL,
  type ConfigGenerationsListResponse,
  type ConfigGenerationsReadResponse,
  type ConfigGenerationsRestoreResponse,
  type ConfigGenerationsRpcResult,
} from '../rpc.ts'
import { ConfigGenerationsPanel } from './ConfigGenerationsPanel.tsx'
import type { ConfigGenerationsPanelFace } from './ConfigGenerationsPanel.tsx'
import { createConfigGenerationsStore } from './store.ts'
import type { ConfigGenerationsStore } from './store.ts'
import { en, NS, zh } from './locales.ts'

export type { ConfigGenerationsStore } from './store.ts'
export type { ConfigGenerationsState, DetailState, ListStatus, RestoreState } from './store.ts'
export type { ConfigGenerationsPanelFace, ConfigGenerationsPanelProps } from './ConfigGenerationsPanel.tsx'
export type { ConfigGenerationsKey } from './locales.ts'

/** Required services: slot registry, dictionary registry, and the wire client. */
export const inject = ['slots', 'locale', 'connection']

type Actions = BoundActions<ConfigGenerationsStore>

/** Wire error line: code plus message, so a refusal-shaped RPC error stays distinguishable. */
function rpcMessage(error: { code: string; message: string }): string {
  return `${error.code}: ${error.message}`
}

/** Thrown transport failure to a display message. */
function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Client plugin body: register the dictionaries and the footer panel once the
 * sidebar declares its action list, and re-read on reconnect.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-config-generations: dictionaries')

  const rpc = (ctx.get('connection') as unknown as ConnectionHandle).rpc
  // Narrow the carrier's `RpcResult<unknown>` to this channel's vocabulary;
  // the channel's wire contract lives in ../rpc.ts.
  const call = <T>(endpoint: string, payload: unknown): Promise<ConfigGenerationsRpcResult<T>> =>
    rpc.call(CONFIG_GENERATIONS_CHANNEL, endpoint, payload) as Promise<ConfigGenerationsRpcResult<T>>
  const store = createConfigGenerationsStore()
  // The store instance is framework-made; the inject factory hands its baked
  // actions up so the connection/reset path below can drive the same instance.
  let bound: Actions | undefined
  // Bumped on connection/reset: a read issued against the previous connection
  // publishes nothing.
  let epoch = 0
  // Roster reads are single-flight; a reset frees the slot for a fresh one.
  let listInFlight = false
  // Bumped on every selection change: a detail read answered after the user
  // moved on (or after a reset) publishes nothing.
  let detailEpoch = 0

  const refresh = (actions: Actions): void => {
    if (listInFlight) return
    listInFlight = true
    const issued = epoch
    actions.listBegin()
    void call<ConfigGenerationsListResponse>('list', {}).then((result) => {
      if (issued !== epoch) return
      if (!result.ok) {
        if (result.error.code === 'config-generation-absent') actions.listAbsent()
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
    const issued = detailEpoch
    actions.select(id)
    void call<ConfigGenerationsReadResponse>('read', { id }).then((result) => {
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
    void call<ConfigGenerationsRestoreResponse>('restore', { id }).then((result) => {
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

  const injected = (actions: Actions): ConfigGenerationsPanelFace => {
    bound = actions
    return {
      onRefresh: () => { refresh(actions) },
      onSelect: (id) => { select(actions, id) },
      onDeselect: () => {
        detailEpoch += 1
        actions.closeDetail()
      },
      onConfirmRestore: (id) => { actions.confirmRestore(id) },
      onCancelRestore: () => { actions.cancelRestore() },
      onRestore: (id) => { restore(actions, id) },
      onDismissRestoreResult: () => { actions.dismissRestore() },
    }
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'config-generations-panel',
    locale: NS,
    store,
    inject: injected,
  }, ConfigGenerationsPanel))

  ctx.on('connection/reset', () => {
    epoch += 1
    detailEpoch += 1
    listInFlight = false
    // The entry may not have materialized yet; its first inject runs a fresh
    // read through the mount effect, so nothing is lost by skipping it.
    if (bound === undefined) return
    bound.reset()
    refresh(bound)
  })
}
