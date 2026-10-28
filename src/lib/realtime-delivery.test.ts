import { afterEach, expect, it, vi } from 'vitest'
import type { ServerFrame } from './protocol'
import type { InteractionAudit } from './interaction-audit'

const harness = vi.hoisted(() => ({ voice: vi.fn() }))
vi.mock('./agent-core', () => ({
  availableTools: () => [],
  fetchVoice: harness.voice,
  getPublicConfig: () => ({ configured: true, chatModel: 'fixture', voiceModel: 'fixture', sttModel: 'fixture' }),
  warmUpstream: vi.fn(), warmProviders: vi.fn(),
  streamTurn: async function* (id: string) {
    const responseId = 'server-response-1'
    yield { t: 'start', id, responseId }
    yield { t: 'delta', id, responseId, segmentId: 'server-text-1', startChar: 0, endChar: 6, text: 'Hello.' }
    yield { t: 'done', id, responseId, text: 'Hello.' }
  },
}))
import { createRealtimeSession } from './realtime-session'

afterEach(() => vi.clearAllMocks())

it('starts the first speech phrase on the server without a second client request', async () => {
  const frames: ServerFrame[] = []
  const binary = vi.fn()
  harness.voice.mockResolvedValue({ ok: true, mime: 'audio/mpeg', body: new Uint8Array([1, 2]).buffer })
  const session = createRealtimeSession({ sendText: raw => frames.push(JSON.parse(raw)), sendBinary: binary })
  const voiceChoice = { model: 'fish-audio/s2.1-pro', voice: '933563129e564b19a115bedd57b7406a' }
  await session.handleMessage(JSON.stringify({ t: 'turn', id: 'auto-1', messages: [{ role: 'user', content: 'hello' }], autoSpeech: true, voiceChoice }))
  expect(harness.voice).toHaveBeenCalledExactlyOnceWith('Hello.', expect.any(AbortSignal), voiceChoice)
  expect(frames.find(frame => frame.t === 'audio')).toMatchObject({ id: 'auto-1#0', startChar: 0, endChar: 6, responseId: 'server-response-1' })
  expect(binary).toHaveBeenCalledOnce()
  session.close()
})

it('keeps automatic speech disabled for speculative or text-only turns', async () => {
  const session = createRealtimeSession({ sendText: vi.fn(), sendBinary: vi.fn() })
  await session.handleMessage(JSON.stringify({ t: 'turn', id: 'spec', messages: [{ role: 'user', content: 'hello' }], autoSpeech: true, speculative: true }))
  await session.handleMessage(JSON.stringify({ t: 'turn', id: 'text', messages: [{ role: 'user', content: 'hello' }] }))
  expect(harness.voice).not.toHaveBeenCalled()
  session.close()
})

it('sends the audio before the recording is kept, and files it under its turn', async () => {
  const frames: ServerFrame[] = []
  const binary = vi.fn()
  // The audio has already gone out by the time it is handed over for keeping.
  const recordSpeech = vi.fn((_input: unknown) => { expect(binary).toHaveBeenCalledOnce(); return 'segment' })
  harness.voice.mockResolvedValue({ ok: true, mime: 'audio/mpeg', body: new Uint8Array([1, 2]).buffer })
  const session = createRealtimeSession({ sendText: raw => frames.push(JSON.parse(raw)), sendBinary: binary }, { auditFactory: { recordSpeech } as never })
  await session.handleMessage(JSON.stringify({ t: 'speak', id: 'voice-turn#2', seq: 2, text: 'Hello.' }))
  expect(binary).toHaveBeenCalledOnce()
  expect(recordSpeech).toHaveBeenCalledOnce()
  expect(recordSpeech.mock.calls[0][0]).toMatchObject({
    source: 'assistant', clientTurnId: 'voice-turn', seq: 2, text: 'Hello.', mime: 'audio/mpeg',
    metadata: { requestId: 'voice-turn#2', synthesisMs: expect.any(Number) },
  })
  session.close()
})

it('still sends the audio when keeping it fails', async () => {
  const binary = vi.fn()
  harness.voice.mockResolvedValue({ ok: true, mime: 'audio/mpeg', body: new Uint8Array([1, 2]).buffer })
  const frames: ServerFrame[] = []
  const session = createRealtimeSession({ sendText: raw => frames.push(JSON.parse(raw)), sendBinary: binary }, {
    auditFactory: { recordSpeech: () => { throw new Error('database') } } as never,
  })
  await session.handleMessage(JSON.stringify({ t: 'speak', id: 'voice-0', seq: 0, text: 'Hello.' }))
  expect(frames.map(frame => frame.t)).toEqual(['audio'])
  expect(binary).toHaveBeenCalledOnce()
  session.close()
})

