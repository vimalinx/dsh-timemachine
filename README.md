# dsh-timemachine

English | [中文](README.zh.md)

Version control for a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) profile's plugin-tree configuration. Every time a booted profile's configuration changes, the host records a **generation** — the configuration's durable inputs, addressed by their digest, stored together with the composition they produced and every boot attempt against them. On top of that history the plugin adds undo/redo with a persistent redo stack, auto-save on edit, manual snapshots, and a drift-refusing restore, all drivable from four places: the web UI (a sidebar panel plus session-header buttons and shortcuts), conversation commands an agent can call, a standalone CLI, and a loopback rescue GUI for when no dsh tree boots at all.

This package is a standard external dsh plugin: it installs with `dsh plugin add` and mounts into the profile's plugin tree like any other bundle, with no patch to the dsh core required.

## Installation

Once the package is published to npm:

```sh
dsh plugin --profile web add @vimalinx/dsh-timemachine
```

Before publication, install from a tarball or a git URL — the same command accepts both:

```sh
dsh plugin --profile web add ./dsh-timemachine-0.2.0.tgz
dsh plugin --profile web add git+https://github.com/vimalinx/dsh-timemachine.git
```

Boot the `web` profile once after installing; the first generation is recorded at that boot.

### Compatibility

Verified on a live installation against `@deepseek-ai/dsh@0.1.0-rc.6`. The peer dependency ranges are `@deepseek-ai/cordis@^4.0.1` and `@deepseek-ai/dsh-app-boot` / `@deepseek-ai/dsh-atomic-write` / `@deepseek-ai/dsh-tools@^0.1.0-rc.6`; a dsh installation inside those ranges supplies them.

## Web UI

### Sidebar panel

With the plugin installed, the `web` profile's sidebar footer gains a **Config generations** trigger (a branch icon). Clicking it opens the history roster above the footer:

- Each row shows the generation id, when it was last used, its latest boot status — **Activated** (the boot reached a running tree), **Boot failed**, or **Never booted** (recorded but no outcome yet) — and an **origin badge** telling how the record came to be (boot / auto / manual / regret), with a manual snapshot's reason beside it.
- Two more badges can appear on a row: **Last good** marks the newest configuration that ever activated — the one a recovery most likely wants; **Booted now** marks the configuration the currently running process booted with.
- Clicking a row expands its detail: the bundle layers with their recorded versions, every boot outcome (with error text and `--patch` overlays where present), and the full rendered composition. **Diff against current** opens an inline red/green diff preview of that generation against the live configuration, with long unchanged stretches collapsed into a `… (N unchanged lines)` marker.
- **Restore** at the bottom of the detail opens a confirmation listing exactly which files will be written back. Confirming writes the generation's input files, verifies they still reproduce the recorded tree, and reports either the written files or the refusal (see below). The restore takes effect at the next boot.
- **Delete** removes one record after a confirmation; the Last good record — and, while a tree is running, the configuration it booted with — are protected.
- The toolbar records a **manual snapshot** (with an optional reason), **prunes** expired boot/auto records on demand, and **exports/imports** the whole history as one ZIP archive (an import never overwrites existing records).
- When the most recent boot failed to activate, a banner at the top of the panel offers a one-click rollback to Last good.
- A **settings** section holds the plugin's own knobs: auto-save on/off, the debounce interval, the retention bound, and the undo/redo shortcuts.

### Session-header buttons and shortcuts

Every session header gains three buttons (mounted into the `conversation.session.header.actions` slot): **Undo** (red), **Redo** (green), and **Snapshot**. Undo and redo open a confirmation first, and with nothing to step to they say so instead of acting silently.

The default shortcuts are **Ctrl+Alt+Z** (undo) and **Ctrl+Alt+Y** (redo). They open the same confirmation the buttons do, and they never fire while an input field or other editable element has focus. Both are customizable in the panel's settings section: focus the field and press the combination to record it; Backspace restores the default.

## Conversation commands

The plugin registers five agent tools — `timemachine_snapshot`, `timemachine_undo`, `timemachine_redo`, `timemachine_restore`, `timemachine_list` — so telling the agent "撤销上一步" / "undo the config change", "回退到某个版本" / "restore that version", "保存快照" / "save a snapshot", or "查看配置历史" / "list config history" reaches them. Every call appends a `timemachine/*` event to the calling agent's session log as an audit trail of who moved the configuration.

