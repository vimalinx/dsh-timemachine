// @vitest-environment jsdom
/**
 * TimeMachinePanel behavior spec: the trigger opens the roster (and
 * refreshes on mount/open), every roster phase renders its own copy, the
 * unreadable warning and kept-rows failure strip show, rows expand into the
 * detail (bundles, outcome timeline, read-only render), and the restore flow
 * walks confirmation → success/refusal/failure with the drift breakdown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigGeneration, RestoreResult, TimemachineSettings } from '../src/types.ts'
import type { GenerationSummary } from '../src/rpc.ts'
import { TimeMachinePanel } from '../src/client/TimeMachinePanel.tsx'
import type { TimeMachinePanelFace } from '../src/client/TimeMachinePanel.tsx'
import { createTimeMachineStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t = makeTranslate(zh)

afterEach(cleanup)

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true,
    recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

const SUMMARY: GenerationSummary = {
  id: 'abcdef0123456789',
  scope: 'full',
  origin: 'boot',
  recordedAt: '2026-08-01T08:00:00',
  lastSeenAt: '2026-08-02T09:30:00',
  latestStatus: 'activated',
  bundleCount: 1,
  lastGood: true,
  booted: true,
}

const FAILED_SUMMARY: GenerationSummary = {
  id: '1234567890abcdef',
  scope: 'composition',
  origin: 'boot',
  recordedAt: '2026-08-03T08:00:00',
  lastSeenAt: '2026-08-03T09:30:00',
  latestStatus: 'failed',
  bundleCount: 1,
  lastGood: false,
  booted: false,
}

const NEVER_SUMMARY: GenerationSummary = {
  id: 'fedcba0987654321',
  scope: 'composition',
  origin: 'boot',
  recordedAt: '2026-08-04T08:00:00',
  lastSeenAt: '2026-08-04T09:30:00',
  bundleCount: 1,
  lastGood: false,
  booted: false,
}

const GENERATION: ConfigGeneration = {
  formatVersion: 1,
  id: SUMMARY.id,
  scope: 'full',
  recordedAt: '2026-08-01T08:00:00',
  lastSeenAt: '2026-08-02T09:30:00',
  profile: 'web',
  inputs: { manifest: '{}', profilePatch: 'patch: yes', homePatch: null },
  environment: {
    settings: { path: '/home/u/.dsh/settings.yml', text: null },
    presets: [{ id: 'mine', path: '/home/u/.dsh/.agent-presets/mine/cordis.yml', text: '[]' }],
  },
  bundles: [
    { name: '@deepseek-ai/dsh-bundle-base', version: '0.1.0-rc.5' },
    { name: '@deepseek-ai/dsh-bundle-web-app', version: null },
  ],
  composed: { digest: 'digest', render: 'plugins:\n  - entry: []' },
  outcomes: [
    { at: '2026-08-01T08:00:00', status: 'activated', overlays: [] },
    { at: '2026-08-02T09:30:00', status: 'failed', overlays: ['./fix.yml'], error: 'loader blew up' },
  ],
}

function bench(faceOverrides: Partial<TimeMachinePanelFace> = {}, wide = true) {
  const store = createTimeMachineStore().create()
  const face: TimeMachinePanelFace = {
    onRefresh: vi.fn(),
    onSelect: vi.fn(),
    onDeselect: vi.fn(),
    onConfirmRestore: vi.fn(),
    onCancelRestore: vi.fn(),
    onRestore: vi.fn(),
    onDismissRestoreResult: vi.fn(),
    onRollback: vi.fn(),
    onDiff: vi.fn(),
    onCloseDiff: vi.fn(),
    onConfirmRemove: vi.fn(),
    onCancelRemove: vi.fn(),
    onRemove: vi.fn(),
    onDismissRemoveResult: vi.fn(),
    onSnapshot: vi.fn(),
    onDismissSnapshotResult: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    onDismissArchive: vi.fn(),
    onPrune: vi.fn(),
    onDismissPrune: vi.fn(),
    onLoadSettings: vi.fn(),
    onSaveSettings: vi.fn(),
    ...faceOverrides,
  }
  const view = render(
    <TimeMachinePanel
      wide={wide}
      useStore={bindSnapshotSelector(store)}
      actions={store.actions}
      useSessions={emptySessions()}
      useWorkspaces={emptyWorkspaces()}
      t={t as never}
      {...face}
    />,
  )
  return { store, face, view }
}

/** Open the panel. */
function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: '时间机器' }))
}

