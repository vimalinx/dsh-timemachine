/**
 * `dsh-timemachine gui` — the outsider rescue GUI: a loopback-only
 * `node:http` server serving a self-contained page (`./gui-page.ts`) over the
 * standalone operations (`./standalone.ts`).
 *
 * "Outsider" is the design constraint: this runs when the whole dsh tree is
 * down, so it depends on node builtins, this package's own core layer, and
 * `@deepseek-ai/dsh-app-boot` (for restore verification through the one
 * composition path a boot uses) — never on a running dsh.
 *
 * The server binds 127.0.0.1 on a random free port: the history it mutates is
 * per-user data, so listening on a routable interface would be a footgun, and
 * a fixed port would collide with a second rescue session.
 * @module dsh-timemachine/gui
 */

import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { exportGenerations, importGenerations } from './archive.ts'
import { diffInputs, type DiffSide } from './diff.ts'
import {
  generationOrigin,
  lastActivated,
  latestStatus,
  readGenerations,
  selectGeneration,
} from './generations.ts'
import { homePatchPath } from './host-profile.ts'
import { readTimemachineSettings, writeTimemachineSettings } from './settings.ts'
import {
  pruneStandalone,
  redoStandalone,
  removeStandalone,
  restoreGeneration,
  snapshotStandalone,
  statusStandalone,
  undoStandalone,
  type StandaloneHost,
} from './standalone.ts'
import { renderGuiPage, type GuiLang } from './gui-page.ts'
import type { ConfigGeneration, TimemachineSettingsPatch } from './types.ts'

const NAME = 'dsh-timemachine'

/**
 * The port the dsh web shell binds (source: the dsh launcher's web server,
 * visible in `$DSH_HOME/web-restart.log` as `dsh web: http://127.0.0.1:3080`).
 * {@link probeDshRunning} uses it as the running-tree signal.
 */
const DSH_WEB_PORT = 3080

/** Request bodies are small JSON documents; import zips are the one larger case. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * Resolve the page language: `DSH_TIMEMACHINE_LANG=zh|en` wins, then the
 * system locale (`LC_ALL`/`LC_MESSAGES`/`LANG`, then the ICU default).
 * @param env - the environment to read; defaults to the process's.
 * @returns the language to render.
 */
