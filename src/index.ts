/**
 * `dsh-config-generations` — external bundle mounting the configuration
 * history into a booted profile tree: the `configGenerations` service, a
 * loopback-pinned `/configGenerations` Connection RPC channel (the browser
 * panel's wire, replacing the core ApiProxy `configGenerations` domain), and
 * a best-effort record of the boot it is part of.
 *
 * Function plugin: named `apply`/`inject`/`name` only — a default export
 * would make the Loader discard the namespace.
 * @module dsh-config-generations
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import ConfigGenerations from './service.ts'
import { lastActivated, latestStatus } from './generations.ts'
import {
  CONFIG_GENERATIONS_CHANNEL,
  type ConfigGenerationsErrorCode,
  type ConfigGenerationsRpcResult,
  type GenerationSummary,
} from './rpc.ts'
import { idRequestSchema, listRequestSchema } from './rpc-schemas.ts'
import type { ConfigGeneration } from './types.ts'

export type * from './types.ts'
export * from './generations.ts'
export * from './rpc.ts'
export { ConfigGenerations }

/** Cordis plugin name. */
export const name = 'config-generations'

/** Required services: the Connection host half carrying the RPC channel registry. */
export const inject = ['connection']

/**
 * One failure answer on the channel. The result union is this package's own
 * (`./rpc.ts`): the published carrier error map predates this channel's
 * codes, and the carrier passes the result slot through verbatim.
 */
function rpcError(
  code: ConfigGenerationsErrorCode, message: string, details: Record<string, unknown>,
): ConfigGenerationsRpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

/**
 * Unavailable report shared by every endpoint: the tree was not booted from a
 * dsh profile, so there is no profile directory to read or restore against.
 */
function absent(): ConfigGenerationsRpcResult<never> {
  return rpcError(
    'config-generation-absent',
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
function readError(id: string, error: unknown): ConfigGenerationsRpcResult<never> {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('no recorded configuration ')) {
    return rpcError('config-generation-not-found', message, { id })
  }
  if (/ matches \d+ configurations: /.test(message)) {
    return rpcError('config-generation-ambiguous', message, { id })
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
) => Promise<ConfigGenerationsRpcResult<unknown>>

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
  const service = (): ConfigGenerations | undefined => {
    const mounted = ctx.get('configGenerations')
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
      default:
        return rpcError('bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`, { issues: [] })
    }
  }
}

/**
 * Plugin body: mount the history service, expose it over the loopback-pinned
 * RPC channel, and record this boot (best-effort — an unwritable history is a
 * lost recovery aid, not a reason to fail a boot that would otherwise work).
 * @param ctx - plugin context carrying the Connection host service.
 */
export function apply(ctx: Context): void {
  ctx.plugin(ConfigGenerations)
  // The handler answers in this package's own result union; structurally it
  // is the carrier's RpcResult, and the carrier forwards the slot verbatim.
  ctx.connection.rpc.handle(
    CONFIG_GENERATIONS_CHANNEL,
    createHandler(ctx) as unknown as ConnectionRpcHandler,
    { authority: 'loopback' },
  )
  // The service fiber loads asynchronously (fibers never start inside the
  // `ctx.plugin()` call), so the boot record waits on the service name rather
  // than reading the slot synchronously.
  ctx.inject(['configGenerations'], (inner) => {
    void inner.configGenerations.recordBoot(new Date().toISOString()).catch((error: unknown) => {
      process.stderr.write(`dsh-config-generations: warning: could not record this configuration: ${String(error)}\n`)
    })
  })
}
