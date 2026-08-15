/**
 * The agent-facing tools: registration (with the duplicate-name degradation),
 * execution against the mounted service, and the session audit append that a
 * non-agent caller skips.
 * @module dsh-timemachine/tests/tools
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import TimeMachine from '../src/service.ts'
import { registerTimemachineTools } from '../src/tools.ts'
import type { ConfigGenerationHost, GenerationInputs } from '../src/types.ts'

let profileDir: string

const MANIFEST = '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n'
const PATCH = '[]\n'

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'dsh-timemachine-tools-'))
  writeFileSync(join(profileDir, 'package.json'), MANIFEST)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH)
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

/** The same stand-in host the service specs use. */
function host(): ConfigGenerationHost {
  const readInputs = (): GenerationInputs => ({
    manifest: readFileSync(join(profileDir, 'package.json'), 'utf8'),
    profilePatch: exists(join(profileDir, 'cordis.patch.yml')),
    homePatch: null,
  })
  return {
    profile: 'headless',
    profileDir,
    bootedId: undefined,
    readInputs,
    render: () => `- id: llm\n# patch ${readInputs().profilePatch ?? 'absent'}\n`,
    readBundles: () => [{ name: '@deepseek-ai/dsh-base', version: '0.1.0-rc.5' }],
  }
}

const exists = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

interface Bench {
  tools: Map<string, ToolDefinition>
  warnings: string[]
  service: TimeMachine
}

/**
 * A structural fake of the context the tool registrar touches: a capturing
 * tool registry that throws on duplicate names (like the real one), a warning
 * sink standing in for `ctx.logger`, and `get` answering the mounted service.
 */
function bench(withService = true): Bench {
  const tools = new Map<string, ToolDefinition>()
  const warnings: string[] = []
  const service = new TimeMachine(new Context(), withService ? host() : undefined)
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        if (tools.has(definition.name)) throw new Error(`duplicate tool name ${definition.name}`)
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    logger: () => ({ warn: (message: string) => warnings.push(message) }),
    get: (name: string) => name === 'timemachine' ? service : undefined,
  } as unknown as Context
  registerTimemachineTools(ctx)
  return { tools, warnings, service }
}

/** The execution context a non-agent caller runs with. */
const NO_AGENT = { agent: undefined } as never

/** A capturing agent session for the audit append. */
function agentSession(): { exec: never, events: { type: string, data: unknown }[] } {
  const events: { type: string, data: unknown }[] = []
  const exec = {
    agent: { session: { append: (type: string, data: unknown) => events.push({ type, data }) } },
  } as never
  return { exec, events }
}

describe('registration', () => {
  it('registers all five tools with bilingual trigger descriptions', () => {
    const { tools, warnings } = bench()
    expect([...tools.keys()].sort()).toEqual([
      'timemachine_list', 'timemachine_redo', 'timemachine_restore', 'timemachine_snapshot', 'timemachine_undo',
    ])
    expect(warnings).toEqual([])
    expect(tools.get('timemachine_undo')!.description).toContain('撤销上一步')
    expect(tools.get('timemachine_restore')!.description).toContain('回退到某版本')
    expect(tools.get('timemachine_snapshot')!.description).toContain('保存快照')
    expect(tools.get('timemachine_list')!.description).toContain('查看配置历史')
  })

  it('degrades a duplicate registration to a warning and keeps the rest', () => {
    const first = bench()
    // A second registration of the same five hits the registry's duplicate
    // guard; each failure is logged and none of it throws back into the plugin.
    const warnings: string[] = []
    const ctx = {
      tools: {
        register: (definition: ToolDefinition) => {
          if (first.tools.has(definition.name)) throw new Error(`duplicate tool name ${definition.name}`)
          return () => {}
        },
      },
      logger: () => ({ warn: (message: string) => warnings.push(message) }),
      get: () => undefined,
    } as unknown as Context
    expect(() => registerTimemachineTools(ctx)).not.toThrow()
    expect(warnings).toHaveLength(5)
    expect(warnings[0]).toContain('duplicate tool name')
  })
})

describe('execution', () => {
  it('snapshots with a reason and appends the session event', async () => {
    const { tools, service } = bench()
    const { exec, events } = agentSession()
    const value = await tools.get('timemachine_snapshot')!.execute({ reason: 'before the change' }, exec) as { id: string }
    expect(service.read(value.id).reason).toBe('before the change')
    expect(events).toEqual([{ type: 'timemachine/snapshot', data: { id: value.id, reason: 'before the change' } }])
  })

  it('works without an agent context, skipping only the append', async () => {
    const { tools, service } = bench()
    const value = await tools.get('timemachine_snapshot')!.execute({}, NO_AGENT) as { id: string }
    expect(service.read(value.id).origin).toBe('manual')
  })

  it('undoes and redoes through the tools', async () => {
    const { tools, service } = bench()
    await service.snapshot(undefined, '2026-08-14T00:00:00.000Z')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: changed\n')
    await service.snapshot(undefined, '2026-08-14T01:00:00.000Z')

    const undo = await tools.get('timemachine_undo')!.execute({}, NO_AGENT) as { changed: boolean, message: string }
    expect(undo.changed).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(PATCH)

    const redo = await tools.get('timemachine_redo')!.execute({}, NO_AGENT) as { changed: boolean, message: string }
    expect(redo.changed).toBe(true)
    const again = await tools.get('timemachine_redo')!.execute({}, NO_AGENT) as { changed: boolean, message: string }
    expect(again).toEqual({ changed: false, message: 'Nothing to redo: the redo stack is empty.' })
  })

  it('restores by id and reports a refusal as a value, not a throw', async () => {
    const { tools, service } = bench()
    const generation = (await service.snapshot(undefined, '2026-08-14T00:00:00.000Z'))!
    const { exec, events } = agentSession()
    const value = await tools.get('timemachine_restore')!.execute({ id: generation.id }, exec) as {
      id: string, restored: boolean
    }
    expect(value).toEqual({ id: generation.id, restored: true })
    expect(events).toEqual([{ type: 'timemachine/restore', data: { id: generation.id, restored: true } }])
  })

  it('lists the history', async () => {
    const { tools, service } = bench()
    const generation = (await service.snapshot(undefined, '2026-08-14T00:00:00.000Z'))!
    const value = await tools.get('timemachine_list')!.execute({}, NO_AGENT) as {
      total: number, generations: { id: string, origin: string }[]
    }
    expect(value.total).toBe(1)
    expect(value.generations[0]).toMatchObject({ id: generation.id, origin: 'manual' })
  })

  it('rejects every tool when the tree has no profile', async () => {
    const { tools } = bench(false)
    for (const [name, tool] of tools) {
      const args = name === 'timemachine_restore' ? { id: 'aaaa00000000' } : {}
      await expect(tool.execute(args, NO_AGENT)).rejects.toThrow('not booted from a dsh profile')
    }
  })
})