describe('TimeMachinePanel', () => {
  it('refreshes on mount and on open, and toggles closed', () => {
    const { face, view } = bench()
    expect(face.onRefresh).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).not.toContain('读取中…')
    openPanel()
    expect(face.onRefresh).toHaveBeenCalledTimes(2)
    expect(screen.getByText('读取中…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '时间机器' }))
    expect(screen.queryByText('读取中…')).toBeNull()
  })

  it('renders the rail trigger without the label when the sidebar is folded', () => {
    bench({}, false)
    const trigger = screen.getByRole('button', { name: '时间机器' })
    expect(trigger.textContent).toBe('')
  })

  it('renders the absent and empty phases, and the refresh button re-reads', () => {
    const { store, face } = bench()
    openPanel()
    act(() => { store.actions.listAbsent() })
    expect(screen.getByText('此实例未记录配置历史')).toBeTruthy()
    act(() => { store.actions.listLoaded([], []) })
    expect(screen.getByText('尚无记录，启动一次后生成')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(face.onRefresh).toHaveBeenCalledTimes(3)
  })

  it('shows the unreadable warning and keeps rows visible under a failed re-read', () => {
    const { store } = bench()
    openPanel()
    act(() => { store.actions.listLoaded([SUMMARY], [{ path: '/records/bad.json', reason: 'bad format' }]) })
    expect(screen.getByRole('alert').textContent).toContain('有 1 条记录无法读取')
    act(() => { store.actions.listFailed('connection refused') })
    const alerts = screen.getAllByRole('alert').map(node => node.textContent)
    expect(alerts.some(text => text?.includes('读取配置代失败：connection refused'))).toBe(true)
    // The roster stays: a transient wire failure is not an empty history.
    expect(screen.getByText('abcdef01')).toBeTruthy()
  })

  it('renders rows with status, badges, and timestamps; clicking selects and re-clicking deselects', () => {
    const { store, face } = bench()
    openPanel()
    act(() => { store.actions.listLoaded([SUMMARY, FAILED_SUMMARY, NEVER_SUMMARY], []) })
    expect(screen.getByText('已激活')).toBeTruthy()
    expect(screen.getByText('启动失败')).toBeTruthy()
    expect(screen.getByText('未启动')).toBeTruthy()
    expect(screen.getByText('最近可用')).toBeTruthy()
    expect(screen.getByText('当前启动')).toBeTruthy()

    fireEvent.click(screen.getByText('abcdef01'))
    expect(face.onSelect).toHaveBeenCalledWith(SUMMARY.id)
    act(() => { store.actions.select(SUMMARY.id) })
    expect(screen.getByText('读取详情…')).toBeTruthy()
    const selected = screen.getByText('abcdef01').closest('button')!
    expect(selected.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(selected)
    expect(face.onDeselect).toHaveBeenCalledTimes(1)
  })

  it('renders the detail read failure as an alert', () => {
    const { store } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailFailed(SUMMARY.id, 'timemachine-not-found: gone')
    })
    expect(screen.getByRole('alert').textContent).toContain('读取详情失败：timemachine-not-found: gone')
  })

  it('renders the loaded detail: bundle versions, outcome timeline, and the read-only render', () => {
    const { store, face } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
    })
    expect(screen.getByText('Bundle 版本')).toBeTruthy()
    expect(screen.getByText('@deepseek-ai/dsh-bundle-base')).toBeTruthy()
    expect(screen.getByText('0.1.0-rc.5')).toBeTruthy()
    expect(screen.getByText('（无版本）')).toBeTruthy()
    expect(screen.getByText('启动记录')).toBeTruthy()
    expect(screen.getByText('loader blew up')).toBeTruthy()
    expect(screen.getByText('叠加层：./fix.yml')).toBeTruthy()
    expect(screen.getByText(/- entry: \[\]/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '恢复到此配置' }))
    expect(face.onConfirmRestore).toHaveBeenCalledWith(GENERATION.id)
  })

  it('renders the no-outcomes note for a generation that never settled a boot', () => {
    const { store } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([NEVER_SUMMARY], [])
      store.actions.select(NEVER_SUMMARY.id)
      store.actions.detailLoaded({ ...GENERATION, id: NEVER_SUMMARY.id, outcomes: [] })
    })
    expect(screen.getByText('尚无启动记录')).toBeTruthy()
  })

  it('the confirmation lists the files to write back and confirms or cancels', () => {
    const { store, face } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
      store.actions.confirmRestore(GENERATION.id)
    })
    const dialog = screen.getByRole('dialog', { name: '恢复配置代 abcdef01' })
    expect(dialog.textContent).toContain('将写回以下文件：')
    expect(dialog.textContent).toContain('package.json')
    expect(dialog.textContent).toContain('cordis.patch.yml')
    expect(dialog.textContent).toContain('/home/u/.dsh/.agent-presets/mine/cordis.yml')
    expect(dialog.textContent).toContain('恢复在下次启动时生效。')

    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))
    expect(face.onRestore).toHaveBeenCalledWith(GENERATION.id)

    act(() => { store.actions.confirmRestore(GENERATION.id) })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(face.onCancelRestore).toHaveBeenCalledTimes(1)
  })

  it('a composition-scope record confirms with only the manifest', () => {
    const { store } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([FAILED_SUMMARY], [])
      store.actions.select(FAILED_SUMMARY.id)
      store.actions.detailLoaded({
        ...GENERATION,
        id: FAILED_SUMMARY.id,
        inputs: { manifest: '{}', profilePatch: null, homePatch: null },
        environment: null,
      })
      store.actions.confirmRestore(FAILED_SUMMARY.id)
    })
    const dialog = screen.getByRole('dialog', { name: '恢复配置代 12345678' })
    expect(dialog.textContent).toContain('package.json')
    expect(dialog.textContent).not.toContain('cordis.patch.yml')
  })

  it('the working restore locks both dialog buttons', () => {
    const { store } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
      store.actions.confirmRestore(GENERATION.id)
      store.actions.restoreWorking(GENERATION.id)
    })
    expect(screen.getByRole('button', { name: '正在恢复…' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '恢复到此配置' })).toHaveProperty('disabled', true)
  })

  it('a restored result shows the changes and the next-boot notice, then dismisses', () => {
    const { store, face } = bench()
    openPanel()
    const result: RestoreResult = {
      id: SUMMARY.id,
      restored: true,
      changes: ['wrote package.json', 'removed cordis.patch.yml'],
    }
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
      store.actions.restoreDone(result)
    })
    expect(screen.getByText('已恢复，将在下次启动生效')).toBeTruthy()
    expect(screen.getByText('wrote package.json')).toBeTruthy()
    expect(screen.getByText('removed cordis.patch.yml')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(face.onDismissRestoreResult).toHaveBeenCalledTimes(1)
  })

  it('a refused result shows the refusal and the drift breakdown', () => {
    const { store } = bench()
    openPanel()
    const result: RestoreResult = {
      id: SUMMARY.id,
      restored: false,
      changes: [],
      refusal: 'bundle drift',
      verdict: {
        reproducible: false,
        digestChanged: true,
        drift: [
          { name: 'a', recorded: '1.0', current: '2.0' },
          { name: 'b', current: '1.0' },
          { name: 'c', recorded: '1.0' },
          { name: 'd', recorded: null, current: '2.0' },
          { name: 'e', recorded: '1.0', current: null },
        ],
      },
    }
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
      store.actions.restoreDone(result)
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('恢复被拒绝：bundle drift')
    expect(alert.textContent).toContain('与记录时相比，以下 bundle 已变化：')
    expect(alert.textContent).toContain('a：1.0 → 2.0')
    expect(alert.textContent).toContain('b：（新增） → 1.0')
    expect(alert.textContent).toContain('c：1.0 → （已移除）')
    expect(alert.textContent).toContain('d：（无版本） → 2.0')
    expect(alert.textContent).toContain('e：1.0 → （无版本）')
  })

  it('a refused result without a refusal reason or verdict renders neither', () => {
    const { store } = bench()
    openPanel()
    const result: RestoreResult = { id: SUMMARY.id, restored: false, changes: [] }
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
      store.actions.restoreDone(result)
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('恢复被拒绝：')
    expect(alert.textContent).not.toContain('与记录时相比')
  })

  it('a failed restore RPC shows the message and dismisses', () => {
    const { store, face } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
      store.actions.restoreFailed(SUMMARY.id, 'timemachine-not-found: gone')
    })
    expect(screen.getByRole('alert').textContent).toContain('恢复失败：timemachine-not-found: gone')
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(face.onDismissRestoreResult).toHaveBeenCalledTimes(1)
  })

  it('renders the origin badge and the snapshot reason on rows', () => {
    const { store } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([
        { ...SUMMARY, origin: 'manual', reason: 'before the upgrade' },
        { ...FAILED_SUMMARY, origin: 'auto' },
        { ...NEVER_SUMMARY, origin: 'regret' },
      ], [])
    })
    expect(screen.getByText('手动')).toBeTruthy()
    expect(screen.getByText('自动')).toBeTruthy()
    expect(screen.getByText('后悔')).toBeTruthy()
    expect(screen.getByText('before the upgrade')).toBeTruthy()
  })

  it('the diff toggle loads and renders hunks, with the collapse marker muted', () => {
    const { store, face, view } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
    })
    fireEvent.click(screen.getByRole('button', { name: '与当前对比' }))
    expect(face.onDiff).toHaveBeenCalledWith(SUMMARY.id)
    act(() => {
      store.actions.diffLoaded([
        { file: 'manifest', hunks: [
          { type: 'context', text: '{' },
          { type: 'del', text: '"a": 1' },
          { type: 'add', text: '"a": 2' },
          { type: 'context', text: '… (4 unchanged lines)' },
          { type: 'context', text: '}' },
        ] },
      ])
    })
    expect(screen.getByText('package.json')).toBeTruthy()
    const body = screen.getByRole('region', { name: '配置代详情' })
    expect(body.textContent).toContain('+ "a": 2')
    expect(body.textContent).toContain('- "a": 1')
    expect(body.textContent).toContain('… (4 unchanged lines)')
    expect(view.container.querySelector('[data-type="marker"]')?.textContent).toContain('… (4 unchanged lines)')

    fireEvent.click(screen.getByRole('button', { name: '收起对比' }))
    expect(face.onCloseDiff).toHaveBeenCalledTimes(1)
  })

  it('renders the identical-diff note and the diff failure', () => {
    const { store } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
      store.actions.diffLoaded([])
    })
    expect(screen.getByText('与当前配置一致')).toBeTruthy()
    act(() => { store.actions.diffFailed('timemachine-not-found: gone') })
    expect(screen.getByRole('alert').textContent).toContain('差异读取失败：timemachine-not-found: gone')
  })

  it('the remove flow walks confirmation to the removed strip and closes the detail', () => {
    const { store, face } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.select(SUMMARY.id)
      store.actions.detailLoaded(GENERATION)
    })
    fireEvent.click(screen.getByRole('button', { name: '删除此代' }))
    expect(face.onConfirmRemove).toHaveBeenCalledWith(SUMMARY.id)
    act(() => { store.actions.confirmRemove(SUMMARY.id) })
    const dialog = screen.getByRole('dialog', { name: '删除配置代 abcdef01' })
    expect(dialog.textContent).toContain('记录文件将被删除，不可恢复。')
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(face.onRemove).toHaveBeenCalledWith(SUMMARY.id)
    act(() => { store.actions.removeDone(SUMMARY.id, { removed: true }) })
    expect(screen.getByText('已删除 abcdef01')).toBeTruthy()
    // The removed row's detail closes with it; the strip stays at roster level.
    expect(screen.queryByRole('region', { name: '配置代详情' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(face.onDismissRemoveResult).toHaveBeenCalledTimes(1)
  })

  it('a refused remove shows the host reason; a failed remove shows the wire message', () => {
    const { store } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY], [])
      store.actions.removeDone(SUMMARY.id, { removed: false, refusal: 'the booted generation cannot be removed' })
    })
    expect(screen.getByText('删除被拒绝：the booted generation cannot be removed')).toBeTruthy()
    act(() => { store.actions.removeFailed(SUMMARY.id, 'timemachine-not-found: gone') })
    expect(screen.getByRole('alert').textContent).toContain('删除失败：timemachine-not-found: gone')
  })

  it('the boot-failure banner offers the rollback to the last-good generation only', () => {
    const { store, face } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([SUMMARY, NEVER_SUMMARY], [])
      store.actions.statusLoaded({ canUndo: true, canRedo: false, total: 2, lastBootFailed: true })
    })
    expect(screen.getByText('最近一次启动未能激活配置')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '回退到最近可用' }))
    expect(face.onRollback).toHaveBeenCalledWith(SUMMARY.id)
  })

  it('the banner keeps no rollback button when no generation is last-good', () => {
    const { store } = bench()
    openPanel()
    act(() => {
      store.actions.listLoaded([NEVER_SUMMARY], [])
      store.actions.statusLoaded({ canUndo: false, canRedo: false, total: 1, lastBootFailed: true })
    })
    expect(screen.getByText('最近一次启动未能激活配置')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '回退到最近可用' })).toBeNull()
  })

  it('the toolbar snapshot form submits the reason, or none when blank', () => {
    const { face } = bench()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '手动快照' }))
    const input = screen.getByLabelText('快照原因（可选）')
    fireEvent.change(input, { target: { value: '  修前留影  ' } })
    fireEvent.click(screen.getByRole('button', { name: '记录快照' }))
    expect(face.onSnapshot).toHaveBeenCalledWith('修前留影')
    // The form closes on submit.
    expect(screen.queryByLabelText('快照原因（可选）')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '手动快照' }))
    fireEvent.click(screen.getByRole('button', { name: '记录快照' }))
    expect(face.onSnapshot).toHaveBeenCalledWith(undefined)
  })

  it('the snapshot outcome strip shows the record id or the failure', () => {
    const { store, face } = bench()
    openPanel()
    act(() => { store.actions.snapshotDone(SUMMARY.id) })
    expect(screen.getByText('已记录快照 abcdef01')).toBeTruthy()
    act(() => { store.actions.snapshotFailed('internal: disk full') })
    expect(screen.getByRole('alert').textContent).toContain('快照失败：internal: disk full')
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(face.onDismissSnapshotResult).toHaveBeenCalledTimes(1)
  })

  it('the export button triggers onExport and the import picker reads the file as base64', async () => {
    const { face, view } = bench()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '导出历史' }))
    expect(face.onExport).toHaveBeenCalledTimes(1)

    const picker = view.container.querySelector('input[type=file]')!
    // "ABC" → QUJD.
    fireEvent.change(picker, { target: { files: [new File([new Uint8Array([65, 66, 67])], 'history.zip')] } })
    await vi.waitFor(() => { expect(face.onImport).toHaveBeenCalledWith('QUJD') })
  })

  it('the archive strip shows progress, the import tally, and failures', () => {
    const { store, face } = bench()
    openPanel()
    act(() => { store.actions.archiveWorking('export') })
    expect(screen.getByText('正在导出…')).toBeTruthy()
    // A finished export needs no strip — the download was the feedback.
    act(() => { store.actions.archiveDone('export') })
    expect(screen.queryByText('正在导出…')).toBeNull()
    act(() => { store.actions.archiveDone('import', 2, 3) })
    expect(screen.getByText('导入完成：新增 2 条，跳过 3 条')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(face.onDismissArchive).toHaveBeenCalledTimes(1)
    act(() => { store.actions.archiveFailed('import', 'bad archive') })
    expect(screen.getByRole('alert').textContent).toContain('导入失败：bad archive')
  })

  it('the prune button walks the confirmation to the tally strip', () => {
    const { store, face } = bench()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '清理过期' }))
    const dialog = screen.getByRole('dialog', { name: '清理过期配置代' })
    expect(dialog.textContent).toContain('只清理超出保留数量的「启动/自动」记录')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '清理过期配置代' })).toBeNull()
    expect(face.onPrune).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '清理过期' }))
    fireEvent.click(screen.getByRole('button', { name: '确认清理' }))
    expect(face.onPrune).toHaveBeenCalledTimes(1)
    // The confirmation closes when the answer lands; the strip takes over.
    act(() => { store.actions.pruneDone(['abcdef0123456789', '1234567890abcdef']) })
    expect(screen.queryByRole('dialog', { name: '清理过期配置代' })).toBeNull()
    expect(screen.getByText('已清理 2 条过期记录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(face.onDismissPrune).toHaveBeenCalledTimes(1)

    act(() => { store.actions.pruneDone([]) })
    expect(screen.getByText('没有需要清理的记录')).toBeTruthy()
    act(() => { store.actions.pruneFailed('internal: history is read-only') })
    expect(screen.getByRole('alert').textContent).toContain('清理失败：internal: history is read-only')
  })

  const SETTINGS: TimemachineSettings = {
    autoSave: true,
    debounceMs: 1500,
    retention: 50,
    shortcuts: { undo: 'Ctrl+Alt+Z', redo: 'Ctrl+Alt+Y' },
  }

  it('the settings section loads lazily, edits, captures shortcuts, and saves the patch', () => {
    const { store, face } = bench()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(face.onLoadSettings).toHaveBeenCalledTimes(1)
    expect(screen.getByText('读取设置…')).toBeTruthy()
    act(() => { store.actions.settingsLoaded(SETTINGS) })

    const autoSave = screen.getByLabelText('自动存档')
    expect(autoSave).toHaveProperty('checked', true)
    fireEvent.click(autoSave)
    fireEvent.change(screen.getByLabelText('防抖毫秒'), { target: { value: '3000' } })

    const undoCapture = screen.getByLabelText('撤销快捷键')
    expect(undoCapture).toHaveProperty('value', 'Ctrl+Alt+Z')
    fireEvent.keyDown(undoCapture, { key: 'U', ctrlKey: true, altKey: true })
    expect(undoCapture).toHaveProperty('value', 'Ctrl+Alt+U')
    // Backspace restores the default.
    fireEvent.keyDown(undoCapture, { key: 'Backspace' })
    expect(undoCapture).toHaveProperty('value', 'Ctrl+Alt+Z')
    fireEvent.keyDown(undoCapture, { key: 'U', ctrlKey: true, altKey: true })
    // A bare modifier press is a prefix, not a combination.
    fireEvent.keyDown(screen.getByLabelText('恢复快捷键'), { key: 'Control', ctrlKey: true })
    expect(screen.getByLabelText('恢复快捷键')).toHaveProperty('value', 'Ctrl+Alt+Y')

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(face.onSaveSettings).toHaveBeenCalledWith({
      autoSave: false,
      debounceMs: 3000,
      shortcuts: { undo: 'Ctrl+Alt+U' },
    })
  })

  it('a failed settings save keeps the form and shows the message', () => {
    const { store } = bench()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    act(() => { store.actions.settingsLoaded(SETTINGS) })
    act(() => {
      store.actions.settingsSaving()
      store.actions.settingsSaveFailed('bad-request: bad patch')
    })
    expect(screen.getByRole('alert').textContent).toContain('保存失败：bad-request: bad patch')
    // The loaded values stay editable.
    expect(screen.getByLabelText('自动存档')).toHaveProperty('checked', true)
  })

  it('a failed settings load shows the message', () => {
    const { store } = bench()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    act(() => { store.actions.settingsFailed('timemachine-absent: no profile boot') })
    expect(screen.getByRole('alert').textContent).toContain('设置读取失败：timemachine-absent: no profile boot')
  })
})
