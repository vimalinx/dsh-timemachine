import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The tests self-import the package by name; alias it to the sources so a
// build is not required before running vitest. The published
// `dsh-client-*/client` artifacts are browser closure bundles, so their
// specifiers alias to the capturing shims under tests/shims instead — and the
// client packages are inlined so their compiled imports resolve through the
// same aliases (an externalized dependency would bypass vite resolution).
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-runtime/client': fileURLToPath(new URL('./tests/shims/runtime-client.ts', import.meta.url)),
      '@deepseek-ai/dsh-client-locale/client': fileURLToPath(new URL('./tests/shims/locale-client.ts', import.meta.url)),
      '@vimalinx/dsh-timemachine/invariant': fileURLToPath(new URL('./src/invariant.ts', import.meta.url)),
      '@vimalinx/dsh-timemachine': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-/, /@deepseek-ai\/dsh-host-/],
      },
    },
  },
})
