/**
 * The rescue GUI's single-page HTML, as a string template.
 *
 * Inlined rather than shipped as a `.html` asset on purpose: the published
 * package's `files` list carries only `lib/*.js`, and the CLI is bundled by
 * tsdown, so an external asset would need both a `files` entry and a runtime
 * path resolution that survives bundling and npm packing. One string constant
 * has neither failure mode, at the cost of editing HTML inside a TS file —
 * acceptable for a zero-framework rescue page.
 *
 * The page is deliberately dependency-free (no build step, no framework, no
 * CDN): it must render when the whole dsh tree is down, which is exactly when
 * `dsh-timemachine gui` gets opened. The client script talks to the loopback
 * server's JSON endpoints (`./gui.ts`) and builds its DOM with escaped text
 * only.
 *
 * The client script avoids template literals (they would collide with the
 * outer template literal); dynamic text goes through `esc()` before any
 * innerHTML assignment.
 * @module dsh-timemachine/gui-page
 */

/** The languages the rescue page speaks. */
export type GuiLang = 'zh' | 'en'

/** The page's UI string keys; both languages must carry every key. */
interface GuiStrings {
  title: string
  heading: string
  bootFailed: string
  rollbackLastGood: string
  dshRunning: string
  colId: string
  colOrigin: string
  colReason: string
  colLastSeen: string
  colStatus: string
  colBundles: string
  colActions: string
  diff: string
  restore: string
  remove: string
  undo: string
  redo: string
  snapshot: string
  prune: string
  exportLabel: string
  importLabel: string
  settingsHeading: string
  saveSettings: string
  autoSave: string
  debounceMs: string
  retention: string
  shortcutUndo: string
  shortcutRedo: string
  lastGoodBadge: string
  emptyHistory: string
  diffAgainstCurrent: string
  noDiff: string
  snapshotPrompt: string
  confirmRestore: string
  confirmRestoreRunning: string
  confirmRollback: string
  confirmRemove: string
  restoredOk: string
  removeRefused: string
  pruneDone: string
  pruneNone: string
  importDone: string
  imported: string
  skipped: string
  settingsSaved: string
  nothingToUndo: string
  nothingToRedo: string
  requestFailed: string
  refresh: string
}