it('validates and forwards a per-request voice on the realtime path', async () => {
  const frames: ServerFrame[] = []
  const session = createRealtimeSession({ sendText: raw => frames.push(JSON.parse(raw)), sendBinary: vi.fn() })
  const voiceChoice = { model: 'fish-audio/s2.1-pro', voice: '933563129e564b19a115bedd57b7406a' }
  harness.voice.mockResolvedValue({ ok: true, mime: 'audio/mpeg', body: new Uint8Array([1, 2]).buffer })
  await session.handleMessage(JSON.stringify({ t: 'speak', id: 'choice-1', seq: 0, text: 'Hello.', voiceChoice }))
  expect(harness.voice).toHaveBeenCalledWith('Hello.', expect.any(AbortSignal), voiceChoice)
  harness.voice.mockClear()
  await session.handleMessage(JSON.stringify({ t: 'speak', id: 'choice-2', seq: 0, text: 'Hello.',
    voiceChoice: { ...voiceChoice, model: 'microsoft/mai-voice-2.1-flash' } }))
  expect(harness.voice).not.toHaveBeenCalled()
  expect(frames.at(-1)).toMatchObject({ t: 'error', code: 'invalid_voice_choice' })
  session.close()
})

function auditStub() {
  return {
    turnId: 'audit-turn',
    record: vi.fn<InteractionAudit['record']>(),
    mark: vi.fn<InteractionAudit['mark']>(),
    finish: vi.fn<InteractionAudit['finish']>(),
    saveAudio: vi.fn<InteractionAudit['saveAudio']>(() => 'segment'),
  } satisfies InteractionAudit
}

it('runs a whole turn without once waiting on the record', async () => {
  const audit = auditStub()
  const startTurn = vi.fn(() => audit)
  const frames: ServerFrame[] = []
  const session = createRealtimeSession({ sendText: (raw) => frames.push(JSON.parse(raw)), sendBinary: vi.fn() }, {
    auditFactory: { startTurn } as never,
  })
  await session.handleMessage(JSON.stringify({ t: 'turn', id: 'fast', messages: [{ role: 'user', content: 'hello' }] }))
  expect(frames.map((frame) => frame.t)).toEqual(['start', 'delta', 'done'])
  expect(startTurn).toHaveBeenCalledExactlyOnceWith({ clientTurnId: 'fast', messages: [{ role: 'user', content: 'hello' }], speculative: false })
  // The reply is kept whole and timed; its tokens are counted, not stored one row each.
  expect(audit.record.mock.calls.map(([type, payload]) => [type, payload.type])).toEqual([['released_frame', 'start'], ['released_frame', 'done']])
  expect(audit.record.mock.calls.at(-1)![1]).toMatchObject({ deltas: 1 })
  expect(audit.mark.mock.calls.map(([stage]) => stage)).toEqual(['setup', 'first_token', 'done'])
  expect(audit.finish).toHaveBeenCalledExactlyOnceWith('completed')
  session.close()
})

it('answers even when the record cannot be started or written', async () => {
  const audit = auditStub()
  audit.record.mockImplementation(() => { throw new Error('writer broken') })
  const frames: ServerFrame[] = []
  const broken = createRealtimeSession({ sendText: (raw) => frames.push(JSON.parse(raw)), sendBinary: vi.fn() }, {
    auditFactory: { startTurn: () => { throw new Error('database') } } as never,
  })
  await broken.handleMessage(JSON.stringify({ t: 'turn', id: 'unrecorded', messages: [{ role: 'user', content: 'hello' }] }))
  expect(frames.map((frame) => frame.t)).toEqual(['start', 'delta', 'done'])
  broken.close()
})

it('keeps what the browser reports about a turn: that it was used, when it was heard, and what was opened', async () => {
  const amendTurn = vi.fn()
  const recordEvent = vi.fn()
  const session = createRealtimeSession({ sendText: vi.fn(), sendBinary: vi.fn() }, {
    auditFactory: { amendTurn, recordEvent } as never,
  })
  const now = Date.now()
  await session.handleMessage(JSON.stringify({ t: 'telemetry', id: 'turn-9', kind: 'committed', at: now, source: 'voice', speculation: 'hit' }))
  await session.handleMessage(JSON.stringify({
    t: 'telemetry', id: 'turn-9', kind: 'finished', at: now + 4000, interrupted: false, speculation: 'hit', savedMs: 412.6,
    marks: { speech_end: now - 300, first_token: now + 500, first_sample: now + 900, 'not a mark': 1, nested: { a: 1 } },
  }))
  await session.handleMessage(JSON.stringify({ t: 'telemetry', id: 'turn-9', kind: 'card', at: now + 5000, action: 'opened', card: 'card-1', artifactId: 'artifact-1' }))
  await session.handleMessage(JSON.stringify({ t: 'telemetry', id: 'turn-9', kind: 'card', action: 'DROP TABLE', card: 'card-1' }))
  expect(amendTurn.mock.calls).toEqual([
    ['turn-9', { committed: true, source: 'voice', speculation: 'hit', committedAt: now }],
    ['turn-9', { finishedAt: now + 4000, interrupted: false, speculation: 'hit', savedMs: 413, marks: { speech_end: now - 300, first_token: now + 500, first_sample: now + 900 } }],
  ])
  expect(recordEvent).toHaveBeenCalledExactlyOnceWith({ clientTurnId: 'turn-9', type: 'card_opened', at: now + 5000, payload: { card: 'card-1', artifactId: 'artifact-1' } })
  session.close()
})

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
