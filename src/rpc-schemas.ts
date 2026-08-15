/**
 * Host-side zod schemas for the `/timemachine` wire payloads
 * (`./rpc.ts` owns the types). The wire is a boundary the browser controls,
 * so every payload is validated here before the service sees it; the client
 * bundle never imports this module, keeping zod out of the browser artifact.
 * @module dsh-timemachine/rpc-schemas
 */

import { z } from 'zod'

/** `list` takes no arguments; unknown keys are stripped, not rejected. */
export const listRequestSchema = z.object({})

/** `read`/`restore` address one generation by id or unambiguous prefix. */
export const idRequestSchema = z.object({ id: z.string().min(1) })