## Standalone CLI

The package ships a `dsh-timemachine` binary for shells outside a booted tree:

```sh
dsh-timemachine log --profile web          # list recorded configurations, oldest first
dsh-timemachine show --profile web <id>    # print one configuration's composition
dsh-timemachine diff --profile web <id> [id]
                                           # compare two compositions (default: against the latest)
dsh-timemachine restore --profile web <id> # write one configuration's input files back
dsh-timemachine undo --profile web         # step back to the previous configuration
dsh-timemachine redo --profile web         # step forward to the configuration an undo stepped away from
dsh-timemachine snapshot --profile web [reason]
                                           # record the configuration as it now stands
dsh-timemachine remove --profile web <id>  # delete one record (the last known-good one is protected)
dsh-timemachine status --profile web       # undo/redo availability, boot health, latest configuration
dsh-timemachine export --profile web [out.zip]
                                           # zip the whole history (default: dsh-timemachine-<YYYYMMDD-HHmmss>.zip)
dsh-timemachine import --profile web <zip> # unzip an archive into the history, never overwriting
dsh-timemachine prune --profile web        # apply the retention bound now
dsh-timemachine settings --profile web [--set k=v]
                                           # print the settings; --set updates autoSave, debounceMs,
                                           # retention, shortcuts.undo, shortcuts.redo (repeatable)
dsh-timemachine gui --profile web          # serve the rescue page on 127.0.0.1 and open a browser
```

`--profile <name>` is required on every invocation. An `<id>` may be abbreviated to any unambiguous prefix. An undo or redo with nothing to step to prints "nothing to undo" / "nothing to redo" and exits with code 1.

The CLI resolves profiles under the Harness home: `$DSH_HOME` when the environment variable is set and non-blank, otherwise `~/.dsh`.

## Outsider rescue GUI

`dsh-timemachine gui --profile web` serves a self-contained rescue page from a loopback-only server (127.0.0.1, random free port) and opens it with `xdg-open`; Ctrl+C stops the server. It is built for the case where no dsh tree boots at all: it depends only on node builtins and this package's own core layer, never on a running dsh.

The page covers the panel's full surface — list, diff preview, restore (with the same file-listing confirmation), delete, prune, export/import, and the settings — plus the boot-failure banner with a one-click rollback to Last good. If a dsh web shell appears to be running (something answers a TCP probe of 127.0.0.1:3080), the page shows a yellow warning and a restore asks for a second confirmation; the probe only warns, it never blocks.

The page language follows the system locale; `DSH_TIMEMACHINE_LANG=zh|en` forces one. There is deliberately no system-tray mode.

## What a generation is

A generation records the three **durable inputs** that decide a profile's plugin tree:

1. the profile manifest — `<profile>/package.json`, specifically its `dsh.profile.bundles` list;
2. the profile patch layer — `<profile>/cordis.patch.yml`;
3. the home patch layer — `$DSH_HOME/cordis.patch.yml`, applied over every profile.

Each record lives at `<profile>/timemachine/<id>.json`, where `<id>` is the first 12 hex characters of a digest over the three input texts. Alongside the inputs, a record carries the rendered composition those inputs produced, the resolved version of every bundle layer, and every boot outcome against the configuration.

**Changes are recorded, not launches.** Booting an unchanged configuration appends a new outcome to the existing record instead of creating a second one. `recordedAt` marks when the configuration was first seen and never moves; `lastSeenAt` orders the history.

### Origins

Every generation records how it came to be: **boot** (the launcher observed its own boot), **auto** (the filesystem watcher saw a settled edit), **manual** (an explicit snapshot, optionally carrying its reason), or **regret** (the record an undo writes for the configuration it steps away from, so a redo can return to it). Records written before this field existed read as `boot`.

### Undo and redo

- The generations themselves are the undo stack: an undo steps back to the most recently seen configuration whose inputs differ from the current one, writing its input files back through the same verified restore path (taking effect at the next boot). Before stepping, the undo records the configuration it is leaving as a regret generation — that record is what a redo returns to.
- Only the redo stack needs a file, `<profile>/timemachine/undo-state.json`, so redo survives restarts. Any new configuration record (a boot with changed inputs, an auto-save, a snapshot, a restore) clears the redo stack — the undo's own regret record, being the redo target itself, does not. A redo entry whose record was deleted or pruned away is skipped rather than resurrected.
- An undo or redo with nothing to step to answers "nothing to undo" / "nothing to redo" explicitly instead of failing silently.

