// @vitest-environment jsdom
/**
 * Shortcut listener spec (jsdom for `window`): the configured combinations
 * open the header entry's stack confirmation, editable targets are never
 * hijacked, a settings update hot-swaps the combinations, and fiber disposal
 * removes the listener.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TimemachineSettings } from '../src/types.ts'
import type { TimeMachineRpcResult } from '../src/rpc.ts'
import { apply, inject } from '../src/client/index.ts'
import { createHeaderActionsStore } from '../src/client/store.ts'

const SETTINGS: TimemachineSettings = {
  autoSave: true,
  debounceMs: 1500,
  retention: 50,
  shortcuts: { undo: 'Ctrl+Alt+Z', redo: 'Ctrl+Alt+Y' },
}

function fakeApi(settings: TimemachineSettings = SETTINGS) {
  const getSettings = vi.fn(() => Promise.resolve<TimeMachineRpcResult<TimemachineSettings>>({ ok: true, value: settings }))
  const call = vi.fn((channel: string, endpoint: string, _payload: unknown) => {
    if (channel !== '/timemachine') throw new Error(`unexpected channel ${channel}`)
    if (endpoint === 'getSettings') return getSettings()
    return Promise.resolve<TimeMachineRpcResult<never>>({ ok: false, error: { code: 'internal', message: 'unstubbed', details: {} } })
  })
  return { call, getSettings }
}

async function bench(api: ReturnType<typeof fakeApi>) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { rpc: { call: api.call } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  // The boot-time settings read resolves on a microtask; flush it.
  await vi.waitFor(() => { expect(api.getSettings).toHaveBeenCalled() })
  await Promise.resolve()
  await Promise.resolve()
  return { ctx, fiber }
}

/** Materialize the header entry's inject face over a test-created store instance. */
function headerStoreOf(ctx: Context) {
  const entry = ctx.slots.entries('conversation.session.header.actions').find(candidate => candidate.options.id === 'timemachine-actions')
  expect(entry).toBeDefined()
  const store = createHeaderActionsStore().create()
  const factory = entry!.inject as unknown as (sessionId: string, actions: typeof store.actions) => unknown
  factory('session-1', store.actions)
  return store
}

/** Dispatch a keydown; `init` carries the modifier flags and key. */
function press(target: Window | HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('timemachine shortcuts', () => {
  it('the default combinations open the undo/redo confirmations and are consumed', async () => {
    const { ctx } = await bench(fakeApi())
    const store = headerStoreOf(ctx)

    const undoEvent = press(window, { key: 'z', ctrlKey: true, altKey: true })
    expect(store.getSnapshot().confirm).toBe('undo')
    expect(undoEvent.defaultPrevented).toBe(true)

    store.actions.cancelStack()
    const redoEvent = press(window, { key: 'y', ctrlKey: true, altKey: true })
    expect(store.getSnapshot().confirm).toBe('redo')
    expect(redoEvent.defaultPrevented).toBe(true)
  })

  it('unmatched and modifier-only presses are ignored', async () => {
    const { ctx } = await bench(fakeApi())
    const store = headerStoreOf(ctx)

    press(window, { key: 'z', ctrlKey: true })
    press(window, { key: 'x', ctrlKey: true, altKey: true })
    press(window, { key: 'Control', ctrlKey: true, altKey: true })
    expect(store.getSnapshot().confirm).toBeUndefined()
  })

  it('keys landing in editable content are never hijacked', async () => {
    const { ctx } = await bench(fakeApi())
    const store = headerStoreOf(ctx)

    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      press(input, { key: 'z', ctrlKey: true, altKey: true })
      expect(store.getSnapshot().confirm).toBeUndefined()
      const area = document.createElement('textarea')
      document.body.appendChild(area)
      press(area, { key: 'y', ctrlKey: true, altKey: true })
      expect(store.getSnapshot().confirm).toBeUndefined()
    } finally {
      input.remove()
      document.body.querySelectorAll('textarea').forEach(node => node.remove())
    }
  })

  it('a settings read hot-swaps the combinations', async () => {
    const custom: TimemachineSettings = { ...SETTINGS, shortcuts: { undo: 'Ctrl+Alt+U', redo: 'Ctrl+Shift+R' } }
    const { ctx } = await bench(fakeApi(custom))
    const store = headerStoreOf(ctx)

    press(window, { key: 'z', ctrlKey: true, altKey: true })
    expect(store.getSnapshot().confirm).toBeUndefined()
    press(window, { key: 'u', ctrlKey: true, altKey: true })
    expect(store.getSnapshot().confirm).toBe('undo')
    store.actions.cancelStack()
    press(window, { key: 'r', ctrlKey: true, shiftKey: true })
    expect(store.getSnapshot().confirm).toBe('redo')
  })

  it('a failed settings read keeps the defaults', async () => {
    const api = fakeApi()
    api.getSettings.mockReturnValue(Promise.resolve({ ok: false, error: { code: 'timemachine-absent', message: 'no profile boot', details: {} } }))
    const { ctx } = await bench(api)
    const store = headerStoreOf(ctx)

    press(window, { key: 'z', ctrlKey: true, altKey: true })
    expect(store.getSnapshot().confirm).toBe('undo')
  })

  it('fiber disposal removes the listener', async () => {
    const { ctx, fiber } = await bench(fakeApi())
    const store = headerStoreOf(ctx)
    await fiber.dispose()

    press(window, { key: 'z', ctrlKey: true, altKey: true })
    expect(store.getSnapshot().confirm).toBeUndefined()
  })
})
