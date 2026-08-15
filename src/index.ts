/**
 * `dsh-timemachine` — external bundle mounting the configuration
 * history into a booted profile tree: the `timemachine` service, a
 * loopback-pinned `/timemachine` Connection RPC channel (the browser
 * panel's wire, replacing the core ApiProxy `timemachine` domain), and
 * a best-effort record of the boot it is part of.
 *
 * Function plugin: named `apply`/`inject`/`name` only — a default export
 * would make the Loader discard the namespace.
 * @module dsh-timemachine
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import TimeMachine from './service.ts'
import { generationOrigin, lastActivated, latestStatus } from './generations.ts'
import {
  TIMEMACHINE_CHANNEL,
  type TimeMachineErrorCode,
  type TimeMachineRpcResult,
  type GenerationSummary,
} from './rpc.ts'
import {
  diffRequestSchema,
  emptyRequestSchema,
  idRequestSchema,
  importRequestSchema,
  listRequestSchema,
  snapshotRequestSchema,
  updateSettingsRequestSchema,
} from './rpc-schemas.ts'
import { registerTimemachineTools } from './tools.ts'
import type { ConfigGeneration } from './types.ts'

export type * from './types.ts'
export * from './generations.ts'
export * from './rpc.ts'
export * from './settings.ts'
export * from './undo.ts'
export * from './diff.ts'
export * from './archive.ts'
export * from './watch.ts'
export { TimeMachine }

/** Cordis plugin name. */
export const name = 'timemachine'

/** Required services: the Connection host half carrying the RPC channel registry. */
export const inject = ['connection']

/**
 * One failure answer on the channel. The result union is this package's own
 * (`./rpc.ts`): the published carrier error map predates this channel's
 * codes, and the carrier passes the result slot through verbatim.
 */
function rpcError(
  code: TimeMachineErrorCode, message: string, details: Record<string, unknown>,
): TimeMachineRpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

/**
 * Unavailable report shared by every endpoint: the tree was not booted from a
 * dsh profile, so there is no profile directory to read or restore against.
 */
function absent(): TimeMachineRpcResult<never> {
  return rpcError(
    'timemachine-absent',
    'configuration history is unavailable: this tree was not booted from a dsh profile',
    {},
  )
}

/** Project one recorded generation to its list row (no rendered composition). */
function generationSummary(
  generation: ConfigGeneration, lastGood: ConfigGeneration | undefined, bootedId: string | undefined,
): GenerationSummary {
  const status = latestStatus(generation)
  return {
    id: generation.id,
    scope: generation.scope,
    origin: generationOrigin(generation),
    ...generation.reason === undefined ? {} : { reason: generation.reason },
    recordedAt: generation.recordedAt,
    lastSeenAt: generation.lastSeenAt,
    ...status === undefined ? {} : { latestStatus: status },
    bundleCount: generation.bundles.length,
    lastGood: generation.id === lastGood?.id,
    booted: generation.id === bootedId,
  }
}

/**
 * Map one `read()`/`restore()` rejection onto the wire vocabulary (source:
 * the core ApiProxy's `configGenerationReadError`): the service's not-found
 * and ambiguous-prefix messages are its documented text (`selectGeneration`),
 * anything else is an internal fault.
 */
function readError(id: string, error: unknown): TimeMachineRpcResult<never> {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('no recorded configuration ')) {
    return rpcError('timemachine-not-found', message, { id })
  }
  if (/ matches \d+ configurations: /.test(message)) {
    return rpcError('timemachine-ambiguous', message, { id })
  }
  return rpcError('internal', message, {})
}

/**
 * The channel handler signature: the carrier's handler shape narrowed to this
 * channel's own result union (its published error map predates these codes;
 * the carrier passes the result slot through verbatim, so the cast at
 * registration is the whole seam).
 */
type ChannelHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<TimeMachineRpcResult<unknown>>

/**
 * The channel handler: validate the payload at the wire boundary, dispatch to
 * the mounted service, and fold its failures into the channel's error codes.
 * A restore refusal (`restored: false`) rides the ok branch, never the error
 * branch. Thrown faults propagate to the carrier, which answers a transport
 * failure — business answers never throw.
 * @param ctx - the plugin context the service is mounted on.
 * @returns the Connection channel handler.
 */
