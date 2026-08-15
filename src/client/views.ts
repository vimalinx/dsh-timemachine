/** Pure view mappings over the configGeneration RPC records. */

import type { GenerationSummary } from '../rpc.ts'
import type { ConfigGeneration, GenerationOrigin } from '../types.ts'
import type { DiffFile } from '../diff.ts'

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

/** Locale keys for a summary's origin badge. */
export type OriginKey = 'origin.boot' | 'origin.auto' | 'origin.manual' | 'origin.regret'

/**
 * Map a summary's `origin` to its locale key. Records written before the
 * field existed arrive already defaulted to `boot` by the host reader.
 * @param origin - the record's provenance.
 * @returns the badge label key.
 */
export function originKey(origin: GenerationOrigin): OriginKey {
  return `origin.${origin}`
}

/** Locale keys for a diff entry's file heading. */
export type DiffFileKey = 'diff.file.manifest' | 'diff.file.profilePatch' | 'diff.file.homePatch' | 'diff.file.render'

/**
 * Map a diff entry's file slot to its locale key.
 * @param file - the compared file slot.
 * @returns the heading label key.
 */
export function diffFileKey(file: DiffFile): DiffFileKey {
  return `diff.file.${file}`
}

/** The collapse marker the host diff emits for a folded unchanged run. */
const COLLAPSED_MARKER = /^… \(\d+ unchanged lines\)$/

/**
 * Whether a diff line is the collapsed-run marker rather than real content;
 * it renders muted instead of as an ordinary context line.
 * @param text - one hunk's line text.
 * @returns true for the `… (N unchanged lines)` marker.
 */
export function isCollapsedMarker(text: string): boolean {
  return COLLAPSED_MARKER.test(text)
}

/**
 * The shortcuts an absent or never-read settings document falls back to,
 * mirroring `DEFAULT_TIMEMACHINE_SETTINGS.shortcuts` in `../settings.ts`
 * (that module reads the filesystem, so the browser bundle cannot import it).
 */
export const DEFAULT_SHORTCUTS = { undo: 'Ctrl+Alt+Z', redo: 'Ctrl+Alt+Y' } as const

/** Modifier keys, in the canonical display order. */
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

/** Alias spellings a hand-edited settings file or capture may carry. */
const MODIFIER_ALIASES: Record<string, (typeof MODIFIERS)[number]> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
}

/**
 * Normalize a display-string combination (`Ctrl+Alt+Z` style) to the
 * canonical form: modifiers in {@link MODIFIERS} order, a single-character
 * key uppercased, a lowercase function-key name (`f9`) uppercased. Any other
 * key survives verbatim, so a setting like `Ctrl+ArrowUp` still round-trips.
 * @param combo - the stored or captured combination.
 * @returns the canonical comparison/display string.
 */
export function normalizeShortcut(combo: string): string {
  const modifiers = new Set<string>()
  let key = ''
  for (const part of combo.split('+')) {
    const token = part.trim()
    if (token.length === 0) continue
    const modifier = MODIFIER_ALIASES[token.toLowerCase()]
    if (modifier !== undefined) {
      modifiers.add(modifier)
    } else if (token.length === 1 || /^f\d{1,2}$/i.test(token)) {
      key = token.toUpperCase()
    } else {
      key = token
    }
  }
  return [...MODIFIERS.filter(modifier => modifiers.has(modifier)), ...(key === '' ? [] : [key])].join('+')
}

/**
 * Reduce a keyboard event to its canonical combination string. A pure
 * modifier press normalizes to the modifiers alone and therefore never
 * equals a complete stored combination.
 * @param event - the keydown event.
 * @returns the canonical combination.
 */
export function shortcutFromEvent(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key)
  }
  return parts.join('+')
}

/**
 * Whether a keydown landed inside editable content; such keys are never
 * hijacked for the undo/redo shortcuts, modifiers or not.
 * @param target - the event target.
 * @returns true for inputs, textareas, selects, and contentEditable nodes.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as HTMLElement).tagName !== 'string') return false
  const element = target as HTMLElement
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable
}
