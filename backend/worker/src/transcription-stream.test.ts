import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ transcribe: vi.fn(), save: vi.fn() }))
vi.mock('../../../src/lib/agent-core', async (original) => ({
  ...await original<typeof import('../../../src/lib/agent-core')>(), transcribeAudio: state.transcribe,
}))
vi.mock('./accounts', async (original) => ({
  ...await original<typeof import('./accounts')>(), ownerOf: async () => 'user/stream-test',
}))
vi.mock('./audit', () => ({ createWorkerInteractionAudit: () => ({ recordSpeech: state.save }) }))
import { handleApi } from './api'
import type { Env } from './types'
const env = { GIDEON_AUDIT_REQUIRED: '1' } as Env
const transcript = { ok: true, text: 'all the words', model: 'primary', code: '', message: '', retryable: false }
const request = (caption = false) => new Request('http://localhost/api/transcribe', {
  method: 'POST', headers: { 'Content-Type': 'audio/wav', Accept: 'application/x-ndjson', ...(caption ? { 'X-Gideon-Purpose': 'caption' } : {}) },
  body: new Uint8Array([1, 2, 3]),
})
beforeEach(() => { state.transcribe.mockReset(); state.save.mockReset(); state.transcribe.mockResolvedValue(transcript) })
afterEach(() => vi.unstubAllEnvs())
const frame = async (reader: ReadableStreamDefaultReader<Uint8Array>) => JSON.parse(new TextDecoder().decode((await reader.read()).value))

it('completes with the words at once and hands the recording over for keeping', async () => {
  const response = (await handleApi(request(), env))!
  expect(response.headers.get('content-type')).toContain('application/x-ndjson')
  const reader = response.body!.getReader()
  expect(await frame(reader)).toEqual({ t: 'start' })
  expect(await frame(reader)).toEqual({ t: 'preview', text: 'all the words', model: 'primary' })
  expect(await frame(reader)).toEqual({ t: 'done', text: 'all the words', model: 'primary' })
  expect(state.save).toHaveBeenCalledOnce()
  expect(state.transcribe).toHaveBeenCalledOnce()
})

it('still completes when the recording cannot be kept', async () => {
  state.save.mockImplementation(() => { throw new Error('database unavailable') })
  const response = (await handleApi(request(), env))!
  const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  expect(frames.map(f => f.t)).toEqual(['start', 'preview', 'done'])
  expect(state.transcribe).toHaveBeenCalledOnce()
})

it('keeps caption requests as unrecorded JSON and never starts another transcription', async () => {
  const response = (await handleApi(request(true), env))!
  expect(await response.json()).toEqual({ text: 'all the words', model: 'primary' })
  expect(state.save).not.toHaveBeenCalled()
  expect(state.transcribe).toHaveBeenCalledOnce()
})

it('cancels upstream work when the browser closes the response stream', async () => {
  let signal!: AbortSignal
  state.transcribe.mockImplementation((_audio, upstream: AbortSignal) => {
    signal = upstream
    return new Promise((_resolve, reject) => upstream.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  })
  const response = (await handleApi(request(), env))!
  await response.body!.cancel()
  expect(signal.aborted).toBe(true)
  expect(state.transcribe).toHaveBeenCalledOnce()
})
