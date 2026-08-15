# dsh-timemachine

English | [中文](README.zh.md)

Version control for a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) profile's plugin-tree configuration. Every time a booted profile's configuration changes, the host records a **generation** — the configuration's durable inputs, addressed by their digest, stored together with the composition they produced and every boot attempt against them. You can then browse that history in the web sidebar, diff two configurations, or restore an earlier one from the panel or a standalone CLI.

This package is a standard external dsh plugin: it installs with `dsh plugin add` and mounts into the profile's plugin tree like any other bundle, with no patch to the dsh core required.

## Installation

Once the package is published to npm:

```sh
dsh plugin --profile web add dsh-timemachine
```

Before publication, install from a tarball or a git URL — the same command accepts both:

```sh
dsh plugin --profile web add ./dsh-timemachine-0.1.0.tgz
dsh plugin --profile web add git+https://github.com/vimalinx/dsh-timemachine.git
```

Boot the `web` profile once after installing; the first generation is recorded at that boot.

### Compatibility

Verified on a live installation against `@deepseek-ai/dsh@0.1.0-rc.6`. The peer dependency ranges are `@deepseek-ai/cordis@^4.0.1` and `@deepseek-ai/dsh-app-boot` / `@deepseek-ai/dsh-atomic-write@^0.1.0-rc.6`; a dsh installation inside those ranges supplies them.

## Web panel

With the plugin installed, the `web` profile's sidebar footer gains a **Config generations** trigger (a branch icon). Clicking it opens the history roster above the footer:

- Each row shows the generation id, when it was last used, and its latest boot status — **Activated** (the boot reached a running tree), **Boot failed**, or **Never booted** (recorded but no outcome yet).
- Two badges can appear on a row: **Last good** marks the newest configuration that ever activated — the one a recovery most likely wants; **Booted now** marks the configuration the currently running process booted with.
- Clicking a row expands its detail: the bundle layers with their recorded versions, every boot outcome (with error text and `--patch` overlays where present), and the full rendered composition.
- **Restore** at the bottom of the detail opens a confirmation listing exactly which files will be written back. Confirming writes the generation's input files, verifies they still reproduce the recorded tree, and reports either the written files or the refusal (see below). The restore takes effect at the next boot.

## Standalone CLI

The package ships a `dsh-timemachine` binary for shells outside a booted tree:

```sh
dsh-timemachine log --profile web       # list recorded configurations, oldest first
dsh-timemachine show --profile web <id> # print one configuration's composition
dsh-timemachine diff --profile web <id> [id]
                                               # compare two compositions (default: against the latest)
dsh-timemachine restore --profile web <id>
                                               # write one configuration's input files back
```

`--profile <name>` is required on every invocation. An `<id>` may be abbreviated to any unambiguous prefix.

The CLI resolves profiles under the Harness home: `$DSH_HOME` when the environment variable is set and non-blank, otherwise `~/.dsh`.

## What a generation is

A generation records the three **durable inputs** that decide a profile's plugin tree:

1. the profile manifest — `<profile>/package.json`, specifically its `dsh.profile.bundles` list;
2. the profile patch layer — `<profile>/cordis.patch.yml`;
3. the home patch layer — `$DSH_HOME/cordis.patch.yml`, applied over every profile.

Each record lives at `<profile>/timemachine/<id>.json`, where `<id>` is the first 12 hex characters of a digest over the three input texts. Alongside the inputs, a record carries the rendered composition those inputs produced, the resolved version of every bundle layer, and every boot outcome against the configuration.

**Changes are recorded, not launches.** Booting an unchanged configuration appends a new outcome to the existing record instead of creating a second one. `recordedAt` marks when the configuration was first seen and never moves; `lastSeenAt` orders the history.

### Restore semantics

A restore writes the three input files back (deleting a patch layer the generation recorded as absent), then **recomposes the profile through the same path a boot uses** and checks that the recorded tree is still reproducible:

- If the check passes, the restored configuration **takes effect at the next boot**. The running tree keeps the composition it mounted — swapping a live tree's composition underneath its own agents has no defined lifecycle.
- If a recorded bundle's installed version has moved (**drift**), the restore is **refused**, the drifted packages are named, and every input file is rolled back. Replacing only the input files after a bundle changed would compose a different tree while looking like a successful return to an earlier state.
- The settings document is recorded on a generation but **never written back**: `dsh-settings-file` owns it behind a cross-process writer lock that rejects writes which would overwrite an unobserved edit. Returning settings to a recorded state stays a manual edit.

### Retention

The history keeps the newest 50 generations plus the newest one that ever activated, however old — a recovery needs the last known-good configuration, not the last 50 launches.

## Limitations

- **A restore takes effect at the next boot**, never in the running process.
- **Mutually exclusive with a dsh fork that has this feature patched into core.** Both mount the same `timemachine` service and RPC surface; install this plugin only against a stock dsh installation.
- **Loopback boundary.** The web panel talks to the service over a Connection RPC channel registered with `authority: 'loopback'` — it answers only same-host clients and is not reachable from remote connections.
- **Runtime patch reloads do not add a generation.** An edit made while `dsh` runs is recorded only at the next boot.
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
