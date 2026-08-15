/**
 * Node-side loader capture for the published client bundles.
 *
 * The published `@deepseek-ai/dsh-client-*` `/client` artifacts are
 * closure-factory bundles: evaluating one calls
 * `window.__ModuleLoader__.load({ id, factory })`, which a browser supplies
 * and a test process does not. This shim evaluates a bundle with
 * `node:module`'s require behind a `window` stand-in whose loader captures
 * the entry, and hands back the namespace its factory returned. The
 * factory's own `require` calls for sibling client bundles recurse through
 * the same capture; every other specifier resolves through node.
 *
 * The `window` stand-in exists only while a bundle evaluates: the locale
 * bundle sniffs `window` to decide its initial locale (a bare `window` global
 * in a node process would make a test machine's language decide it), and no
 * captured export is meant to see a browser.
 * @module dsh-config-generations/tests/shims/client-bundles
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One entry as the closure bundles hand it to `window.__ModuleLoader__.load`. */
interface LoaderEntry {
  id: string
  factory: (require: (specifier: string) => unknown) => unknown
}

// Anchored on the process cwd rather than `import.meta.url`: under a jsdom
// environment vitest rewrites the latter to an http URL, which createRequire
// rejects. Vitest runs specs with the package root as cwd.
const nodeRequire = createRequire(pathToFileURL(join(process.cwd(), 'package.json')))

/** Captured factory namespaces by the bundle id they registered with. */
const captured = new Map<string, unknown>()
/** Bundle ids currently evaluating, to fail a circular load loudly. */
const loading = new Set<string>()

/**
 * The `/client` subpath specifiers that name a closure bundle rather than a
 * node module, mapped to the id the bundle registers under.
 */
const ARTIFACT_IDS: Record<string, string> = {
  '@deepseek-ai/dsh-client-runtime/client': '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale/client': '@deepseek-ai/dsh-client-locale',
}

/** The capturing loader the bundles register with. */
const moduleLoader = {
  load: ({ id, factory }: LoaderEntry) => {
    captured.set(id, factory(requireFromTable))
  },
}

/**
 * The locale bundle's factory requires `@deepseek-ai/dsh-client-ui-primitives`
 * for two symbols only its settings-row component renders, and the package's
 * node entry imports a `.css` file no node loader accepts. The tests never
 * render that row, so the factory gets a stand-in namespace instead.
 */
const uiPrimitivesStub = new Proxy(Object.create(null) as Record<string, unknown>, {
  get: (target, property) => {
    if (typeof property !== 'string') return undefined
    return target[property] ??= () => null
  },
})

/** The `require` handed to a bundle factory. */
function requireFromTable(specifier: string): unknown {
  if (specifier in ARTIFACT_IDS) return loadBundle(specifier)
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return uiPrimitivesStub
  return nodeRequire(specifier)
}

/**
 * Evaluate a published client bundle and return its factory namespace.
 * @param specifier - the `/client` subpath specifier, resolvable from this package.
 */
export function loadBundle(specifier: string): unknown {
  const artifactId = ARTIFACT_IDS[specifier] ?? specifier
  const hit = captured.get(artifactId)
  if (hit !== undefined) return hit
  if (loading.has(artifactId)) throw new Error(`circular client bundle load: ${artifactId}`)
  loading.add(artifactId)
  const globalScope = globalThis as { window?: unknown }
  const previousWindow = globalScope.window
  globalScope.window = { __ModuleLoader__: moduleLoader }
  try {
    nodeRequire(nodeRequire.resolve(specifier))
  } finally {
    loading.delete(artifactId)
    if (previousWindow === undefined) delete globalScope.window
    else globalScope.window = previousWindow
  }
  const loaded = captured.get(artifactId)
  if (loaded === undefined) throw new Error(`client bundle ${specifier} did not register as ${artifactId}`)
  return loaded
}