/** The page's UI strings, both languages, keyed for the client script's `t()`. */
const STRINGS: Record<GuiLang, GuiStrings> = {
  en: {
    title: 'dsh-timemachine rescue',
    heading: 'Configuration history',
    bootFailed: 'The most recent boot FAILED. The tree may not come up — rolling back to the last known-good configuration is the way out.',
    rollbackLastGood: 'Roll back to last good',
    dshRunning: 'dsh appears to be running (127.0.0.1:3080 answers). Stop it before restoring, or a running tree may act on half-restored inputs.',
    colId: 'id',
    colOrigin: 'origin',
    colReason: 'reason',
    colLastSeen: 'last seen',
    colStatus: 'boot status',
    colBundles: 'bundles',
    colActions: 'actions',
    diff: 'diff',
    restore: 'restore',
    remove: 'remove',
    undo: 'undo',
    redo: 'redo',
    snapshot: 'snapshot',
    prune: 'prune',
    exportLabel: 'export zip',
    importLabel: 'import zip',
    settingsHeading: 'Settings',
    saveSettings: 'save settings',
    autoSave: 'auto-save',
    debounceMs: 'debounce (ms)',
    retention: 'retention',
    shortcutUndo: 'undo shortcut',
    shortcutRedo: 'redo shortcut',
    lastGoodBadge: 'last-good',
    emptyHistory: 'No configuration recorded yet; boot the profile once.',
    diffAgainstCurrent: 'against the current files on disk',
    noDiff: 'No differences.',
    snapshotPrompt: 'Reason for this snapshot (optional):',
    confirmRestore: 'Restore this configuration? These files will be written back:',
    confirmRestoreRunning: 'dsh is RUNNING. Restoring under a running tree is racy — restore anyway?',
    confirmRollback: 'Roll back to the last known-good configuration? These files will be written back:',
    confirmRemove: 'Delete this record? The configuration itself is untouched.',
    restoredOk: 'Restored. It takes effect at the next boot.',
    removeRefused: 'Remove refused: ',
    pruneDone: 'Pruned records: ',
    pruneNone: 'Nothing to prune.',
    importDone: 'Import finished.',
    imported: 'imported',
    skipped: 'skipped',
    settingsSaved: 'Settings saved.',
    nothingToUndo: 'Nothing to undo.',
    nothingToRedo: 'Nothing to redo.',
    requestFailed: 'Request failed: ',
    refresh: 'refresh',
  },
  zh: {
    title: 'dsh-timemachine 救援',
    heading: '配置历史',
    bootFailed: '最近一次启动失败了。树可能起不来——回退到最近一次正常（last good）的配置是出路。',
    rollbackLastGood: '回退到 last good',
    dshRunning: '检测到 dsh 似乎正在运行（127.0.0.1:3080 有应答）。恢复前建议先停止 dsh，否则运行中的树可能基于恢复到一半的输入行动。',
    colId: 'id',
    colOrigin: '来源',
    colReason: '备注',
    colLastSeen: '最近使用',
    colStatus: '启动结果',
    colBundles: '包层数',
    colActions: '操作',
    diff: '对比',
    restore: '恢复',
    remove: '删除',
    undo: '撤销',
    redo: '重做',
    snapshot: '快照',
    prune: '清理过期',
    exportLabel: '导出 zip',
    importLabel: '导入 zip',
    settingsHeading: '设置',
    saveSettings: '保存设置',
    autoSave: '自动记录',
    debounceMs: '防抖（毫秒）',
    retention: '保留数量',
    shortcutUndo: '撤销快捷键',
    shortcutRedo: '重做快捷键',
    lastGoodBadge: '最近正常',
    emptyHistory: '还没有记录过任何配置；先启动一次该 profile。',
    diffAgainstCurrent: '对比当前磁盘上的文件',
    noDiff: '没有差异。',
    snapshotPrompt: '这次快照的备注（可选）：',
    confirmRestore: '恢复这个配置？将写回以下文件：',
    confirmRestoreRunning: 'dsh 正在运行。在运行中的树下恢复有竞态风险——仍要恢复吗？',
    confirmRollback: '回退到最近一次正常的配置？将写回以下文件：',
    confirmRemove: '删除这条记录？配置本身不受影响。',
    restoredOk: '已恢复，下次启动时生效。',
    removeRefused: '删除被拒绝：',
    pruneDone: '已清理记录：',
    pruneNone: '没有需要清理的记录。',
    importDone: '导入完成。',
    imported: '已导入',
    skipped: '已跳过',
    settingsSaved: '设置已保存。',
    nothingToUndo: '没有可撤销的变化。',
    nothingToRedo: '没有可重做的变化。',
    requestFailed: '请求失败：',
    refresh: '刷新',
  },
}

/** The page's stylesheet (kept in one constant so the template below stays markup). */
const STYLES = [
  'body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f6f7f9; color: #1f2328; }',
  'header { padding: 12px 20px; background: #1f2328; color: #fff; display: flex; gap: 12px; align-items: baseline; }',
  'header h1 { font-size: 16px; margin: 0; }',
  'header .profile { color: #9da7b3; }',
  'main { padding: 16px 20px; max-width: 1100px; margin: 0 auto; }',
  '.banner { padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; display: flex; gap: 12px; align-items: center; }',
  '.banner.failed { background: #ffebe9; border: 1px solid #ff8182; color: #82071e; }',
  '.banner.running { background: #fff8c5; border: 1px solid #d4a72c; color: #6e5500; }',
  '.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }',
  'button { font: inherit; padding: 4px 10px; border: 1px solid #c9ced4; border-radius: 6px; background: #fff; cursor: pointer; }',
  'button:hover { background: #eef1f4; }',
  'button.danger { color: #82071e; border-color: #ff8182; }',
  'table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 6px; overflow: hidden; }',
  'th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e5e8ec; vertical-align: top; }',
  'th { background: #eef1f4; font-weight: 600; }',
  'tbody tr { cursor: default; }',
  'tbody tr:hover { background: #f6f8fa; }',
  'td.id { font-family: ui-monospace, monospace; }',
  '.badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 12px; background: #e5e8ec; margin-right: 4px; }',
  '.badge.good { background: #dafbe1; color: #116329; }',
  '.badge.bad { background: #ffebe9; color: #82071e; }',
  '.badge.manual { background: #ddf4ff; color: #0550ae; }',
  '.badge.regret { background: #fff1e5; color: #953800; }',
  '#diff { margin-top: 16px; }',
  '#diff .file { background: #fff; border: 1px solid #e5e8ec; border-radius: 6px; margin-bottom: 10px; overflow: hidden; }',
  '#diff .file h3 { margin: 0; padding: 6px 10px; background: #eef1f4; font-size: 13px; font-family: ui-monospace, monospace; }',
  '#diff pre { margin: 0; padding: 6px 10px; overflow-x: auto; font-size: 12px; }',
  '#diff .add { background: #dafbe1; }',
  '#diff .del { background: #ffebe9; }',
  '#diff .context { color: #6a737d; }',
  '#settings { background: #fff; border: 1px solid #e5e8ec; border-radius: 6px; padding: 12px 14px; margin-top: 16px; }',
  '#settings label { display: inline-flex; gap: 6px; align-items: center; margin: 4px 12px 4px 0; }',
  '#settings input[type=number], #settings input[type=text] { font: inherit; padding: 2px 6px; border: 1px solid #c9ced4; border-radius: 4px; width: 160px; }',
  '#settings input[type=number] { width: 90px; }',
  '.muted { color: #6a737d; }',
].join('\n')

