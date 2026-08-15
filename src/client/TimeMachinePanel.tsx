/**
 * Configuration-generation panel: the sidebar footer trigger, the roster with
 * origin badges and reasons, the selected generation's detail with its diff
 * preview and remove flow, the toolbar (manual snapshot / export / import /
 * prune), the boot-failure banner, and the settings section. All data arrives
 * through the store share; every RPC goes through the injected face — the
 * component holds only its viewing state (open flags, drafts).
 */

import { useEffect, useRef, useState } from 'react'
import {
  IconBranchOutline16,
  IconDownloadOutline16,
  IconPlusOutline16,
  IconRefreshOutline14,
  IconRightUpOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-sidebar SlotMap merge (the 'sidebar.footer.action'
// declaration) into this program so the props composition typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { GenerationSummary } from '../rpc.ts'
import type { BundleDrift, ConfigGeneration, TimemachineSettings, TimemachineSettingsPatch } from '../types.ts'
import type { InputDiff } from '../diff.ts'
import type { TimeMachineStore, ArchiveState, DetailState, PruneState, RemoveState, RestoreState, SnapshotState, TimeMachineState } from './store.ts'
import {
  DEFAULT_SHORTCUTS,
  diffFileKey,
  formatTimestamp,
  isCollapsedMarker,
  originKey,
  restoreTargets,
  shortGenerationId,
  shortcutFromEvent,
  summaryStatusKey,
} from './views.ts'
import { readFileBase64 } from './download.ts'
import css from './TimeMachinePanel.module.css'

/**
 * The panel's injected face: read triggers and the restore/remove/diff/
 * snapshot/archive/settings flows. Callbacks write results through the
 * store's baked actions; the component never sees the RPC layer.
 */
export interface TimeMachinePanelFace {
  /** Re-read the roster and status unless a read is already in flight. */
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
  /** The banner shortcut: select the last-good generation and confirm its restore. */
  onRollback: (id: string) => void
  /** Load the selected generation's diff against the live configuration. */
  onDiff: (id: string) => void
  /** Collapse the diff preview. */
  onCloseDiff: () => void
  /** Open the remove confirmation for a generation. */
  onConfirmRemove: (id: string) => void
  /** Close the remove confirmation without deleting. */
  onCancelRemove: () => void
  /** Execute the confirmed remove, then re-read the roster. */
  onRemove: (id: string) => void
  /** Clear the remove outcome strip. */
  onDismissRemoveResult: () => void
  /** Record a manual snapshot with an optional reason. */
  onSnapshot: (reason: string | undefined) => void
  /** Clear the snapshot outcome strip. */
  onDismissSnapshotResult: () => void
  /** Export the history as a zip download. */
  onExport: () => void
  /** Import a base64 archive, then re-read the roster. */
  onImport: (data: string) => void
  /** Clear the archive outcome strip. */
  onDismissArchive: () => void
  /** Apply the retention bound now (after the in-panel confirmation). */
  onPrune: () => void
  /** Clear the prune outcome strip. */
  onDismissPrune: () => void
  /** Read the plugin settings (the settings section's first open). */
  onLoadSettings: () => void
  /** Save a settings patch. */
  onSaveSettings: (patch: TimemachineSettingsPatch) => void
}

/** Full panel props composed by the sidebar footer-action slot. */
export type TimeMachinePanelProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<TimeMachineStore>
  & InjectFace<TimeMachinePanelFace>
  & PropsLocale<'timemachine'>

type Translate = TranslateNS<'timemachine'>

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

/** The selected generation's diff against the live configuration, hunk by hunk. */
function DiffView({ diffs, t }: { diffs: InputDiff[]; t: Translate }) {
  if (diffs.length === 0) return <p className={css.note}>{t('diff.identical')}</p>
  return (
    <>
      {diffs.map(diff => (
        <section key={diff.file} aria-label={t(diffFileKey(diff.file))}>
          <h5 className={css.diffFile}>{t(diffFileKey(diff.file))}</h5>
          <pre className={css.diffBody}>
            {diff.hunks.map((hunk, index) => (
              <div
                key={index}
                className={css.diffLine}
                data-type={isCollapsedMarker(hunk.text) ? 'marker' : hunk.type}
              >
                {hunk.type === 'add' ? '+ ' : hunk.type === 'del' ? '- ' : '  '}
                {hunk.text}
              </div>
            ))}
          </pre>
        </section>
      ))}
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

/** The remove outcome strip: deleted, refused (with the host's reason), or failed. */
function RemoveOutcome({ remove, onDismiss, t }: {
  remove: RemoveState & { status: 'done' | 'failed' }
  onDismiss: () => void
  t: Translate
}) {
  return (
    <div className={css.restoreResult} role={remove.status === 'failed' ? 'alert' : 'status'}>
      {remove.status === 'failed' && <p className={css.error}>{t('remove.failed', { message: remove.message })}</p>}
      {remove.status === 'done' && remove.result.removed && (
        <p className={css.restoredNote}>{t('remove.done', { id: shortGenerationId(remove.id) })}</p>
      )}
      {remove.status === 'done' && !remove.result.removed && (
        <p className={css.error}>{t('remove.refused', { reason: remove.result.refusal ?? '' })}</p>
      )}
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
    <div className={css.restoreResult} role={snapshot.status === 'failed' ? 'alert' : 'status'}>
      {snapshot.status === 'done'
        ? <p className={css.restoredNote}>{t('snapshot.done', { id: shortGenerationId(snapshot.id) })}</p>
        : <p className={css.error}>{t('snapshot.failed', { message: snapshot.message })}</p>}
      <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
    </div>
  )
}

/** The export/import progress and outcome strip. */
function ArchiveOutcome({ archive, onDismiss, t }: {
  archive: ArchiveState & { status: 'working' | 'done' | 'failed' }
  onDismiss: () => void
  t: Translate
}) {
  if (archive.status === 'working') {
    return <p className={css.note} role="status">{t(archive.direction === 'export' ? 'archive.exportWorking' : 'archive.importWorking')}</p>
  }
  // A finished export already delivered its feedback as the download itself.
  if (archive.status === 'done' && archive.direction === 'export') return undefined
  return (
    <div className={css.restoreResult} role={archive.status === 'failed' ? 'alert' : 'status'}>
      {archive.status === 'done'
        ? <p className={css.restoredNote}>{t('archive.importDone', { imported: archive.imported ?? 0, skipped: archive.skipped ?? 0 })}</p>
        : <p className={css.error}>{t(archive.direction === 'export' ? 'archive.exportFailed' : 'archive.importFailed', { message: archive.message })}</p>}
      <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
    </div>
  )
}

/** The prune outcome strip: how many records housekeeping removed, or the failure. */
function PruneOutcome({ prune, onDismiss, t }: {
  prune: PruneState & { status: 'done' | 'failed' }
  onDismiss: () => void
  t: Translate
}) {
  return (
    <div className={css.restoreResult} role={prune.status === 'failed' ? 'alert' : 'status'}>
      {prune.status === 'done'
        ? <p className={css.restoredNote}>{t(prune.removed.length === 0 ? 'prune.none' : 'prune.done', { count: prune.removed.length })}</p>
        : <p className={css.error}>{t('prune.failed', { message: prune.message })}</p>}
      <button type="button" className={css.textButton} onClick={onDismiss}>{t('action.dismiss')}</button>
    </div>
  )
}

/**
 * A capture-style shortcut input: readonly, records the next pressed
 * combination, Backspace restores the default.
 */
function ShortcutCapture({ label, value, defaultValue, onChange }: {
  label: string
  value: string
  defaultValue: string
  onChange: (combo: string) => void
}) {
  return (
    <input
      type="text"
      className={css.shortcutInput}
      readOnly
      aria-label={label}
      value={value}
      onKeyDown={(event) => {
        event.preventDefault()
        if (event.key === 'Backspace') {
          onChange(defaultValue)
          return
        }
        // A pure modifier press is a prefix, not a combination.
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return
        onChange(shortcutFromEvent(event.nativeEvent))
      }}
    />
  )
}

/** The settings section: autosave toggle, tunables, and the shortcut captures. */
function SettingsSection({ state, draft, setDraft, onSave, t }: {
  state: TimeMachineState
  draft: TimemachineSettings | undefined
  setDraft: (settings: TimemachineSettings) => void
  onSave: (patch: TimemachineSettingsPatch) => void
  t: Translate
}) {
  if (state.settings.status === 'idle' || state.settings.status === 'loading') {
    return <p className={css.note}>{t('settings.loading')}</p>
  }
  if (state.settings.status === 'failed') {
    return <p className={css.error} role="alert">{t('settings.loadFailed', { message: state.settings.message })}</p>
  }
  if (draft === undefined) return <p className={css.note}>{t('settings.loading')}</p>
  const loaded = state.settings.settings
  const save = (): void => {
    const patch: TimemachineSettingsPatch = {}
    if (draft.autoSave !== loaded.autoSave) patch.autoSave = draft.autoSave
    if (draft.debounceMs !== loaded.debounceMs) patch.debounceMs = draft.debounceMs
    if (draft.retention !== loaded.retention) patch.retention = draft.retention
    const shortcuts: { undo?: string; redo?: string } = {}
    if (draft.shortcuts.undo !== loaded.shortcuts.undo) shortcuts.undo = draft.shortcuts.undo
    if (draft.shortcuts.redo !== loaded.shortcuts.redo) shortcuts.redo = draft.shortcuts.redo
    if (Object.keys(shortcuts).length > 0) patch.shortcuts = shortcuts
    onSave(patch)
  }
  return (
    <div className={css.settingsForm}>
      <label className={css.settingsRow}>
        <input
          type="checkbox"
          checked={draft.autoSave}
          onChange={(event) => { setDraft({ ...draft, autoSave: event.target.checked }) }}
        />
        <span>{t('settings.autoSave')}</span>
      </label>
      <label className={css.settingsRow}>
        <span>{t('settings.debounceMs')}</span>
        <input
          type="number"
          className={css.numberInput}
          min={1}
          value={draft.debounceMs}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isInteger(value) && value > 0) setDraft({ ...draft, debounceMs: value })
          }}
        />
      </label>
      <label className={css.settingsRow}>
        <span>{t('settings.retention')}</span>
        <input
          type="number"
          className={css.numberInput}
          min={1}
          value={draft.retention}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isInteger(value) && value > 0) setDraft({ ...draft, retention: value })
          }}
        />
      </label>
      <label className={css.settingsRow}>
        <span>{t('settings.undoShortcut')}</span>
        <ShortcutCapture
          label={t('settings.undoShortcut')}
          value={draft.shortcuts.undo}
          defaultValue={DEFAULT_SHORTCUTS.undo}
          onChange={(combo) => { setDraft({ ...draft, shortcuts: { ...draft.shortcuts, undo: combo } }) }}
        />
      </label>
      <label className={css.settingsRow}>
        <span>{t('settings.redoShortcut')}</span>
        <ShortcutCapture
          label={t('settings.redoShortcut')}
          value={draft.shortcuts.redo}
          defaultValue={DEFAULT_SHORTCUTS.redo}
          onChange={(combo) => { setDraft({ ...draft, shortcuts: { ...draft.shortcuts, redo: combo } }) }}
        />
      </label>
      <p className={css.note}>{t('settings.shortcutHint')}</p>
      {state.settings.error !== undefined && (
        <p className={css.error} role="alert">{t('settings.saveFailed', { message: state.settings.error })}</p>
      )}
      <button
        type="button"
        className={css.restoreButton}
        disabled={state.settings.saving}
        onClick={save}
      >
        {state.settings.saving ? t('settings.saving') : t('action.saveSettings')}
      </button>
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
  onRollback,
  onDiff,
  onCloseDiff,
  onConfirmRemove,
  onCancelRemove,
  onRemove,
  onDismissRemoveResult,
  onSnapshot,
  onDismissSnapshotResult,
  onExport,
  onImport,
  onDismissArchive,
  onPrune,
  onDismissPrune,
  onLoadSettings,
  onSaveSettings,
  t,
}: TimeMachinePanelProps) {
  const state = useStore(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [snapshotFormOpen, setSnapshotFormOpen] = useState(false)
  const [pruneConfirmOpen, setPruneConfirmOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState<TimemachineSettings | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { onRefresh() }, [onRefresh])
  useEffect(() => { if (open) onRefresh() }, [onRefresh, open])

  // The prune confirmation stays up while the host works and closes when the
  // answer lands (the outcome strip takes over from there).
  const pruneStatus = state.prune.status
  useEffect(() => {
    if (pruneStatus === 'done' || pruneStatus === 'failed') setPruneConfirmOpen(false)
  }, [pruneStatus])

  // The draft follows every fresh settings read (initial load and saves).
  const loadedSettings = state.settings.status === 'loaded' ? state.settings.settings : undefined
  useEffect(() => { setDraft(loadedSettings) }, [loadedSettings])

  const detail: DetailState = state.detail
  const confirmId = state.confirmId
  const working = state.restore.status === 'working'
  const removing = state.remove.status === 'working'
  const lastGoodId = state.generations.find(generation => generation.lastGood)?.id

  const submitSnapshot = (): void => {
    const note = reason.trim()
    onSnapshot(note === '' ? undefined : note)
    setReason('')
    setSnapshotFormOpen(false)
  }

  const toggleSettings = (): void => {
    const next = !settingsOpen
    setSettingsOpen(next)
    if (next && state.settings.status === 'idle') onLoadSettings()
  }

  const pickImportFile = (): void => {
    fileInputRef.current?.click()
  }

  const onImportFile = (file: Blob): void => {
    void readFileBase64(file).then(onImport)
  }

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
          <span className={css.originBadge} data-origin={summary.origin}>{t(originKey(summary.origin))}</span>
          <span className={css.rowStatus} data-status={summaryStatusKey(summary)}>{t(summaryStatusKey(summary))}</span>
          {summary.lastGood && <span className={css.rowBadge}>{t('badge.lastGood')}</span>}
          {summary.booted && <span className={css.rowBadge}>{t('badge.booted')}</span>}
          {summary.reason !== undefined && <span className={css.rowReason}>{summary.reason}</span>}
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
            <div className={css.toolbar}>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('toolbar.snapshot')}
                disabled={state.snapshot.status === 'working'}
                onClick={() => { setSnapshotFormOpen(value => !value) }}
              >
                <IconPlusOutline16 />
              </button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('toolbar.export')}
                disabled={state.archive.status === 'working'}
                onClick={() => { onExport() }}
              >
                <IconRightUpOutline16 />
              </button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('toolbar.import')}
                disabled={state.archive.status === 'working'}
                onClick={pickImportFile}
              >
                <IconDownloadOutline16 />
              </button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('toolbar.prune')}
                disabled={state.prune.status === 'working'}
                onClick={() => { setPruneConfirmOpen(true) }}
              >
                <IconTrashOutline16 />
              </button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('action.refresh')}
                disabled={state.list === 'loading'}
                onClick={() => { onRefresh() }}
              >
                <IconRefreshOutline14 />
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className={css.hiddenInput}
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file !== undefined) onImportFile(file)
              }}
            />
          </header>
          <div className={css.body}>
            {state.status?.lastBootFailed === true && (
              <div className={css.bootBanner} role="alert">
                <span>{t('banner.bootFailed')}</span>
                {lastGoodId !== undefined && (
                  <button
                    type="button"
                    className={css.textButton}
                    onClick={() => { onRollback(lastGoodId) }}
                  >
                    {t('banner.rollback')}
                  </button>
                )}
              </div>
            )}
            {snapshotFormOpen && (
              <div className={css.snapshotForm}>
                <input
                  type="text"
                  className={css.reasonInput}
                  aria-label={t('snapshot.placeholder')}
                  placeholder={t('snapshot.placeholder')}
                  value={reason}
                  onChange={event => { setReason(event.target.value) }}
                />
                <button
                  type="button"
                  className={css.restoreButton}
                  disabled={state.snapshot.status === 'working'}
                  onClick={submitSnapshot}
                >
                  {state.snapshot.status === 'working' ? t('snapshot.working') : t('action.recordSnapshot')}
                </button>
                <button
                  type="button"
                  className={css.textButton}
                  onClick={() => { setSnapshotFormOpen(false) }}
                >
                  {t('action.cancel')}
                </button>
              </div>
            )}
            {(state.snapshot.status === 'done' || state.snapshot.status === 'failed') && (
              <SnapshotOutcome snapshot={state.snapshot} onDismiss={() => { onDismissSnapshotResult() }} t={t} />
            )}
            {state.archive.status !== 'idle' && (
              <ArchiveOutcome archive={state.archive} onDismiss={() => { onDismissArchive() }} t={t} />
            )}
            {pruneConfirmOpen && (
              <div
                className={css.confirm}
                role="dialog"
                aria-label={t('prune.confirmTitle')}
              >
                <p className={css.note}>{t('prune.confirmNote')}</p>
                <div className={css.confirmActions}>
                  <button
                    type="button"
                    className={css.restoreButton}
                    disabled={state.prune.status === 'working'}
                    onClick={() => { onPrune() }}
                  >
                    {state.prune.status === 'working' ? t('prune.working') : t('action.confirmPrune')}
                  </button>
                  <button
                    type="button"
                    className={css.textButton}
                    disabled={state.prune.status === 'working'}
                    onClick={() => { setPruneConfirmOpen(false) }}
                  >
                    {t('action.cancel')}
                  </button>
                </div>
              </div>
            )}
            {(state.prune.status === 'done' || state.prune.status === 'failed') && (
              <PruneOutcome prune={state.prune} onDismiss={() => { onDismissPrune() }} t={t} />
            )}
            {(state.remove.status === 'done' || state.remove.status === 'failed') && (
              <RemoveOutcome remove={state.remove} onDismiss={() => { onDismissRemoveResult() }} t={t} />
            )}
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
                    <div className={css.detailActions}>
                      <button
                        type="button"
                        className={css.restoreButton}
                        disabled={working || removing}
                        onClick={() => { onConfirmRestore(detail.generation.id) }}
                      >
                        {t('action.restore')}
                      </button>
                      <button
                        type="button"
                        className={css.restoreButton}
                        disabled={working || removing}
                        onClick={() => {
                          if (state.diff.status === 'idle') onDiff(detail.generation.id)
                          else onCloseDiff()
                        }}
                      >
                        {state.diff.status === 'idle' ? t('action.diff') : t('action.hideDiff')}
                      </button>
                      <button
                        type="button"
                        className={css.restoreButton}
                        disabled={working || removing}
                        onClick={() => { onConfirmRemove(detail.generation.id) }}
                      >
                        {t('action.remove')}
                      </button>
                    </div>
                    {state.diff.status === 'loading' && <p className={css.note}>{t('diff.loading')}</p>}
                    {state.diff.status === 'failed' && (
                      <p className={css.error} role="alert">{t('diff.failed', { message: state.diff.message })}</p>
                    )}
                    {state.diff.status === 'loaded' && <DiffView diffs={state.diff.diffs} t={t} />}
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
                {state.confirmRemoveId !== undefined && detail.status === 'loaded' && (
                  <div
                    className={css.confirm}
                    role="dialog"
                    aria-label={t('confirm.removeTitle', { id: shortGenerationId(state.confirmRemoveId) })}
                  >
                    <p className={css.note}>{t('confirm.removeNote')}</p>
                    <div className={css.confirmActions}>
                      <button
                        type="button"
                        className={css.restoreButton}
                        disabled={removing}
                        onClick={() => { onRemove(state.confirmRemoveId as string) }}
                      >
                        {removing ? t('remove.working') : t('action.confirmRemove')}
                      </button>
                      <button
                        type="button"
                        className={css.textButton}
                        disabled={removing}
                        onClick={() => { onCancelRemove() }}
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
            <section className={css.settings} aria-label={t('settings.title')}>
              <button
                type="button"
                className={css.settingsToggle}
                aria-expanded={settingsOpen}
                onClick={toggleSettings}
              >
                {t('settings.title')}
              </button>
              {settingsOpen && (
                <SettingsSection state={state} draft={draft} setDraft={setDraft} onSave={onSaveSettings} t={t} />
              )}
            </section>
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
