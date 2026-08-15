/**
 * Line-level diffs between two configurations, for the panel's highlighting.
 *
 * Zero dependencies: a textbook longest-common-subsequence over lines, with a
 * size cap — past it the quadratic table is not worth its memory, and the diff
 * degrades to "the whole file changed". Long unchanged runs collapse to a
 * single marker line so a one-line edit in a large manifest stays readable.
 * @module dsh-timemachine/diff
 */

import type { GenerationInputs } from './types.ts'

/** One side of a diff: the four texts a configuration is compared through. */
export interface DiffSide extends GenerationInputs {
  /** The rendered composition (a generation's `composed.render`, or the live one). */
  render: string
}

/** One compared file's label, as the panel groups them. */
export type DiffFile = 'manifest' | 'profilePatch' | 'homePatch' | 'render'

/** One line of one file's diff. */
export interface DiffHunk {
  /** `context` lines exist on both sides; `del` only on the first; `add` only on the second. */
  type: 'add' | 'del' | 'context'
  /** The line text, or the collapsed-run marker `… (N unchanged lines)`. */
  text: string
}

/** One file's worth of diff lines; files with no differences are omitted. */
export interface InputDiff {
  file: DiffFile
  hunks: DiffHunk[]
}

/** Past this many lines on either side, the LCS table degrades to a whole-file replace. */
const MAX_LINES = 2000

/** Unchanged lines kept around each change before a run collapses to a marker. */
const CONTEXT_LINES = 3

/**
 * Diff two configurations file by file.
 * @param a - the older (or recorded) side.
 * @param b - the newer (or current) side.
 * @returns one entry per differing file; identical configurations diff to `[]`.
 */
export function diffInputs(a: DiffSide, b: DiffSide): InputDiff[] {
  const files: [DiffFile, string, string][] = [
    ['manifest', a.manifest, b.manifest],
    ['profilePatch', a.profilePatch ?? '', b.profilePatch ?? ''],
    ['homePatch', a.homePatch ?? '', b.homePatch ?? ''],
    ['render', a.render, b.render],
  ]
  const diffs: InputDiff[] = []
  for (const [file, before, after] of files) {
    if (before === after) continue
    diffs.push({ file, hunks: diffLines(before, after) })
  }
  return diffs
}

/**
 * Diff two texts line by line. An absent patch file diffs as the empty text —
 * "deleted the file" reads as every line removed, which is what restoring it
 * would show.
 */
function diffLines(before: string, after: string): DiffHunk[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const raw = a.length > MAX_LINES || b.length > MAX_LINES
    // The LCS table is quadratic; past the cap a whole-file replace is honest
    // enough for a highlight view and costs O(n) memory instead.
    ? [...a.map(text => ({ type: 'del' as const, text })), ...b.map(text => ({ type: 'add' as const, text }))]
    : lcs(a, b)
  return collapse(raw)
}

/** The LCS backtrack: matched lines as context, the rest as deletions then additions. */
function lcs(a: string[], b: string[]): DiffHunk[] {
  const rows = a.length
  const columns = b.length
  // lengths[i][j] = LCS length of a[i:] and b[j:]; one flat table, row-major.
  const lengths = new Uint32Array((rows + 1) * (columns + 1))
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i * (columns + 1) + j] = a[i] === b[j]
        ? lengths[(i + 1) * (columns + 1) + (j + 1)]! + 1
        : Math.max(lengths[(i + 1) * (columns + 1) + j]!, lengths[i * (columns + 1) + (j + 1)]!)
    }
  }
  const hunks: DiffHunk[] = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (a[i] === b[j]) {
      hunks.push({ type: 'context', text: a[i]! })
      i += 1
      j += 1
    } else if (lengths[(i + 1) * (columns + 1) + j]! >= lengths[i * (columns + 1) + (j + 1)]!) {
      hunks.push({ type: 'del', text: a[i]! })
      i += 1
    } else {
      hunks.push({ type: 'add', text: b[j]! })
      j += 1
    }
  }
  while (i < rows) hunks.push({ type: 'del', text: a[i++]! })
  while (j < columns) hunks.push({ type: 'add', text: b[j++]! })
  return hunks
}

/**
 * Collapse unchanged runs longer than two context windows, keeping
 * {@link CONTEXT_LINES} lines on each side of every change. Leading context
 * (before the first change) keeps only its tail, trailing context only its
 * head — the far ends of an untouched region show nothing.
 */
function collapse(hunks: DiffHunk[]): DiffHunk[] {
  const out: DiffHunk[] = []
  let buffer: string[] = []
  const emit = (atStart: boolean, atEnd: boolean): void => {
    const head = atStart ? [] : buffer.slice(0, CONTEXT_LINES)
    const tail = atEnd ? [] : buffer.slice(Math.max(head.length, buffer.length - CONTEXT_LINES))
    const middle = buffer.length - head.length - tail.length
    for (const text of head) out.push({ type: 'context', text })
    if (middle > 0) out.push({ type: 'context', text: `… (${middle} unchanged lines)` })
    for (const text of tail) out.push({ type: 'context', text })
    buffer = []
  }
  for (const hunk of hunks) {
    if (hunk.type === 'context') {
      buffer.push(hunk.text)
      continue
    }
    emit(out.length === 0, false)
    out.push(hunk)
  }
  emit(out.length === 0, true)
  return out
}
