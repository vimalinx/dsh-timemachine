/**
 * Wire contract of the configuration-history RPC channel: one dedicated
 * Connection channel (`/timemachine`) replacing the core ApiProxy
 * `timemachine` domain, with `list` / `read` / `restore` endpoints.
 *
 * The durable record types cross the wire unchanged — they are plain JSON and
 * this package's own format — while the roster reads a slim summary that drops
 * the rendered composition (`composed.render` dwarfs every other field).
 *
 * This module is browser-safe (types and string constants only): the client
 * bundle inlines it, and the host half validates payloads against the zod
 * mirror in `./rpc-schemas.ts` (kept host-only so the bundle never inlines
 * zod).
 * @module dsh-timemachine/rpc
 */

import type {
  ConfigGeneration,
  GenerationScope,
  OutcomeStatus,
  RestoreResult,
  UnreadableGeneration,
} from './types.ts'

/** The logical Connection channel this plugin registers and calls. */
export const TIMEMACHINE_CHANNEL = '/timemachine'

/** Channel endpoints, named as channel-relative paths. */
export const TIMEMACHINE_ENDPOINTS = ['list', 'read', 'restore'] as const

/** One channel endpoint. */
export type TimeMachineEndpoint = (typeof TIMEMACHINE_ENDPOINTS)[number]

/**
 * List-row view of one recorded configuration. Carries everything a roster
 * needs to label and select a row; `read` serves the full record once a row
 * is chosen.
 */
export interface GenerationSummary {
  /** Content-addressed id (also accepted as a prefix by read/restore). */
  id: string
  /** Which slots the record observed (`composition` or `full`). */
  scope: GenerationScope
  /** ISO timestamp this configuration was first observed. */
  recordedAt: string
  /** ISO timestamp this configuration was most recently composed. */
  lastSeenAt: string
  /** The latest boot attempt's outcome; absent when no attempt settled. */
  latestStatus?: OutcomeStatus
  /** How many bundle layers the generation recorded. */
  bundleCount: number
  /** Whether this is the newest generation that reached an activated tree. */
  lastGood: boolean
  /** Whether the running process booted this configuration. */
  booted: boolean
}

/** `list` request payload (empty; the channel is pinned to the booted profile). */
export interface TimeMachineListRequest {}

/**
 * `list` response: every recorded configuration of the booted profile, oldest
 * `lastSeenAt` first, as slim summaries, plus the records the reader rejected
 * so the surface can flag corruption. A missing profile derivation answers
 * `timemachine-absent` instead.
 */
export interface TimeMachineListResponse {
  generations: GenerationSummary[]
  unreadable: UnreadableGeneration[]
}

/** `read`/`restore` request payload: a generation id or unambiguous prefix. */
export interface TimeMachineIdRequest {
  id: string
}

/** `read` response: the complete record, rendered composition included. */
export type TimeMachineReadResponse = ConfigGeneration

/**
 * `restore` response: what the restore did. A refusal (`restored: false` with
 * `refusal`/`verdict`) is a normal business result, not an RPC error; only an
 * unresolvable id answers with `timemachine-not-found` /
 * `timemachine-ambiguous`.
 */
export type TimeMachineRestoreResponse = RestoreResult

/**
 * The channel's error vocabulary, mirroring the core ApiProxy domain's codes
 * plus the shared `bad-request`/`internal` fallbacks.
 */
export type TimeMachineErrorCode =
  | 'bad-request'
  | 'timemachine-absent'
  | 'timemachine-not-found'
  | 'timemachine-ambiguous'
  | 'internal'

/**
 * The channel's error branch, a structural mirror of the Connection
 * carrier's `RpcError` narrowed to this channel's codes. Self-owned so
 * neither half imports the ApiProxy contract across the plugin boundary.
 */
export interface TimeMachineRpcError {
  code: TimeMachineErrorCode
  message: string
  details: Record<string, unknown>
}

/**
 * The channel's result union, a structural mirror of the Connection carrier's
 * `RpcResult<T>`: the host handler returns the carrier's type and the client
 * narrows the answer to this shape.
 */
export type TimeMachineRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TimeMachineRpcError }
