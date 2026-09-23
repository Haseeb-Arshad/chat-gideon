import { afterEach, expect, it, vi } from 'vitest'
import type { ServerFrame } from './protocol'

const harness = vi.hoisted(() => ({ voice: vi.fn() }))
vi.mock('./agent-core', () => ({
  availableTools: () => [],
  fetchVoice: harness.voice,
  getPublicConfig: () => ({ configured: true, chatModel: 'fixture', voiceModel: 'fixture', sttModel: 'fixture' }),
  warmUpstream: vi.fn(),
  streamTurn: async function* (id: string) {
    const responseId = 'server-response-1'
    yield { t: 'start', id, responseId }
    yield { t: 'delta', id, responseId, segmentId: 'server-text-1', startChar: 0, endChar: 6, text: 'Hello.' }
    yield { t: 'done', id, responseId, text: 'Hello.' }
  },
}))
import { createRealtimeSession } from './realtime-session'

afterEach(() => vi.clearAllMocks())

it('binds realtime speech to exact server-issued response text and issues its own audio segment ID', async () => {
  harness.voice.mockResolvedValue({
    ok: true, mime: 'audio/mpeg', body: new Uint8Array([1, 2, 3]).buffer,
    code: '', message: '', retryable: false,
  })
  const frames: ServerFrame[] = []
  const binary: Uint8Array[] = []
  const session = createRealtimeSession({
    sendText: (raw) => frames.push(JSON.parse(raw) as ServerFrame),
    sendBinary: (bytes) => binary.push(bytes),
  })

  await session.handleMessage(JSON.stringify({
    t: 'turn', id: 'turn-1', messages: [{ role: 'user', content: 'hello' }],
  }))
  expect(frames).toContainEqual(expect.objectContaining({ t: 'done', id: 'turn-1', responseId: 'server-response-1', text: 'Hello.' }))

  await session.handleMessage(JSON.stringify({
    t: 'speak', id: 'turn-1#0', seq: 0, turnId: 'turn-1', responseId: 'server-response-1',
    startChar: 0, endChar: 6, text: 'Hacked.',
  }))
  expect(harness.voice).not.toHaveBeenCalled()
  expect(frames.at(-1)).toMatchObject({ t: 'error', code: 'invalid_delivery_binding' })

  await session.handleMessage(JSON.stringify({
    t: 'speak', id: 'turn-1#1', seq: 1, turnId: 'turn-1', responseId: 'server-response-1',
    startChar: 0, endChar: 6, text: 'Hello.',
  }))
  const audio = frames.find((frame) => frame.t === 'audio')
  expect(audio).toMatchObject({
    t: 'audio', responseId: 'server-response-1', startChar: 0, endChar: 6, segmentId: expect.any(String),
  })
  expect(binary).toHaveLength(1)
  expect(harness.voice).toHaveBeenCalledTimes(1)

  if (audio?.t === 'audio' && audio.segmentId) {
    await session.handleMessage(JSON.stringify({
      t: 'observation', id: 'report-1', turnId: 'turn-1', responseId: 'server-response-1',
      kind: 'playback_reported', segmentId: audio.segmentId, startChar: 0, endChar: 3,
    }))
  }
  session.close()
})
