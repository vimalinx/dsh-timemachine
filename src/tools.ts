/**
 * The model-facing tools over the `timemachine` service: snapshot, undo, redo,
 * restore, list. Descriptions are bilingual and name the natural-language
 * triggers ("撤销上一步/回退到某版本/恢复/保存快照/查看配置历史") so the model
 * reaches for them on the words a user actually says.
 *
 * Every execution appends a `timemachine/*` event to the calling agent's
 * session log (pattern: `@deepseek-ai/dsh-tool-todo`) as an audit trail of who
 * moved the configuration; a non-agent caller (no owning session) simply skips
 * the append and still gets the work done.
 * @module dsh-timemachine/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type TimeMachine from './service.ts'
import type { StackRestoreResult } from './types.ts'

/** The service one tool call runs against; a profile-less tree rejects the call. */
function serviceOf(ctx: Context): TimeMachine {
  const service = ctx.get('timemachine')
  if (service === undefined || !service.available) {
    throw new Error('configuration history is unavailable: this tree was not booted from a dsh profile')
  }
  return service
}

/** The canonical text rendering every tool shares. */
const text = (value: string): { type: 'text', text: string }[] => [{ type: 'text', text: value }]

function snapshotTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'timemachine_snapshot',
    description:
      'Save a manual snapshot of the current profile configuration (plugin tree inputs) '
      + 'into the configuration history. Trigger words: "保存快照", "save a snapshot", '
      + '"记下当前配置". Snapshots are never auto-cleaned.',
    parameters: {
      reason: {
        type: 'string',
        description: 'Why this snapshot is taken, recorded with it (e.g. "before enabling the web panel").',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true } },
      },
      render: (_args, value) => text(`Saved configuration snapshot ${value.id}.`),
    },
    async execute(args, exec) {
      const generation = await serviceOf(ctx).snapshot(args.reason, new Date().toISOString())
      if (generation === undefined) {
        throw new Error('configuration history is unavailable: this tree was not booted from a dsh profile')
      }
      exec.agent?.session.append('timemachine/snapshot', generation.reason === undefined
        ? { id: generation.id }
        : { id: generation.id, reason: generation.reason })
      return { id: generation.id }
    },
  })
}

/** The shared output schema of the undo/redo step tools. */
const STEP_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    changed: { type: 'boolean', required: true },
    id: { type: 'string' },
    message: { type: 'string', required: true },
  },
} as const

function undoTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'timemachine_undo',
    description:
      'Undo the last configuration change of this profile, restoring the previously seen '
      + 'plugin-tree inputs (they take effect at the next boot). Trigger words: "撤销上一步", '
      + '"undo the config change". The stepped-away-from configuration stays redoable.',
    parameters: {},
    output: {
      schema: STEP_OUTPUT,
      render: (_args, value) => text(value.message),
    },
    async execute(_args, exec) {
      const step = await serviceOf(ctx).undo(new Date().toISOString())
      exec.agent?.session.append('timemachine/undo', step.result === undefined
        ? { changed: step.changed }
        : { changed: step.changed, id: step.result.id })
      return stepResult(step)
    },
  })
}

function redoTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'timemachine_redo',
    description:
      'Redo a previously undone configuration change of this profile. Trigger words: "重做", '
      + '"redo". Only works until a new configuration change is recorded, which clears the redo stack.',
    parameters: {},
    output: {
      schema: STEP_OUTPUT,
      render: (_args, value) => text(value.message),
    },
    async execute(_args, exec) {
      const step = await serviceOf(ctx).redo()
      exec.agent?.session.append('timemachine/redo', step.result === undefined
        ? { changed: step.changed }
        : { changed: step.changed, id: step.result.id })
      return stepResult(step)
    },
  })
}

/** Fold a step's outcome into the tools' canonical value. */
function stepResult(step: StackRestoreResult): { changed: boolean, id?: string, message: string } {
  if (step.empty !== undefined) {
    return {
      changed: false,
      message: step.empty === 'nothing-to-undo'
        ? 'Nothing to undo: no earlier configuration is recorded.'
        : 'Nothing to redo: the redo stack is empty.',
    }
  }
  const result = step.result!
  if (!result.restored) {
    return { changed: false, id: result.id, message: `Could not restore ${result.id}: ${result.refusal ?? 'unknown refusal'}` }
  }
  return { changed: true, id: result.id, message: `Restored configuration ${result.id}; it takes effect at the next boot.` }
}

function restoreTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'timemachine_restore',
    description:
      'Restore the profile configuration to a recorded generation by id (plugin-tree inputs '
      + 'are written back and verified; a generation that no longer reproduces is refused '
      + 'untouched). Trigger words: "回退到某版本", "恢复到某个配置", "restore that version". '
      + 'The change takes effect at the next boot.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'The generation id (or an unambiguous prefix) from timemachine_list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          restored: { type: 'boolean', required: true },
          refusal: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.restored
        ? `Restored configuration ${value.id}; it takes effect at the next boot.`
        : `Refused to restore ${value.id}: ${value.refusal ?? 'unknown refusal'}`),
    },
    async execute(args, exec) {
      const result = await serviceOf(ctx).restore(args.id)
      exec.agent?.session.append('timemachine/restore', { id: result.id, restored: result.restored })
      return result.refusal === undefined
        ? { id: result.id, restored: result.restored }
        : { id: result.id, restored: result.restored, refusal: result.refusal }
    },
  })
}

function listTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'timemachine_list',
    description:
      'List the recorded configuration history of this profile: ids, origins, outcomes, '
      + 'and which one is the last known-good. Trigger words: "查看配置历史", "list config '
      + 'history", "show previous configurations".',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          generations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                origin: { type: 'string', required: true },
                lastSeenAt: { type: 'string', required: true },
                latestStatus: { type: 'string' },
                lastGood: { type: 'boolean', required: true },
                booted: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => text(`${value.total} recorded configuration(s).`),
    },
    execute(_args, exec) {
      const service = serviceOf(ctx)
      const lastGood = service.lastGood()
      const generations = service.list().generations.map(generation => ({
        id: generation.id,
        origin: generation.origin ?? 'boot',
        lastSeenAt: generation.lastSeenAt,
        ...generation.outcomes.at(-1) === undefined ? {} : { latestStatus: generation.outcomes.at(-1)!.status },
        lastGood: generation.id === lastGood?.id,
        booted: generation.id === service.bootedId,
      }))
      exec.agent?.session.append('timemachine/list', { total: generations.length })
      return Promise.resolve({ total: generations.length, generations })
    },
  })
}

/**
 * Register all five tools on `ctx.tools`. A duplicate registration throws
 * (another copy of this plugin, a test double), and that must degrade to a
 * logged warning per tool — the history service and the RPC channel matter
 * more than the model-facing surface.
 * @param ctx - the plugin context (with `tools` injected by the caller).
 */
export function registerTimemachineTools(ctx: Context): void {
  for (const tool of [snapshotTool(ctx), undoTool(ctx), redoTool(ctx), restoreTool(ctx), listTool(ctx)]) {
    try {
      ctx.tools.register(tool)
    } catch (error: unknown) {
      ctx.logger('timemachine').warn(
        `could not register agent tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
