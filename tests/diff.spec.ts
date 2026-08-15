/**
 * The line-level diff: per-file grouping, change highlighting, collapsed
 * unchanged runs, and the whole-file fallback past the size cap.
 * @module dsh-timemachine/tests/diff
 */

import { describe, expect, it } from 'vitest'
import { diffInputs, type DiffSide } from '../src/diff.ts'

const side = (overrides: Partial<DiffSide> = {}): DiffSide => ({
  manifest: '{\n  "name": "a"\n}\n',
  profilePatch: '[]\n',
  homePatch: null,
  render: '- id: llm\n',
  ...overrides,
})

describe('diffing two configurations', () => {
  it('diffs identical configurations to nothing', () => {
    expect(diffInputs(side(), side())).toEqual([])
  })

  it('reports only the file that changed, as add/del/context lines', () => {
    const diffs = diffInputs(side(), side({ profilePatch: '[]\n- id: panel\n' }))
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.file).toBe('profilePatch')
    expect(diffs[0]!.hunks).toEqual([
      { type: 'context', text: '[]' },
      { type: 'add', text: '- id: panel' },
      { type: 'context', text: '' },
    ])
  })

  it('reads a deleted patch file as every line removed', () => {
    const diffs = diffInputs(side({ profilePatch: '- id: a\n- id: b\n' }), side({ profilePatch: null }))
    expect(diffs[0]!.file).toBe('profilePatch')
    // '- id: a\n- id: b\n' splits to two content lines plus the trailing empty
    // line, which matches the absent side's empty text as context.
    expect(diffs[0]!.hunks.filter(hunk => hunk.type === 'del')).toHaveLength(2)
    expect(diffs[0]!.hunks.some(hunk => hunk.type === 'add')).toBe(false)
  })

  it('collapses a long unchanged run into a marker with context on both sides', () => {
    const before = ['line-0', ...Array.from({ length: 20 }, (_, i) => `same-${i}`), 'line-21'].join('\n')
    const after = ['line-0', ...Array.from({ length: 20 }, (_, i) => `same-${i}`), 'line-21-changed'].join('\n')
    const diffs = diffInputs(side({ render: before }), side({ render: after }))
    const hunks = diffs[0]!.hunks
    expect(hunks.some(hunk => hunk.text === '… (18 unchanged lines)')).toBe(true)
    expect(hunks).toContainEqual({ type: 'del', text: 'line-21' })
    expect(hunks).toContainEqual({ type: 'add', text: 'line-21-changed' })
    // The collapsed run stays out of the verbatim output.
    expect(hunks.filter(hunk => hunk.type === 'context' && hunk.text.startsWith('same-'))).toHaveLength(3)
  })

  it('drops leading context before the first change', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'x'].join('\n')
    const after = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'y'].join('\n')
    const hunks = diffInputs(side({ render: before }), side({ render: after }))[0]!.hunks
    // The 8 unchanged lines ahead of the change keep only their last 3.
    expect(hunks[0]).toEqual({ type: 'context', text: '… (5 unchanged lines)' })
    expect(hunks.slice(1, 4).map(hunk => hunk.text)).toEqual(['f', 'g', 'h'])
    expect(hunks.some(hunk => hunk.text === 'e')).toBe(false)
  })

  it('degrades to a whole-file replace past the line cap', () => {
    const before = Array.from({ length: 2100 }, (_, i) => `line-${i}`).join('\n')
    const after = Array.from({ length: 2100 }, (_, i) => `line-${i + 1}`).join('\n')
    const hunks = diffInputs(side({ render: before }), side({ render: after }))[0]!.hunks
    expect(hunks.filter(hunk => hunk.type === 'del')).toHaveLength(2100)
    expect(hunks.filter(hunk => hunk.type === 'add')).toHaveLength(2100)
    expect(hunks.some(hunk => hunk.type === 'context')).toBe(false)
  })
})
