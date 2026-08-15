/**
 * Configuration-generation panel: the sidebar footer trigger, the roster, the
 * selected generation's detail, and the restore confirmation/result flow. All
 * data arrives through the store share; every RPC goes through the injected
 * face — the component holds only its open flag.
 */

import { useEffect, useState } from 'react'
import { IconBranchOutline16, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-sidebar SlotMap merge (the 'sidebar.footer.action'
// declaration) into this program so the props composition typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { GenerationSummary } from '../rpc.ts'
import type { BundleDrift, ConfigGeneration } from '../types.ts'
import type { TimeMachineStore, DetailState, RestoreState } from './store.ts'
import { formatTimestamp, restoreTargets, shortGenerationId, summaryStatusKey } from './views.ts'
import css from './TimeMachinePanel.module.css'

/**
 * The panel's injected face: read triggers and the restore flow. Callbacks
 * write results through the store's baked actions; the component never sees
 * the RPC layer.
 */
export interface TimeMachinePanelFace {
  /** Re-read the roster unless a read is already in flight. */
  onRefresh: () => void
  /** Expand a row and read its full record. */
  onSelect: (id: string) => void
  /** Collapse the detail region. */
  onDeselect: () => void
  /** Open the restore confirmation for a generation. */
  onConfirmRestore: (id: string) => void
  /** Close the restore confirmation without restoring. */
  onCancelRestore: () => void
  /** Execute the confirmed restore, then re-read the roster. */
  onRestore: (id: string) => void
  /** Clear the restore outcome strip. */
  onDismissRestoreResult: () => void
}

/** Full panel props composed by the sidebar footer-action slot. */
export type TimeMachinePanelProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<TimeMachineStore>
  & InjectFace<TimeMachinePanelFace>
  & PropsLocale<'timemachine'>

type Translate = TimeMachinePanelProps['t']

/** One bundle's drift line: missing sides read as added/removed, a null version as unversioned. */
function driftLine(drift: BundleDrift, t: Translate): string {
  const recorded = drift.recorded === undefined
    ? t('restore.driftAdded')
    : drift.recorded ?? t('version.none')
  const current = drift.current === undefined
    ? t('restore.driftRemoved')
    : drift.current ?? t('version.none')
  return t('restore.driftLine', { name: drift.name, recorded, current })
}

function Detail({ generation, t }: { generation: ConfigGeneration; t: Translate }) {
  return (
    <>
      <h4 className={css.detailHeading}>{t('detail.bundles')}</h4>
      <table className={css.bundles}>
        <tbody>
          {generation.bundles.map(bundle => (
            <tr key={bundle.name}>
              <td>{bundle.name}</td>
              <td>{bundle.version ?? t('version.none')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 className={css.detailHeading}>{t('detail.outcomes')}</h4>
      {generation.outcomes.length === 0 && <p className={css.note}>{t('detail.noOutcomes')}</p>}
      {generation.outcomes.length > 0 && (
        <ul className={css.outcomes}>
          {generation.outcomes.map((outcome, index) => (
            <li key={`${outcome.at}-${index}`} className={css.outcome}>
              <span className={css.outcomeTime}>{formatTimestamp(outcome.at)}</span>
              <span
                className={css.outcomeStatus}
                data-status={outcome.status}
              >{t(outcome.status === 'activated' ? 'status.activated' : 'status.failed')}</span>
              {outcome.error !== undefined && <span className={css.outcomeError}>{outcome.error}</span>}
              {outcome.overlays.length > 0 && (
                <span className={css.outcomeOverlays}>{t('outcome.overlays', { overlays: outcome.overlays.join(', ') })}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <h4 className={css.detailHeading}>{t('detail.render')}</h4>
      <pre className={css.render}>{generation.composed.render}</pre>
    </>
  )
}

function RestoreOutcome({ restore, onDismiss, t }: {
  restore: RestoreState & { status: 'done' | 'failed' }
  onDismiss: () => void
  t: Translate
}) {
  if (restore.status === 'failed') {
    return (
      <div className={css.restoreResult} role="alert">
        <p className={css.error}>{t('restore.failed', { message: restore.message })}</p>
        <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
      </div>
    )
  }
  const { result } = restore
  if (!result.restored) {
    return (
      <div className={css.restoreResult} role="alert">
        <p className={css.error}>{t('restore.refused', { reason: result.refusal ?? '' })}</p>
        {result.verdict !== undefined && result.verdict.drift.length > 0 && (
          <>
            <p className={css.note}>{t('restore.drift')}</p>
            <ul className={css.drift}>
              {result.verdict.drift.map(drift => <li key={drift.name}>{driftLine(drift, t)}</li>)}
            </ul>
          </>
        )}
        <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
      </div>
    )
  }
  return (
    <div className={css.restoreResult} role="status">
      <p className={css.restoredNote}>{t('restore.done')}</p>
      <ul className={css.changes}>
        {result.changes.map(change => <li key={change}>{change}</li>)}
      </ul>
      <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
    </div>
  )
}

/** Render the footer trigger and, while open, the roster panel above it. */
export function TimeMachinePanel({
  wide,
  useStore,
  onRefresh,
  onSelect,
  onDeselect,
  onConfirmRestore,
  onCancelRestore,
  onRestore,
  onDismissRestoreResult,
  t,
}: TimeMachinePanelProps) {
  const state = useStore(snapshot => snapshot)
  const [open, setOpen] = useState(false)

  useEffect(() => { onRefresh() }, [onRefresh])
  useEffect(() => { if (open) onRefresh() }, [onRefresh, open])

  const detail: DetailState = state.detail
  const confirmId = state.confirmId
  const working = state.restore.status === 'working'

  const renderRow = (summary: GenerationSummary) => {
    const selected = summary.id === state.selectedId
    return (
      <li key={summary.id}>
        <button
          type="button"
          className={css.row}
          data-selected={selected || undefined}
          aria-expanded={selected}
          onClick={() => { if (selected) onDeselect(); else onSelect(summary.id) }}
        >
          <span className={css.rowId}>{shortGenerationId(summary.id)}</span>
          <span className={css.rowTime}>{formatTimestamp(summary.lastSeenAt)}</span>
          <span className={css.rowStatus} data-status={summaryStatusKey(summary)}>{t(summaryStatusKey(summary))}</span>
          {summary.lastGood && <span className={css.rowBadge}>{t('badge.lastGood')}</span>}
          {summary.booted && <span className={css.rowBadge}>{t('badge.booted')}</span>}
        </button>
      </li>
    )
  }

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open && (
        <section className={css.panel} aria-label={t('panel.title')}>
          <header className={css.header}>
            <span className={css.title}>{t('panel.title')}</span>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('action.refresh')}
              disabled={state.list === 'loading'}
              onClick={() => { onRefresh() }}
            >
              <IconRefreshOutline14 />
            </button>
          </header>
          <div className={css.body}>
            {state.unreadable.length > 0 && (
              <p className={css.warning} role="alert">{t('panel.unreadable', { count: state.unreadable.length })}</p>
            )}
            {state.listError !== undefined && (
              <p className={css.error} role="alert">{t('panel.error', { message: state.listError })}</p>
            )}
            {(state.list === 'idle' || state.list === 'loading') && (
              <p className={css.note}>{t('panel.loading')}</p>
            )}
            {state.list === 'absent' && <p className={css.note}>{t('panel.absent')}</p>}
            {state.list === 'loaded' && state.generations.length === 0 && (
              <p className={css.note}>{t('panel.empty')}</p>
            )}
            {state.generations.length > 0 && <ul className={css.rows}>{state.generations.map(renderRow)}</ul>}
            {state.selectedId !== undefined && (
              <section className={css.detail} aria-label={t('detail.title')}>
                {detail.status === 'loading' && <p className={css.note}>{t('detail.loading')}</p>}
                {detail.status === 'failed' && (
                  <p className={css.error} role="alert">{t('detail.error', { message: detail.message })}</p>
                )}
                {detail.status === 'loaded' && (
                  <>
                    <Detail generation={detail.generation} t={t} />
                    <button
                      type="button"
                      className={css.restoreButton}
                      disabled={working}
                      onClick={() => { onConfirmRestore(detail.generation.id) }}
                    >
                      {t('action.restore')}
                    </button>
                  </>
                )}
                {confirmId !== undefined && detail.status === 'loaded' && (
                  <div
                    className={css.confirm}
                    role="dialog"
                    aria-label={t('confirm.title', { id: shortGenerationId(confirmId) })}
                  >
                    <p className={css.note}>{t('confirm.files')}</p>
                    <ul className={css.confirmFiles}>
                      {restoreTargets(detail.generation).map(path => <li key={path}><code>{path}</code></li>)}
                    </ul>
                    <p className={css.note}>{t('confirm.note')}</p>
                    <div className={css.confirmActions}>
                      <button
                        type="button"
                        className={css.restoreButton}
                        disabled={working}
                        onClick={() => { onRestore(confirmId) }}
                      >
                        {working ? t('restore.working') : t('action.confirm')}
                      </button>
                      <button
                        type="button"
                        className={css.textButton}
                        disabled={working}
                        onClick={() => { onCancelRestore() }}
                      >
                        {t('action.cancel')}
                      </button>
                    </div>
                  </div>
                )}
                {(state.restore.status === 'done' || state.restore.status === 'failed') && (
                  <RestoreOutcome restore={state.restore} onDismiss={() => { onDismissRestoreResult() }} t={t} />
                )}
              </section>
            )}
          </div>
        </section>
      )}
      <div className={css.footerButtons}>
        <button
          type="button"
          className={css.badge}
          aria-label={t('trigger.aria')}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconBranchOutline16 />
          {wide && <span className={css.badgeLabel}>{t('trigger.aria')}</span>}
        </button>
      </div>
    </div>
  )
}