function createHandler(ctx: Context): ChannelHandler {
  const service = (): TimeMachine | undefined => {
    const mounted = ctx.get('timemachine')
    return mounted !== undefined && mounted.available ? mounted : undefined
  }
  return async (endpoint, payload) => {
    switch (endpoint) {
      case 'list': {
        const parsed = listRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid list payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        const { generations, unreadable } = mounted.list()
        const lastGood = lastActivated(generations)
        return {
          ok: true,
          value: {
            generations: generations.map(generation => generationSummary(generation, lastGood, mounted.bootedId)),
            // Corrupt records stay visible: the surface can flag them rather
            // than presenting a silently incomplete history.
            unreadable: unreadable.map(entry => ({ path: entry.path, reason: entry.reason })),
          },
        }
      }
      case 'read': {
        const parsed = idRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid read payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        try {
          return { ok: true, value: mounted.read(parsed.data.id) }
        } catch (error: unknown) {
          return readError(parsed.data.id, error)
        }
      }
      case 'restore': {
        const parsed = idRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid restore payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        try {
          return { ok: true, value: await mounted.restore(parsed.data.id) }
        } catch (error: unknown) {
          return readError(parsed.data.id, error)
        }
      }
      case 'snapshot': {
        const parsed = snapshotRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid snapshot payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        return { ok: true, value: await mounted.snapshot(parsed.data.reason, new Date().toISOString()) }
      }
      case 'undo':
      case 'redo': {
        const parsed = emptyRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid ${endpoint} payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        return {
          ok: true,
          value: endpoint === 'undo'
            ? await mounted.undo(new Date().toISOString())
            : await mounted.redo(),
        }
      }
      case 'remove': {
        const parsed = idRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid remove payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        try {
          return { ok: true, value: mounted.remove(parsed.data.id) }
        } catch (error: unknown) {
          return readError(parsed.data.id, error)
        }
      }
      case 'diff': {
        const parsed = diffRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid diff payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        try {
          return { ok: true, value: mounted.diff(parsed.data.id, parsed.data.otherId) }
        } catch (error: unknown) {
          return readError(parsed.data.id, error)
        }
      }
      case 'export': {
        const parsed = emptyRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid export payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        const archive = mounted.exportData()
        if (archive === undefined) return absent()
        return { ok: true, value: { data: Buffer.from(archive).toString('base64') } }
      }
      case 'import': {
        const parsed = importRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid import payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        let bytes: Uint8Array
        try {
          bytes = Buffer.from(parsed.data.data, 'base64')
        } catch {
          return rpcError('bad-request', 'invalid import payload: data is not base64', { issues: [] })
        }
        try {
          return { ok: true, value: await mounted.importData(bytes) }
        } catch (error: unknown) {
          // A corrupt archive throws out of unzip; that is a bad payload, not a fault.
          return rpcError('bad-request', `invalid import payload: ${error instanceof Error ? error.message : String(error)}`, { issues: [] })
        }
      }
      case 'status': {
        const parsed = emptyRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid status payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        return { ok: true, value: mounted.status() }
      }
      case 'prune': {
        const parsed = emptyRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid prune payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        const removed = mounted.prune()
        if (removed === undefined) return absent()
        return { ok: true, value: { removed } }
      }
      case 'getSettings': {
        const parsed = emptyRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid getSettings payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        return { ok: true, value: mounted.getSettings() }
      }
      case 'updateSettings': {
        const parsed = updateSettingsRequestSchema.safeParse(payload)
        if (!parsed.success) {
          return rpcError('bad-request', `invalid updateSettings payload: ${parsed.error.message}`, { issues: parsed.error.issues })
        }
        const mounted = service()
        if (mounted === undefined) return absent()
        return { ok: true, value: await mounted.updateSettings(parsed.data.patch) }
      }
      default:
        return rpcError('bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`, { issues: [] })
    }
  }
}

/**
 * Plugin body: mount the history service, expose it over the loopback-pinned
 * RPC channel, record this boot (best-effort — an unwritable history is a lost
 * recovery aid, not a reason to fail a boot that would otherwise work), arm
 * the auto-save watcher, and offer the agent tools when a tool registry is
 * composed (a headless tree without one simply has no tools).
 * @param ctx - plugin context carrying the Connection host service.
 */
export function apply(ctx: Context): void {
  ctx.plugin(TimeMachine)
  // The handler answers in this package's own result union; structurally it
  // is the carrier's RpcResult, and the carrier forwards the slot verbatim.
  ctx.connection.rpc.handle(
    TIMEMACHINE_CHANNEL,
    createHandler(ctx) as unknown as ConnectionRpcHandler,
    { authority: 'loopback' },
  )
  // The service fiber loads asynchronously (fibers never start inside the
  // `ctx.plugin()` call), so the boot record waits on the service name rather
  // than reading the slot synchronously.
  ctx.inject(['timemachine'], (inner) => {
    void inner.timemachine.recordBoot(new Date().toISOString()).catch((error: unknown) => {
      process.stderr.write(`dsh-timemachine: warning: could not record this configuration: ${String(error)}\n`)
    })
    inner.timemachine.startAutoSave()
    // The inject callback is a child plugin: its fiber disposes with this one,
    // which is the watcher's stop hook.
    inner.effect(() => () => inner.timemachine.stopAutoSave(), 'timemachine auto-save')
  })
  // The tool registry is optional in the composition: `ctx.inject` defers
  // until it mounts, and a tree that never mounts one never gets the tools.
  ctx.inject(['tools'], (inner) => {
    registerTimemachineTools(inner)
  })
}
