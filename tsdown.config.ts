/**
 * tsdown config for this standalone plugin package: the node-half library
 * (host plugin, invariant companion, CLI) from the tsc output, plus the
 * browser client bundle in the closure-factory format the dsh web module
 * loader consumes — the bundle calls `window.__ModuleLoader__.load({id,
 * factory})` and resolves platform externals through the injected require.
 *
 * Adapted from deepseek-harness's shared preset (`packages/client/tsdown.client.ts`):
 * same banner/footer handoff, same platform-module externals, same CSS-Modules
 * inlining (lightningcss; the css text auto-injects a `<style data-plugin>`
 * tag at factory execution), same bundle-purity gate. The monorepo's build
 * faces and repository-mirrored sourcemap rebasing do not apply here.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Plugin id stamped into the `__ModuleLoader__.load` handoff and the injected style tags. */
const ID = 'dsh-timemachine'

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches ids
 * ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * The module specifiers the web shell shares into the frozen module table
 * (source: `packages/client/web/src/platform.ts` PLATFORM_MODULES).
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/**
 * Documented TEMPORARY exemption carried over from the preset: the
 * snapshot-store engine (defineStore) lives in the client runtime pending its
 * rehoming, and the lazy CJS table answers the require natively.
 */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table: the platform seed entries plus the documented runtime exemption. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

const nodeLibrary: UserConfig = {
  name: ID,
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/cli.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  // Types ship from lib/types (tsc).
  dts: false,
  clean: false,
}

const clientBundle: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'lib/types/client/index.js' },
  // The browser bundle lands next to the node half (single lib/ artifact dir;
  // the entryFileNames pin keeps it exactly lib/client.js). clean must stay
  // off — a default clean would wipe the node-half output emitted above.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  // Plugin code is fetched outside Vite's module graph, so its own bundle
  // must carry the TS/TSX mapping consumed by browser profiling tools.
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // Inlined browser code reads node-idiom env probes (the store engine reads
  // process.env.NODE_ENV and import.meta.env.MODE); a CJS artifact cannot
  // carry import.meta, so both are substituted here.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // tsdown auto-externalizes package dependencies; anything NOT in the loader
  // module table must inline instead (this package's own modules, zod-free
  // wire types). A require() the table cannot answer is a guaranteed runtime
  // throw, so the rule is the table list itself.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    // Bundle purity gate: platform seed entries stay external; every other
    // @deepseek-ai value import is a build error — it would either inline a
    // duplicate runtime instance or require a specifier the frozen module
    // table cannot answer. Cross-plugin collaboration goes through cordis
    // services (type-only imports are erased and never reach this gate).
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }, {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      // One <style data-plugin> per module file; idempotent under re-evaluation.
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

export default [nodeLibrary, clientBundle]
