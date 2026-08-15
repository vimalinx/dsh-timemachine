/** Pure view mappings over the configGeneration RPC records. */

import type { GenerationSummary } from '../rpc.ts'
import type { ConfigGeneration } from '../types.ts'

/**
 * The row's id label: a short prefix, enough to tell rows apart (read/restore
 * accept prefixes; the full id stays in the detail).
 * @param id - the content-addressed generation id.
 * @returns its display prefix.
 */
export function shortGenerationId(id: string): string {
  return id.slice(0, 8)
}

/** Locale keys for a summary's latest boot outcome. */
export type SummaryStatusKey = 'status.activated' | 'status.failed' | 'status.never'

/**
 * Map a summary's `latestStatus` to its locale key.
 * @param summary - the roster row.
 * @returns the status label key (`status.never` when no attempt settled).
 */
export function summaryStatusKey(summary: GenerationSummary): SummaryStatusKey {
  if (summary.latestStatus === 'activated') return 'status.activated'
  if (summary.latestStatus === 'failed') return 'status.failed'
  return 'status.never'
}

/**
 * Format an ISO timestamp for a row, second precision, local time. An
 * unparseable value is shown verbatim rather than hidden.
 * @param iso - the recorded timestamp.
 * @returns the display string.
 */
export function formatTimestamp(iso: string): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} `
    + `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}

/**
 * The files a restore of this generation writes back, mirroring the host
 * service's target list: the profile manifest always, the profile patch when
 * the record carries one, and every locally authored preset file. The
 * settings document is deliberately absent — the host restore never writes it.
 * @param generation - the loaded record the confirmation lists.
 * @returns the display paths, in write order.
 */
export function restoreTargets(generation: ConfigGeneration): string[] {
  return [
    'package.json',
    ...(generation.inputs.profilePatch === null ? [] : ['cordis.patch.yml']),
    ...(generation.environment?.presets.map(preset => preset.path) ?? []),
  ]
}
