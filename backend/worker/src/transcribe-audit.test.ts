import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordSpeech = vi.fn()
const transcribeAudio = vi.fn()

vi.mock('./audit', () => ({
  createWorkerInteractionAudit: vi.fn(() => ({ recordSpeech })),
}))
vi.mock('./accounts', async (original) => ({
  ...(await original<typeof import('./accounts')>()),
  ownerOf: vi.fn(async () => 'owner-1'),
}))
vi.mock('../../../src/lib/agent-core', async (original) => ({
  ...(await original<typeof import('../../../src/lib/agent-core')>()),
  transcribeAudio,
}))

const { handleApi } = await import('./api')
type Env = import('./types').Env

const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as unknown as Env
const wav = Uint8Array.from([82, 73, 70, 70, 8, 0, 0, 0])

function upload(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav', 'X-Gideon-Language': 'en', ...headers },
    body: wav,
  })
}

beforeEach(() => {
  recordSpeech.mockReset().mockReturnValue('segment-1')
  transcribeAudio.mockReset().mockResolvedValue({ ok: true, text: 'hello there', model: 'stt-1' })
})

describe('transcription and the audit trail', () => {
  it('does not record a caption, so it is not held up behind the database', async () => {
    const response = await handleApi(upload({ 'X-Gideon-Purpose': 'caption' }), env)
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ text: 'hello there', model: 'stt-1' })
    expect(recordSpeech).not.toHaveBeenCalled()
  })

  it('records an utterance once, with its transcript, after transcribing it', async () => {
    const order: string[] = []
    transcribeAudio.mockImplementation(async () => { order.push('transcribe'); return { ok: true, text: 'book a table', model: 'stt-1' } })
    recordSpeech.mockImplementation(() => { order.push('record'); return 'segment-1' })

    const response = await handleApi(upload(), env)

    expect(response?.status).toBe(200)
    expect(order).toEqual(['transcribe', 'record'])
    expect(recordSpeech).toHaveBeenCalledTimes(1)
    expect(recordSpeech.mock.calls[0][0]).toMatchObject({
      source: 'user',
      text: 'book a table',
      endedAt: expect.any(Number),
      metadata: { language: 'en', transcriptionModel: 'stt-1', recognitionMs: expect.any(Number) },
    })
  })

  it('keeps a recording whose transcription failed, and still reports the failure', async () => {
    transcribeAudio.mockResolvedValue({ ok: false, code: 'upstream_failed', message: 'try again', retryable: true })

    const response = await handleApi(upload(), env)

    expect(response?.status).toBe(502)
    expect(recordSpeech.mock.calls[0][0]).toMatchObject({
      metadata: { transcriptionFailed: 'upstream_failed', retryable: true },
    })
    expect(recordSpeech.mock.calls[0][0]).not.toHaveProperty('text')
  })

  it('returns the transcript even when the recording cannot be kept', async () => {
    recordSpeech.mockImplementation(() => { throw new Error('database down') })

    const required = await handleApi(upload(), { ...env, GIDEON_AUDIT_REQUIRED: '1' } as Env)
    expect(required?.status).toBe(200)
    expect(await required?.json()).toEqual({ text: 'hello there', model: 'stt-1' })
  })
})