/**
 * The client script. No template literals, no backticks, no `${` — it rides
 * inside the outer template literal, so those sequences are spelled with
 * plain string concatenation.
 */
const SCRIPT = `
var STATE = { status: null, generations: [] };

function t(key) { return I18N[key] !== undefined ? I18N[key] : key; }

function esc(value) {
  var div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

async function api(path, init) {
  var response = await fetch(path, init);
  if (!response.ok) {
    var message = response.statusText;
    try { message = (await response.json()).error || message; } catch (ignored) {}
    throw new Error(t('requestFailed') + message);
  }
  return response;
}

async function getJson(path) { return (await api(path)).json(); }

async function postJson(path, body) {
  return (await api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })).json();
}

function reportError(error) { window.alert(error instanceof Error ? error.message : String(error)); }

function renderBanners() {
  var host = document.getElementById('banners');
  host.innerHTML = '';
  var status = STATE.status;
  if (status === null) return;
  if (status.status.lastBootFailed && status.lastGoodId !== null) {
    var failed = document.createElement('div');
    failed.className = 'banner failed';
    failed.innerHTML = '<span>' + esc(t('bootFailed')) + '</span>';
    var button = document.createElement('button');
    button.className = 'danger';
    button.textContent = t('rollbackLastGood');
    button.onclick = function () { void restoreWithChecks(status.lastGoodId, t('confirmRollback')); };
    failed.appendChild(button);
    host.appendChild(failed);
  }
  if (status.dshRunning) {
    var running = document.createElement('div');
    running.className = 'banner running';
    running.textContent = t('dshRunning');
    host.appendChild(running);
  }
}

function originBadge(origin) {
  var cls = origin === 'manual' ? 'badge manual' : origin === 'regret' ? 'badge regret' : 'badge';
  return '<span class="' + cls + '">' + esc(origin) + '</span>';
}

function statusBadge(status) {
  if (status === undefined || status === null) return '<span class="muted">unbooted</span>';
  return status === 'activated'
    ? '<span class="badge good">activated</span>'
    : '<span class="badge bad">failed</span>';
}

function renderTable() {
  var host = document.getElementById('history');
  if (STATE.generations.length === 0) {
    host.innerHTML = '<p class="muted">' + esc(t('emptyHistory')) + '</p>';
    return;
  }
  var rows = STATE.generations.map(function (generation) {
    return '<tr data-id="' + esc(generation.id) + '">'
      + '<td class="id">' + esc(generation.id) + '</td>'
      + '<td>' + originBadge(generation.origin)
        + (generation.lastGood ? '<span class="badge good">' + esc(t('lastGoodBadge')) + '</span>' : '')
        + '</td>'
      + '<td>' + esc(generation.reason === null ? '' : generation.reason) + '</td>'
      + '<td>' + esc(generation.lastSeenAt) + '</td>'
      + '<td>' + statusBadge(generation.latestStatus) + '</td>'
      + '<td>' + generation.bundleCount + '</td>'
      + '<td>'
        + '<button data-act="diff">' + esc(t('diff')) + '</button> '
        + '<button data-act="restore">' + esc(t('restore')) + '</button> '
        + '<button data-act="remove" class="danger">' + esc(t('remove')) + '</button>'
        + '</td>'
      + '</tr>';
  });
  host.innerHTML = '<table><thead><tr>'
    + '<th>' + esc(t('colId')) + '</th><th>' + esc(t('colOrigin')) + '</th>'
    + '<th>' + esc(t('colReason')) + '</th><th>' + esc(t('colLastSeen')) + '</th>'
    + '<th>' + esc(t('colStatus')) + '</th><th>' + esc(t('colBundles')) + '</th>'
    + '<th>' + esc(t('colActions')) + '</th>'
    + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  host.querySelectorAll('tbody tr').forEach(function (row) {
    var id = row.getAttribute('data-id');
    row.addEventListener('dblclick', function () { void showDiff(id); });
    row.querySelectorAll('button').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        var act = button.getAttribute('data-act');
        if (act === 'diff') void showDiff(id);
        else if (act === 'restore') void restoreWithChecks(id, t('confirmRestore'));
        else if (act === 'remove') void removeRecord(id);
      });
    });
  });
}

function renderSettings(settings) {
  document.getElementById('set-autoSave').checked = settings.autoSave;
  document.getElementById('set-debounceMs').value = String(settings.debounceMs);
  document.getElementById('set-retention').value = String(settings.retention);
  document.getElementById('set-undo').value = settings.shortcuts.undo;
  document.getElementById('set-redo').value = settings.shortcuts.redo;
}

async function refresh() {
  try {
    STATE.status = await getJson('/api/status');
    STATE.generations = (await getJson('/api/generations')).generations;
    renderBanners();
    renderTable();
    renderSettings(STATE.status.settings);
  } catch (error) { reportError(error); }
}

async function showDiff(id) {
  try {
    var diffs = (await getJson('/api/diff?id=' + encodeURIComponent(id))).diffs;
    var host = document.getElementById('diff');
    var html = '<h2>diff ' + esc(id) + ' \\u2192 ' + esc(t('diffAgainstCurrent')) + '</h2>';
    if (diffs.length === 0) html += '<p class="muted">' + esc(t('noDiff')) + '</p>';
    for (var i = 0; i < diffs.length; i += 1) {
      var diff = diffs[i];
      html += '<div class="file"><h3>' + esc(diff.file) + '</h3><pre>';
      for (var j = 0; j < diff.hunks.length; j += 1) {
        var hunk = diff.hunks[j];
        var sign = hunk.type === 'add' ? '+' : hunk.type === 'del' ? '-' : ' ';
        html += '<div class="' + hunk.type + '">' + sign + ' ' + esc(hunk.text) + '</div>';
      }
      html += '</pre></div>';
    }
    host.innerHTML = html;
    host.scrollIntoView();
  } catch (error) { reportError(error); }
}

async function restoreWithChecks(id, promptText) {
  var status = STATE.status;
  var files = status !== null ? status.paths.join('\\n') : '';
  if (!window.confirm(promptText + '\\n' + files)) return;
  if (status !== null && status.dshRunning && !window.confirm(t('confirmRestoreRunning'))) return;
  try {
    var result = await postJson('/api/restore', { id: id });
    if (result.restored) window.alert(t('restoredOk'));
    else window.alert(result.refusal || 'refused');
  } catch (error) { reportError(error); }
  await refresh();
}

async function removeRecord(id) {
  if (!window.confirm(t('confirmRemove'))) return;
  try {
    var result = await postJson('/api/remove', { id: id });
    if (!result.removed) window.alert(t('removeRefused') + (result.refusal || ''));
  } catch (error) { reportError(error); }
  await refresh();
}

async function step(direction) {
  try {
    var result = await postJson('/api/' + direction, {});
    if (result.empty !== undefined && result.empty !== null) {
      window.alert(t(direction === 'undo' ? 'nothingToUndo' : 'nothingToRedo'));
    } else if (result.result !== undefined && !result.result.restored) {
      window.alert(result.result.refusal || 'refused');
    }
  } catch (error) { reportError(error); }
  await refresh();
}

async function snapshot() {
  var reason = window.prompt(t('snapshotPrompt'));
  if (reason === null) return;
  try {
    await postJson('/api/snapshot', reason.length > 0 ? { reason: reason } : {});
  } catch (error) { reportError(error); }
  await refresh();
}

async function prune() {
  try {
    var result = await postJson('/api/prune', {});
    window.alert(result.removed.length === 0 ? t('pruneNone') : t('pruneDone') + result.removed.join(', '));
  } catch (error) { reportError(error); }
  await refresh();
}

async function saveSettings() {
  var patch = {
    autoSave: document.getElementById('set-autoSave').checked,
    debounceMs: Number(document.getElementById('set-debounceMs').value),
    retention: Number(document.getElementById('set-retention').value),
    shortcuts: {
      undo: document.getElementById('set-undo').value,
      redo: document.getElementById('set-redo').value,
    },
  };
  try {
    await postJson('/api/settings', { patch: patch });
    window.alert(t('settingsSaved'));
  } catch (error) { reportError(error); }
  await refresh();
}

async function importZip(file) {
  try {
    var result = await api('/api/import', { method: 'POST', body: file }).then(function (r) { return r.json(); });
    window.alert(t('importDone') + ' ' + t('imported') + ': ' + result.imported.length + ', ' + t('skipped') + ': ' + result.skipped.length);
  } catch (error) { reportError(error); }
  await refresh();
}

function boot() {
  document.getElementById('act-undo').onclick = function () { void step('undo'); };
  document.getElementById('act-redo').onclick = function () { void step('redo'); };
  document.getElementById('act-snapshot').onclick = function () { void snapshot(); };
  document.getElementById('act-prune').onclick = function () { void prune(); };
  document.getElementById('act-refresh').onclick = function () { void refresh(); };
  document.getElementById('act-export').onclick = function () { window.location.href = '/api/export'; };
  document.getElementById('act-import').onchange = function (event) {
    var file = event.target.files && event.target.files[0];
    if (file !== undefined && file !== null) void importZip(file);
    event.target.value = '';
  };
  document.getElementById('act-save-settings').onclick = function () { void saveSettings(); };
  document.getElementById('settings-title').textContent = t('settingsHeading');
  void refresh();
}

document.addEventListener('DOMContentLoaded', boot);
`

