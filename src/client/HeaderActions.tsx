/**
 * Session-header action: undo / redo / snapshot buttons over the host's
 * `/timemachine` stack endpoints. Availability arrives through the store's
 * `status` poll; every RPC goes through the injected face — the component
 * holds only the snapshot reason draft.
 */

import { useEffect, useState } from 'react'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { HeaderActionsStore, SnapshotState, StackState } from './store.ts'
import { shortGenerationId } from './views.ts'
import css from './HeaderActions.module.css'

/** The header action's injected face: status reads and the three operations. */
export interface TimeMachineHeaderActionsFace {
  /** Re-read the undo/redo availability and boot health. */
  onRefreshStatus: () => void
  /** Open the confirmation for one stack direction. */
  onConfirmStack: (direction: 'undo' | 'redo') => void
  /** Close the stack confirmation without executing. */
  onCancelStack: () => void
  /** Execute the confirmed undo/redo, then re-read status and the roster. */
  onStack: (direction: 'undo' | 'redo') => void
  /** Clear the stack outcome strip. */
  onDismissStackResult: () => void
  /** Open the snapshot reason popover. */
  onOpenSnapshot: () => void
  /** Close the snapshot popover without recording. */
  onCancelSnapshot: () => void
  /** Record a manual snapshot with an optional reason. */
  onSnapshot: (reason: string | undefined) => void
  /** Clear the snapshot outcome strip. */
  onDismissSnapshotResult: () => void
}

/** Full header-action props composed by the session-header action slot. */
export type TimeMachineHeaderActionsProps =
  PropsStore<HeaderActionsStore>
  & InjectFace<TimeMachineHeaderActionsFace>
  & PropsLocale<'timemachine'>

type Translate = TranslateNS<'timemachine'>

/** The undo/redo outcome strip: empty-stack, refusal, success, or failure. */
function StackOutcome({ stack, onDismiss, t }: {
  stack: StackState & { status: 'done' | 'failed' }
  onDismiss: () => void
  t: Translate
}) {
  if (stack.status === 'failed') {
    return (
      <div className={css.outcome} role="alert">
        <p className={css.errorText}>{t('stack.failed', { message: stack.message })}</p>
        <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
      </div>
    )
  }
  const { result } = stack
  // A refused restore (changed: false with a result) outranks the empty-stack
  // note; both are normal business answers.
  if (result.result !== undefined && !result.result.restored) {
    return (
      <div className={css.outcome} role="alert">
        <p className={css.errorText}>{t('stack.refused', { reason: result.result.refusal ?? '' })}</p>
        <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
      </div>
    )
  }
  if (!result.changed) {
    const emptyKey = result.empty === 'nothing-to-redo' ? 'stack.redoEmpty' : 'stack.undoEmpty'
    return (
      <div className={css.outcome} role="status">
        <p className={css.noteText}>{t(emptyKey)}</p>
        <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
      </div>
    )
  }
  const changes = result.result?.changes ?? []
  return (
    <div className={css.outcome} role="status">
      <p className={css.okText}>{t('stack.done')}</p>
      <ul className={css.changes}>
        {changes.map(change => <li key={change}>{change}</li>)}
      </ul>
      <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
    </div>
  )
}

/** The snapshot outcome strip. */
function SnapshotOutcome({ snapshot, onDismiss, t }: {
  snapshot: SnapshotState & { status: 'done' | 'failed' }
  onDismiss: () => void
  t: Translate
}) {
  return (
    <div className={css.outcome} role={snapshot.status === 'failed' ? 'alert' : 'status'}>
      {snapshot.status === 'done'
        ? <p className={css.okText}>{t('snapshot.done', { id: shortGenerationId(snapshot.id) })}</p>
        : <p className={css.errorText}>{t('snapshot.failed', { message: snapshot.message })}</p>}
      <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
    </div>
  )
}