export function resolveLang(env: NodeJS.ProcessEnv = process.env): GuiLang {
  const explicit = env.DSH_TIMEMACHINE_LANG
  if (explicit === 'zh' || explicit === 'en') return explicit
  const locale = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG
    ?? Intl.DateTimeFormat().resolvedOptions().locale
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Whether a dsh tree appears to be running: a TCP handshake against the web
 * shell's fixed loopback port. Chosen over a pidfile because dsh leaves no
 * documented run marker under `$DSH_HOME` to read; the port is the one
 * externally observable signal. A foreign service on the same port is a false
 * positive — which is why the GUI warns and double-confirms instead of
 * refusing outright.
 * @param port - the port to probe; defaults to {@link DSH_WEB_PORT}.
 * @param timeoutMs - how long to wait for the handshake.
 * @returns whether something answered.
 */
export function probeDshRunning(port: number = DSH_WEB_PORT, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

/** Project one recorded generation to its table row (no rendered composition). */
function generationSummary(generation: ConfigGeneration, lastGoodId: string | undefined): unknown {
  return {
    id: generation.id,
    scope: generation.scope,
    origin: generationOrigin(generation),
    reason: generation.reason ?? null,
    recordedAt: generation.recordedAt,
    lastSeenAt: generation.lastSeenAt,
    latestStatus: latestStatus(generation) ?? null,
    bundleCount: generation.bundles.length,
    lastGood: generation.id === lastGoodId,
  }
}

/** Read a request body to a buffer, rejecting past the size cap. */
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`${NAME}: request body too large`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/** Parse a JSON request body; an empty body reads as `{}`. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request)
  if (body.length === 0) return {}
  const parsed: unknown = JSON.parse(body.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${NAME}: request body must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** One JSON answer. */
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(body)
}

/** The settings patch a POST may carry, narrowed field by field (the file merge validates the rest). */
function settingsPatch(value: unknown): TimemachineSettingsPatch {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const patch: TimemachineSettingsPatch = {}
  if (typeof record.autoSave === 'boolean') patch.autoSave = record.autoSave
  if (typeof record.debounceMs === 'number') patch.debounceMs = record.debounceMs
  if (typeof record.retention === 'number') patch.retention = record.retention
  if (typeof record.shortcuts === 'object' && record.shortcuts !== null) {
    const shortcuts = record.shortcuts as Record<string, unknown>
    patch.shortcuts = {
      ...typeof shortcuts.undo === 'string' ? { undo: shortcuts.undo } : {},
      ...typeof shortcuts.redo === 'string' ? { redo: shortcuts.redo } : {},
    }
  }
  return patch
}

/** A running rescue server, for the CLI entry and for tests. */
export interface GuiServer {
  /** The loopback URL the page is served at. */
  url: string
  /** Close the server. */
  close: () => Promise<void>
}

/**
 * Start the rescue server.
 * @param host - the profile opened for standalone operations.
 * @param options - the page language; defaults to {@link resolveLang}.
 * @returns the server handle once listening.
 */
export async function startGuiServer(
  host: StandaloneHost, options: { lang?: GuiLang } = {},
): Promise<GuiServer> {
  const lang = options.lang ?? resolveLang()
  const page = renderGuiPage({ lang, profile: host.profile })
  const sideOf = (generation: ConfigGeneration): DiffSide => ({
    ...generation.inputs,
    render: generation.composed.render,
  })

  const server: Server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  /** Dispatch one request. Thrown errors become a 500 JSON; refusals ride 200. */
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const method = request.method ?? 'GET'
    const path = url.pathname

    if (method === 'GET' && path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page)
      return
    }
    if (method === 'GET' && path === '/api/status') {
      const { generations } = readGenerations(host.profileDir)
      sendJson(response, 200, {
        profile: host.profile,
        lang,
        status: statusStandalone(host),
        dshRunning: await probeDshRunning(),
        lastGoodId: lastActivated(generations)?.id ?? null,
        // The files a restore writes back, for the page's confirm dialog.
        paths: [
          join(host.profileDir, 'package.json'),
          join(host.profileDir, 'cordis.patch.yml'),
          homePatchPath(host.home),
        ],
        settings: readTimemachineSettings(host.profileDir),
      })
      return
    }
    if (method === 'GET' && path === '/api/generations') {
      const { generations, unreadable } = readGenerations(host.profileDir)
      const lastGoodId = lastActivated(generations)?.id
      sendJson(response, 200, {
        generations: generations.map(generation => generationSummary(generation, lastGoodId)),
        unreadable: unreadable.map(entry => ({ path: entry.path, reason: entry.reason })),
      })
      return
    }
    if (method === 'GET' && path === '/api/diff') {
      const id = url.searchParams.get('id')
      if (id === null) {
        sendJson(response, 400, { error: `${NAME}: /api/diff needs an id` })
        return
      }
      const { generations } = readGenerations(host.profileDir)
      const before = sideOf(selectGeneration(generations, id))
      const against = url.searchParams.get('against')
      const after = against === null
        ? { ...host.readInputs(), render: host.render() }
        : sideOf(selectGeneration(generations, against))
      sendJson(response, 200, { diffs: diffInputs(before, after) })
      return
    }
    if (method === 'GET' && path === '/api/settings') {
      sendJson(response, 200, readTimemachineSettings(host.profileDir))
      return
    }
    if (method === 'GET' && path === '/api/export') {
      const bytes = exportGenerations(host.profileDir)
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${NAME}-${host.profile}.zip"`,
      })
      response.end(Buffer.from(bytes))
      return
    }
    if (method === 'POST' && path === '/api/restore') {
      const body = await readJson(request)
      const generation = selectGeneration(readGenerations(host.profileDir).generations, String(body.id ?? ''))
      sendJson(response, 200, await restoreGeneration(host, generation))
      return
    }
    if (method === 'POST' && path === '/api/undo') {
      sendJson(response, 200, await undoStandalone(host, new Date().toISOString()))
      return
    }
    if (method === 'POST' && path === '/api/redo') {
      sendJson(response, 200, await redoStandalone(host))
      return
    }
    if (method === 'POST' && path === '/api/snapshot') {
      const body = await readJson(request)
      const reason = typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : undefined
      sendJson(response, 200, await snapshotStandalone(host, reason, new Date().toISOString()))
      return
    }
    if (method === 'POST' && path === '/api/remove') {
      const body = await readJson(request)
      sendJson(response, 200, removeStandalone(host, String(body.id ?? '')))
      return
    }
    if (method === 'POST' && path === '/api/prune') {
      sendJson(response, 200, { removed: pruneStandalone(host) })
      return
    }
    if (method === 'POST' && path === '/api/settings') {
      const body = await readJson(request)
      sendJson(response, 200, await writeTimemachineSettings(host.profileDir, settingsPatch(body.patch)))
      return
    }
    if (method === 'POST' && path === '/api/import') {
      try {
        sendJson(response, 200, await importGenerations(host.profileDir, await readBody(request)))
      } catch (error) {
        // A corrupt archive throws out of unzip; that is a bad payload, not a fault.
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    sendJson(response, 404, { error: `${NAME}: no route for ${method} ${path}` })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
    }),
  }
}

/**
 * Open a browser at the URL, best-effort: `xdg-open` is the Linux desktop's
 * opener; when it is missing or fails, the printed URL is the fallback the
 * user opens by hand (the message says so).
 */
function openBrowser(url: string): void {
  try {
    const opener = spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
    opener.on('error', () => {
      process.stderr.write(`${NAME}: could not launch xdg-open; open ${url} yourself.\n`)
    })
    opener.unref()
  } catch {
    process.stderr.write(`${NAME}: could not launch xdg-open; open ${url} yourself.\n`)
  }
}

/**
 * Serve the rescue GUI until Ctrl+C: start the server, print and open the URL,
 * and close on SIGINT.
 * @param host - the profile opened for standalone operations.
 * @param options - `open: false` skips the browser launch (tests).
 * @returns the process exit code once the server closes.
 */
export async function runGui(host: StandaloneHost, options: { open?: boolean } = {}): Promise<number> {
  const server = await startGuiServer(host)
  process.stdout.write(`${NAME}: rescue page for profile ${host.profile} at ${server.url}\n`)
  process.stdout.write(`${NAME}: Ctrl+C to stop.\n`)
  if (options.open !== false) openBrowser(server.url)
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      void server.close().then(() => resolve())
    })
  })
  return 0
}
