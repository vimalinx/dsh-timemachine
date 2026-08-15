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
import type { ConfigGeneration, RestoreResult } from '../src/types.ts'
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
  fireEvent.click(screen.getByRole('button', { name: '配置代' }))
}

describe('TimeMachinePanel', () => {
  it('refreshes on mount and on open, and toggles closed', () => {
    const { face, view } = bench()
    expect(face.onRefresh).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).not.toContain('读取中…')
    openPanel()
    expect(face.onRefresh).toHaveBeenCalledTimes(2)
    expect(screen.getByText('读取中…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '配置代' }))
    expect(screen.queryByText('读取中…')).toBeNull()
  })

  it('renders the rail trigger without the label when the sidebar is folded', () => {
    bench({}, false)
    const trigger = screen.getByRole('button', { name: '配置代' })
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
})