/**
 * Render the rescue page.
 * @param options - the UI language and the profile name shown in the header.
 * @returns the self-contained HTML document.
 */
export function renderGuiPage(options: { lang: GuiLang, profile: string }): string {
  const strings = STRINGS[options.lang]
  const escHtml = (text: string): string => text
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  // The strings table is data the server owns, so injecting it as JSON into a
  // script constant is safe (the `<` escape keeps a `</script>` inside a
  // string from closing the tag early).
  const i18nJson = JSON.stringify(strings).replaceAll('<', '\\u003c')
  const profile = escHtml(options.profile)
  return `<!doctype html>
<html lang="${options.lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(strings.title)} — ${profile}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <h1>${escHtml(strings.title)}</h1>
  <span class="profile">${profile}</span>
</header>
<main>
  <div id="banners"></div>
  <div class="toolbar">
    <button id="act-undo">${strings.undo}</button>
    <button id="act-redo">${strings.redo}</button>
    <button id="act-snapshot">${strings.snapshot}</button>
    <button id="act-prune">${strings.prune}</button>
    <button id="act-export">${strings.exportLabel}</button>
    <label><span class="badge">${strings.importLabel}</span><input type="file" id="act-import" accept=".zip" hidden></label>
    <button id="act-refresh">${strings.refresh}</button>
  </div>
  <h2>${strings.heading}</h2>
  <div id="history"></div>
  <div id="diff"></div>
  <section id="settings">
    <h2 id="settings-title"></h2>
    <label>${strings.autoSave} <input type="checkbox" id="set-autoSave"></label>
    <label>${strings.debounceMs} <input type="number" id="set-debounceMs" min="1"></label>
    <label>${strings.retention} <input type="number" id="set-retention" min="1"></label>
    <label>${strings.shortcutUndo} <input type="text" id="set-undo"></label>
    <label>${strings.shortcutRedo} <input type="text" id="set-redo"></label>
    <button id="act-save-settings">${strings.saveSettings}</button>
  </section>
</main>
<script>I18N_SEED</script>
<script>${SCRIPT}</script>
</body>
</html>
`.replace('I18N_SEED', `var I18N = ${i18nJson};`)
}