### Auto-save and self-write suppression

With auto-save enabled (the default), the in-tree service watches the three durable inputs and records a settled, genuinely changed state as an `auto` generation after a debounce (default 1500 ms, adjustable in the settings). Rewrites that leave the content unchanged do not fire at all. Writes the service itself just made — a restore, an undo, a redo — are registered by digest before they land and never trigger an auto record, so its own writes cannot trample the redo stack they would otherwise clear.

### Restore semantics

A restore writes the input files back (deleting a patch layer the generation recorded as absent), then **recomposes the profile through the same path a boot uses** and checks that the recorded tree is still reproducible:

- If the check passes, the restored configuration **takes effect at the next boot**. The running tree keeps the composition it mounted — swapping a live tree's composition underneath its own agents has no defined lifecycle.
- If a recorded bundle's installed version has moved (**drift**), the restore is **refused**, the drifted packages are named, and every input file is rolled back. Replacing only the input files after a bundle changed would compose a different tree while looking like a successful return to an earlier state.
- The settings document is recorded on a full-scope generation but **never written back**: `dsh-settings-file` owns it behind a cross-process writer lock that rejects writes which would overwrite an unobserved edit. Returning settings to a recorded state stays a manual edit.
- An in-tree restore (panel, tools, RPC) additionally writes back the locally authored preset files a full-scope generation recorded, and deliberately leaves the home patch layer alone; the standalone CLI and rescue GUI have no settings/preset vantage and write exactly the three durable inputs.

### Retention

Retention is two-tier. **Manual** snapshots and **regret** records are never cleaned automatically. **Boot** and **auto** generations are bounded by the retention setting (default 50, adjustable): the newest that many survive. And the newest generation that ever activated — Last good — is kept however old, because a recovery needs the last known-good configuration, not the last 50 launches. Recording a generation prunes as a side effect; the panel toolbar, the CLI's `prune`, and the RPC endpoint apply the same bound on demand.

## Limitations

- **A restore takes effect at the next boot**, never in the running process.
- **Mutually exclusive with a dsh fork that has this feature patched into core.** Both mount the same `timemachine` service and RPC surface; install this plugin only against a stock dsh installation.
- **Loopback boundary.** The web panel talks to the service over a Connection RPC channel (`/timemachine`, with endpoints `list`, `read`, `restore`, `snapshot`, `undo`, `redo`, `remove`, `diff`, `export`, `import`, `status`, `getSettings`, `updateSettings`, `prune`) registered with `authority: 'loopback'` — it answers only same-host clients and is not reachable from remote connections. The rescue GUI's server likewise binds 127.0.0.1 only.
- **The CLI and the rescue GUI need a created profile.** Both resolve the profile through the launcher's own loader, so an unknown profile name fails at open, and a profile that has never booted simply has no records yet — boot it once first.
- **The rescue GUI's dsh-running detection is heuristic.** It probes the web shell's fixed port 3080 over TCP: a foreign service on that port is a false positive, a shell bound elsewhere is a false negative. That is why the GUI warns and double-confirms instead of refusing.
- **No system tray.** The rescue GUI is a self-contained page plus a loopback server, by design.
- **Settings and `.env` stay untouched by design.** The settings document is recorded but never written back (see above), and no `.env` file is read or written — a restore moves exactly the files listed in its confirmation, nothing more.
- **Runtime patch reloads do not add a generation.** With auto-save on, an edit made while `dsh` runs is recorded by the watcher once it settles; with auto-save off, only at the next boot (or an explicit snapshot).
- **Per-invocation inputs are not restorable.** `--patch` overlays and environment switches are recorded on an outcome for orientation but never written back, because they do not persist.
- **A restore is not atomic across a crash.** Inputs are written, then verified, then rolled back on a mismatch; a process killed inside that window leaves the restored configuration in place — a configuration that previously activated, not a corrupt one.
- **Bundle versions are not restored.** A refused restore names the drifted packages; reinstalling them is left to you.

## Development

```sh
pnpm install
pnpm build      # tsc -p tsconfig.build.json && tsdown
pnpm test       # vitest run
pnpm typecheck  # tsc -p tsconfig.json --noEmit
```

## License

[MIT](LICENSE)
