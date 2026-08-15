/**
 * Host-side zod schemas for the `/timemachine` wire payloads
 * (`./rpc.ts` owns the types). The wire is a boundary the browser controls,
 * so every payload is validated here before the service sees it; the client
 * bundle never imports this module, keeping zod out of the browser artifact.
 * @module dsh-timemachine/rpc-schemas
 */

import { z } from 'zod'

/** `list`/`undo`/`redo`/`export`/`status`/`getSettings` take no arguments; unknown keys are stripped, not rejected. */
export const listRequestSchema = z.object({})

/** No-argument endpoints other than `list` (same validation, own name for error messages). */
export const emptyRequestSchema = z.object({})

/** `read`/`restore`/`remove` address one generation by id or unambiguous prefix. */
export const idRequestSchema = z.object({ id: z.string().min(1) })

/** `snapshot` carries an optional human note. */
export const snapshotRequestSchema = z.object({ reason: z.string().min(1).optional() })

/** `diff` addresses one generation, optionally against another instead of the live state. */
export const diffRequestSchema = z.object({
  id: z.string().min(1),
  otherId: z.string().min(1).optional(),
})

/** `import` carries the base64 archive; decoding failures surface at unzip, not here. */
export const importRequestSchema = z.object({ data: z.string().min(1) })

/**
 * `updateSettings` carries a partial settings object. Wrong-typed fields fail
 * validation here rather than being silently merged over the defaults (the
 * file reader's hand-edit tolerance is for the durable boundary, not the wire).
 */
export const updateSettingsRequestSchema = z.object({
  patch: z.object({
    autoSave: z.boolean().optional(),
    debounceMs: z.number().int().positive().optional(),
    retention: z.number().int().positive().optional(),
    shortcuts: z.object({
      undo: z.string().min(1).optional(),
      redo: z.string().min(1).optional(),
    }).optional(),
  }),
})
