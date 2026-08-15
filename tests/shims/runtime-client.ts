/**
 * Vitest alias target for `@deepseek-ai/dsh-client-runtime/client`: the
 * published artifact is a browser closure bundle, so tests import the values
 * it registers through the capture shim instead. Types still come from the
 * real package — this file only replaces the runtime resolution.
 * @module dsh-config-generations/tests/shims/runtime-client
 */

import { loadBundle } from './client-bundles.ts'

const bundle = loadBundle('@deepseek-ai/dsh-client-runtime/client') as Record<string, unknown>

export const defineStore = bundle['defineStore']
export const createSnapshotStore = bundle['createSnapshotStore']
export const SlotRegistry = bundle['SlotRegistry']