/** Render the undo/redo/snapshot buttons and their popovers. */
export function HeaderActions({
  useStore,
  onRefreshStatus,
  onConfirmStack,
  onCancelStack,
  onStack,
  onDismissStackResult,
  onOpenSnapshot,
  onCancelSnapshot,
  onSnapshot,
  onDismissSnapshotResult,
  t,
}: TimeMachineHeaderActionsProps) {
  const state = useStore(snapshot => snapshot)
  const [reason, setReason] = useState('')

  useEffect(() => { onRefreshStatus() }, [onRefreshStatus])

  const working = state.stack.status === 'working' || state.snapshot.status === 'working'
  const confirm = state.confirm

  const submitSnapshot = (): void => {
    const note = reason.trim()
    onSnapshot(note === '' ? undefined : note)
    setReason('')
  }

  return (
    <div className={css.root}>
      <button
        type="button"
        className={`${css.button} ${css.undoButton}`}
        aria-label={t('header.undo')}
        title={t('header.undo')}
        disabled={working || state.status?.canUndo !== true}
        onClick={() => { onConfirmStack('undo') }}
      >
        <IconChevronLeftOutline14 />
      </button>
      <button
        type="button"
        className={`${css.button} ${css.redoButton}`}
        aria-label={t('header.redo')}
        title={t('header.redo')}
        disabled={working || state.status?.canRedo !== true}
        onClick={() => { onConfirmStack('redo') }}
      >
        <IconChevronRightOutline14 />
      </button>
      <button
        type="button"
        className={css.button}
        aria-label={t('header.snapshot')}
        title={t('header.snapshot')}
        disabled={working}
        onClick={() => { onOpenSnapshot() }}
      >
        <IconPlusOutline16 />
      </button>
      {confirm !== undefined && (
        <div
          className={css.popover}
          role="dialog"
          aria-label={t(confirm === 'undo' ? 'stack.confirmUndoTitle' : 'stack.confirmRedoTitle')}
        >
          <p className={css.noteText}>{t(confirm === 'undo' ? 'stack.confirmUndoNote' : 'stack.confirmRedoNote')}</p>
          <div className={css.popoverActions}>
            <button
              type="button"
              className={css.actionButton}
              disabled={state.stack.status === 'working'}
              onClick={() => { onStack(confirm) }}
            >
              {state.stack.status === 'working'
                ? t('stack.working')
                : t(confirm === 'undo' ? 'action.undo' : 'action.redo')}
            </button>
            <button
              type="button"
              className={css.textButton}
              disabled={state.stack.status === 'working'}
              onClick={() => { onCancelStack() }}
            >
              {t('action.cancel')}
            </button>
          </div>
        </div>
      )}
      {state.snapshotOpen && (
        <div className={css.popover} role="dialog" aria-label={t('header.snapshot')}>
          <input
            type="text"
            className={css.reasonInput}
            aria-label={t('snapshot.placeholder')}
            placeholder={t('snapshot.placeholder')}
            value={reason}
            onChange={event => { setReason(event.target.value) }}
          />
          <div className={css.popoverActions}>
            <button
              type="button"
              className={css.actionButton}
              disabled={state.snapshot.status === 'working'}
              onClick={submitSnapshot}
            >
              {state.snapshot.status === 'working' ? t('snapshot.working') : t('action.recordSnapshot')}
            </button>
            <button
              type="button"
              className={css.textButton}
              disabled={state.snapshot.status === 'working'}
              onClick={() => { onCancelSnapshot() }}
            >
              {t('action.cancel')}
            </button>
          </div>
        </div>
      )}
      {(state.stack.status === 'done' || state.stack.status === 'failed') && (
        <StackOutcome stack={state.stack} onDismiss={() => { onDismissStackResult() }} t={t} />
      )}
      {(state.snapshot.status === 'done' || state.snapshot.status === 'failed') && (
        <SnapshotOutcome snapshot={state.snapshot} onDismiss={() => { onDismissSnapshotResult() }} t={t} />
      )}
    </div>
  )
}
