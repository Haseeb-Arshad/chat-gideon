import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchVoice } from './agent-core'

/**
 * The regression that took the server down.
 *
 * Barge-in cancels every voice chunk still in flight. Reading a response body
 * is a second cancellable operation on the same signal, and when it was left
 * outside the guard its rejection escaped a void-discarded call and became an
 * unhandled rejection — which ends the Node process, and with it every other
 * connected session. These tests pin the shape that must never come back:
 * `fetchVoice` reports failure, and never rejects.
 */

const original = globalThis.fetch

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
})

afterEach(() => {
  globalThis.fetch = original
  vi.unstubAllEnvs()
  delete process.env.OPENROUTER_API_KEY
})

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError')
}

describe('fetchVoice', () => {
  it('honors a Fish request override independently of the Microsoft server default', async () => {
    vi.stubEnv('OPENROUTER_VOICE_MODEL', 'microsoft/mai-voice-2.1-flash')
    vi.stubEnv('OPENROUTER_VOICE', 'en-US-Harper:MAI-Voice-2.1-Flash')
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3])))
    globalThis.fetch = request as unknown as typeof fetch
    await fetchVoice('Hello there.', new AbortController().signal, {
      model: 'fish-audio/s2.1-pro', voice: '933563129e564b19a115bedd57b7406a',
    })
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toMatchObject({
      model: 'fish-audio/s2.1-pro', voice: '933563129e564b19a115bedd57b7406a',
    })
  })

  it('sends Microsoft the spoken text without Fish delivery cues', async () => {
    vi.stubEnv('OPENROUTER_VOICE_MODEL', 'microsoft/mai-voice-2.1-flash')
    vi.stubEnv('OPENROUTER_VOICE', 'en-US-Harper:MAI-Voice-2.1-Flash')
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'audio/mpeg' },
    }))
    globalThis.fetch = request as unknown as typeof fetch
    expect((await fetchVoice('Hello there.', new AbortController().signal)).ok).toBe(true)
    const body = JSON.parse(request.mock.calls[0][1]?.body as string)
    expect(body).toEqual({
      model: 'microsoft/mai-voice-2.1-flash',
      input: 'Hello there.',
      voice: 'en-US-Harper:MAI-Voice-2.1-Flash',
      response_format: 'mp3',
    })
  })

  it('retains delivery cues when explicitly configured for Fish', async () => {
    vi.stubEnv('OPENROUTER_VOICE_MODEL', 'fish-audio/s2.1-pro')
    vi.stubEnv('OPENROUTER_VOICE', '933563129e564b19a115bedd57b7406a')
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3])))
    globalThis.fetch = request as unknown as typeof fetch
    await fetchVoice('Hello there.', new AbortController().signal)
    const body = JSON.parse(request.mock.calls[0][1]?.body as string)
    expect(body.input).toBe('(warm natural adult woman, conversational, clear, intimate, relaxed pace) Hello there.')
    expect(body.voice).toBe('933563129e564b19a115bedd57b7406a')
  })

  it('reports a cancellation instead of rejecting when the body read aborts', async () => {
    // Headers arrive, then the caller cancels mid-download. This is precisely
    // what an interruption does to the chunk currently being fetched.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: {},
      headers: new Headers({ 'Content-Type': 'audio/mpeg' }),
      arrayBuffer: () => Promise.reject(abortError()),
    })) as unknown as typeof fetch

    const result = await fetchVoice('hello', new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('aborted')
  })

  it('reports a truncated body rather than rejecting', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: {},
      headers: new Headers({ 'Content-Type': 'audio/mpeg' }),
      arrayBuffer: () => Promise.reject(new TypeError('terminated')),
    })) as unknown as typeof fetch

    const result = await fetchVoice('hello', new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('voice_truncated')
    expect(result.retryable).toBe(true)
  })

  it('returns the audio when the body arrives intact', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: {},
      headers: new Headers({ 'Content-Type': 'audio/mpeg' }),
      arrayBuffer: () => Promise.resolve(bytes),
    })) as unknown as typeof fetch

    const result = await fetchVoice('hello', new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(result.body?.byteLength).toBe(3)
    expect(result.mime).toBe('audio/mpeg')
  })

  it('reports a cancellation from the request itself', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(abortError())) as unknown as typeof fetch
    expect((await fetchVoice('hello', new AbortController().signal)).code).toBe('aborted')
  })

  it('refuses without a key rather than calling out', async () => {
    delete process.env.OPENROUTER_API_KEY
    const called = vi.fn()
    globalThis.fetch = called as unknown as typeof fetch
    expect((await fetchVoice('hello', new AbortController().signal)).code).toBe('missing_api_key')
    expect(called).not.toHaveBeenCalled()
  })
})
