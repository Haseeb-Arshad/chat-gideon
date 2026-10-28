import { afterEach, expect, it, vi } from 'vitest'
import type { ServerFrame } from './protocol'
import type { InteractionAuditFactory } from './interaction-audit'
const fixtures = vi.hoisted(() => ({ transcribe: vi.fn() }))
vi.mock('./agent-core', () => ({ availableTools: () => [], fetchVoice: vi.fn(), streamTurn: vi.fn(), getPublicConfig: () => ({}), warmUpstream: vi.fn(), warmProviders: vi.fn(), transcribeAudio: fixtures.transcribe }))
import { createRealtimeSession } from './realtime-session'
afterEach(() => vi.clearAllMocks())
const frame = (extra = {}) => JSON.stringify({ t: 'transcribe', id: 'stt-test', audio: btoa('RIFFfixture-audio'), ...extra })
function setup(auditFactory?: InteractionAuditFactory) {
  const frames: ServerFrame[] = []
  const session = createRealtimeSession({ sendText: data => frames.push(JSON.parse(data)), sendBinary: vi.fn() }, { auditFactory })
  fixtures.transcribe.mockResolvedValue({ ok: true, text: 'What is the weather?', model: 'primary' })
  return { session, frames }
}
it('advertises socket transcription without requiring a new protocol from old clients', async () => {
  const { session, frames } = setup()
  await session.handleMessage(JSON.stringify({ t: 'hello', version: 4 }))
  expect(frames.at(-1)).toMatchObject({ t: 'ready', transcriptionSocket: true })
})
it('returns the words the moment they are known and keeps the recording behind them', async () => {
  // Already sent by the time the recording is handed over: nothing about keeping it can hold the words.
  let sentBeforeRecording: ServerFrame[] = []
  const recordSpeech = vi.fn((_input: unknown) => { sentBeforeRecording = [...frames]; return 'segment' })
  const { session, frames } = setup({ recordSpeech } as unknown as InteractionAuditFactory)
  const at = Date.now() - 250
  await session.handleMessage(frame({ language: 'en-US', at }))
  expect(frames).toEqual([{ t: 'transcript', id: 'stt-test', text: 'What is the weather?', model: 'primary' }])
  expect(sentBeforeRecording).toEqual(frames)
  expect(fixtures.transcribe).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.any(AbortSignal), { language: 'en-US', caption: false })
  expect(recordSpeech).toHaveBeenCalledOnce()
  expect(recordSpeech.mock.calls[0][0]).toMatchObject({
    source: 'user', mime: 'audio/wav', text: 'What is the weather?', endedAt: at,
    metadata: { transcriptionId: 'stt-test', transcriptionModel: 'primary', language: 'en-US' },
  })
  expect(fixtures.transcribe).toHaveBeenCalledOnce()
})
it('does not believe a browser clock that is far from its own', async () => {
  const recordSpeech = vi.fn((_input: unknown) => 'segment')
  const { session } = setup({ recordSpeech } as unknown as InteractionAuditFactory)
  const before = Date.now()
  await session.handleMessage(frame({ at: 86_400_000 }))
  const endedAt = (recordSpeech.mock.calls[0][0] as { endedAt: number }).endedAt
  expect(endedAt).toBeGreaterThanOrEqual(before)
  expect(endedAt).toBeLessThanOrEqual(Date.now())
})
it('keeps disposable captions out of audit persistence', async () => {
  const recordSpeech = vi.fn()
  const { session, frames } = setup({ recordSpeech } as unknown as InteractionAuditFactory)
  await session.handleMessage(frame({ caption: true }))
  expect(recordSpeech).not.toHaveBeenCalled()
  expect(frames).toHaveLength(1)
  expect(frames[0].t).toBe('transcript')
})
it('still returns the words when keeping the recording fails', async () => {
  const { session, frames } = setup({ recordSpeech: vi.fn(() => { throw new Error('database') }) } as unknown as InteractionAuditFactory)
  await session.handleMessage(frame())
  expect(frames).toEqual([{ t: 'transcript', id: 'stt-test', text: 'What is the weather?', model: 'primary' }])
})
it('keeps a recording whose recognition failed, and still reports the failure', async () => {
  const recordSpeech = vi.fn((_input: unknown) => 'segment')
  const { session, frames } = setup({ recordSpeech } as unknown as InteractionAuditFactory)
  fixtures.transcribe.mockResolvedValue({ ok: false, text: '', code: 'stt_unreachable', message: 'Unreachable.', retryable: true, model: '' })
  await session.handleMessage(frame())
  expect(frames).toEqual([{ t: 'error', id: 'stt-test', code: 'stt_unreachable', message: 'Unreachable.', retryable: true }])
  expect(recordSpeech.mock.calls[0][0]).toMatchObject({ source: 'user', metadata: { transcriptionFailed: 'stt_unreachable' } })
  expect(recordSpeech.mock.calls[0][0]).not.toHaveProperty('text')
})
it('cancels recognition without leaking a late result or making another request', async () => {
  const { session, frames } = setup()
  let finish!: (value: unknown) => void
  fixtures.transcribe.mockImplementation((_audio, signal) => new Promise(resolve => { finish = resolve; expect(signal.aborted).toBe(false) }))
  const pending = session.handleMessage(frame())
  await session.handleMessage(JSON.stringify({ t: 'cancel', id: 'stt-test' }))
  expect(fixtures.transcribe.mock.calls[0][1].aborted).toBe(true)
  finish({ ok: true, text: 'late', model: 'primary' }); await pending
  expect(frames).toEqual([])
  expect(fixtures.transcribe).toHaveBeenCalledOnce()
})
it.each([{ audio: '!' }, { audio: 'x'.repeat(1_365_337) }, { caption: 'true' }])('rejects invalid or oversized frames before calling a provider: %s', async extra => {
  const { session, frames } = setup()
  await session.handleMessage(frame(extra))
  expect(fixtures.transcribe).not.toHaveBeenCalled()
  expect(frames.at(-1)).toMatchObject({ t: 'error', code: 'invalid_audio' })
})
