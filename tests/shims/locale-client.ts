/**
 * Vitest alias target for `@deepseek-ai/dsh-client-locale/client`; see
 * `./client-bundles.ts` for why the published artifact cannot be imported in
 * a node test process directly.
 * @module dsh-config-generations/tests/shims/locale-client
 */

import { loadBundle } from './client-bundles.ts'

const bundle = loadBundle('@deepseek-ai/dsh-client-locale/client') as Record<string, unknown>

export const LocaleRuntime = bundle['LocaleRuntime']
