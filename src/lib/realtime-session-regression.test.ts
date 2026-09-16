import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClientToolBridge } from './agent-core'
import type { ServerFrame } from './protocol'

const captured = vi.hoisted(() => ({ signals: [] as AbortSignal[], outcomes: [] as string[] }))
vi.mock('./agent-core', () => ({
  availableTools: () => [], fetchVoice: vi.fn(), getPublicConfig: () => ({}), warmUpstream: vi.fn(),
  streamTurn: async function* (id: string, _messages: unknown, signal: AbortSignal, options: { bridge: ClientToolBridge }) {
    captured.signals.push(signal)
    const result = options.bridge.call('reused-call', 'test_tool', {}, signal)
    yield { t: 'tool_request', id, call: 'reused-call', name: 'test_tool', args: {} }
    captured.outcomes.push((await result).content)
    yield { t: 'done', id, text: 'finished' }
  },
}))
import { createRealtimeSession } from './realtime-session'

beforeEach(() => { vi.useFakeTimers(); captured.signals.length = 0; captured.outcomes.length = 0 })
afterEach(() => { vi.useRealTimers() })
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const turn = (id: string) => JSON.stringify({ t: 'turn', id, messages: [{ role: 'user', content: 'hello' }] })
const reply = (id: string, content: string) => JSON.stringify({ t: 'tool_reply', id, call: 'reused-call', ok: true, content })

it('matches turn AND call, ignoring a late cancelled reply even when the call is reused', async () => {
  const frames: ServerFrame[] = []
  const session = createRealtimeSession({ sendText: (data) => frames.push(JSON.parse(data)), sendBinary: vi.fn() })
  const old = session.handleMessage(turn('old'))
  await tick()
  await session.handleMessage(JSON.stringify({ t: 'cancel', id: 'old' }))
  await old
  const next = session.handleMessage(turn('next'))
  await tick()
  const cleanup = vi.spyOn(captured.signals[1], 'removeEventListener')
  await session.handleMessage(reply('old', 'stale old answer'))
  await tick()
  expect(captured.outcomes).toEqual(['That turn was cancelled.'])
  expect(frames.filter((frame) => frame.t === 'done')).toHaveLength(0)
  await session.handleMessage(reply('next', 'correct answer'))
  await next
  expect(captured.outcomes).toEqual(['That turn was cancelled.', 'correct answer'])
  expect(cleanup).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
  session.close()
})

it.each(['timeout', 'close'] as const)('cleans the tool abort listener on %s', async (end) => {
  const session = createRealtimeSession({ sendText: vi.fn(), sendBinary: vi.fn() })
  const pending = session.handleMessage(turn('turn'))
  await tick()
  const cleanup = vi.spyOn(captured.signals[0], 'removeEventListener')
  if (end === 'close') session.close()
  else await vi.advanceTimersByTimeAsync(8_000)
  await pending
  expect(cleanup).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
  session.close()
})
