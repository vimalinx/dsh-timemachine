// @vitest-environment jsdom
/**
 * HeaderActions behavior spec: the undo/redo/snapshot buttons follow the
 * polled availability, the stack confirmation walks open → confirm/cancel →
 * outcome (empty, refused, changed, failed), and the snapshot popover carries
 * the optional reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { HeaderActions } from '../src/client/HeaderActions.tsx'
import type { TimeMachineHeaderActionsFace } from '../src/client/HeaderActions.tsx'
import { createHeaderActionsStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t = makeTranslate(zh)

afterEach(cleanup)

function bench(faceOverrides: Partial<TimeMachineHeaderActionsFace> = {}) {
  const store = createHeaderActionsStore().create()
  const face: TimeMachineHeaderActionsFace = {
    onRefreshStatus: vi.fn(),
    onConfirmStack: vi.fn(),
    onCancelStack: vi.fn(),
    onStack: vi.fn(),
    onDismissStackResult: vi.fn(),
    onOpenSnapshot: vi.fn(),
    onCancelSnapshot: vi.fn(),
    onSnapshot: vi.fn(),
    onDismissSnapshotResult: vi.fn(),
    ...faceOverrides,
  }
  const view = render(
    <HeaderActions
      useStore={bindSnapshotSelector(store)}
      actions={store.actions}
      t={t as never}
      {...face}
    />,
  )
  return { store, face, view }
}

describe('HeaderActions', () => {
  it('polls the status on mount', () => {
    const { face } = bench()
    expect(face.onRefreshStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps undo/redo disabled until a poll answers, then follows canUndo/canRedo', () => {
    const { store } = bench()
    expect(screen.getByRole('button', { name: '撤销' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '恢复' })).toHaveProperty('disabled', true)
    act(() => { store.actions.statusLoaded({ canUndo: true, canRedo: false, total: 3, lastBootFailed: false }) })
    expect(screen.getByRole('button', { name: '撤销' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: '恢复' })).toHaveProperty('disabled', true)
  })

  it('the undo confirmation opens, confirms, and locks while working', () => {
    const { store, face } = bench()
    act(() => { store.actions.statusLoaded({ canUndo: true, canRedo: true, total: 3, lastBootFailed: false }) })
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(face.onConfirmStack).toHaveBeenCalledWith('undo')
    act(() => { store.actions.confirmStack('undo') })
    const dialog = screen.getByRole('dialog', { name: '撤销配置' })
    expect(dialog.textContent).toContain('将写回上一个配置代的输入文件，下次启动生效。')
    fireEvent.click(within(dialog).getByRole('button', { name: '撤销' }))
    expect(face.onStack).toHaveBeenCalledWith('undo')
    act(() => {
      store.actions.confirmStack('undo')
      store.actions.stackWorking('undo')
    })
    expect(screen.getByRole('button', { name: '正在写回…' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
    // The trigger locks too while an operation runs.
    expect(screen.getByRole('button', { name: '撤销' })).toHaveProperty('disabled', true)
  })

  it('the redo confirmation opens and cancels', () => {
    const { store, face } = bench()
    act(() => {
      store.actions.statusLoaded({ canUndo: true, canRedo: true, total: 3, lastBootFailed: false })
      store.actions.confirmStack('redo')
    })
    const dialog = screen.getByRole('dialog', { name: '恢复配置' })
    expect(dialog.textContent).toContain('将写回重做栈顶配置代的输入文件，下次启动生效。')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(face.onCancelStack).toHaveBeenCalledTimes(1)
  })

  it('the snapshot popover submits the reason, or none when blank, and cancels', () => {
    const { store, face } = bench()
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    expect(face.onOpenSnapshot).toHaveBeenCalledTimes(1)
    act(() => { store.actions.openSnapshot() })
    const input = screen.getByLabelText('快照原因（可选）')
    fireEvent.change(input, { target: { value: '  手动存档  ' } })
    fireEvent.click(screen.getByRole('button', { name: '记录快照' }))
    expect(face.onSnapshot).toHaveBeenCalledWith('手动存档')

    act(() => { store.actions.openSnapshot() })
    fireEvent.click(screen.getByRole('button', { name: '记录快照' }))
    expect(face.onSnapshot).toHaveBeenCalledWith(undefined)

    act(() => { store.actions.openSnapshot() })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(face.onCancelSnapshot).toHaveBeenCalledTimes(1)
  })

  it('the empty-stack and refusal outcomes read as plain notes', () => {
    const { store, face } = bench()
    act(() => {
      store.actions.stackDone('undo', { changed: false, empty: 'nothing-to-undo' })
    })
    expect(screen.getByText('没有可撤销的配置')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(face.onDismissStackResult).toHaveBeenCalledTimes(1)

    act(() => {
      store.actions.stackDone('redo', { changed: false, empty: 'nothing-to-redo' })
    })
    expect(screen.getByText('没有可恢复的配置')).toBeTruthy()

    act(() => {
      store.actions.stackDone('undo', {
        changed: false,
        result: { id: 'abcdef0123456789', restored: false, changes: [], refusal: 'bundle drift' },
      })
    })
    expect(screen.getByRole('alert').textContent).toContain('操作被拒绝：bundle drift')
  })

  it('a changed outcome lists the written files; a failure shows the message', () => {
    const { store } = bench()
    act(() => {
      store.actions.stackDone('undo', {
        changed: true,
        result: { id: 'abcdef0123456789', restored: true, changes: ['wrote package.json', 'removed cordis.patch.yml'] },
      })
    })
    expect(screen.getByText('已写回以下文件，下次启动生效：')).toBeTruthy()
    expect(screen.getByText('wrote package.json')).toBeTruthy()
    expect(screen.getByText('removed cordis.patch.yml')).toBeTruthy()

    act(() => { store.actions.stackFailed('redo', 'internal: disk full') })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：internal: disk full')
  })

  it('the snapshot outcome strip shows the record id or the failure', () => {
    const { store, face } = bench()
    act(() => { store.actions.snapshotDone('abcdef0123456789') })
    expect(screen.getByText('已记录快照 abcdef01')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(face.onDismissSnapshotResult).toHaveBeenCalledTimes(1)
    act(() => { store.actions.snapshotFailed('internal: disk full') })
    expect(screen.getByRole('alert').textContent).toContain('快照失败：internal: disk full')
  })
})
