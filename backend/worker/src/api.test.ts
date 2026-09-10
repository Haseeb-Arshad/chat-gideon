import { describe, expect, it } from 'vitest'
import { handleApi } from './api'
import type { Env } from './types'

const env = {} as Env

describe('Cloudflare Worker API adapter', () => {
  it('keeps the existing validation contract for chat', async () => {
    const request = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })

    const response = await handleApi(request, env)

    expect(response?.status).toBe(400)
    expect(await response?.json()).toEqual({
      error: {
        code: 'empty_conversation',
        message: 'Write or say something to begin.',
        retryable: false,
      },
    })
  })

  it('consumes an empty audio body without calling the provider', async () => {
    const request = new Request('http://localhost/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
    })

    const response = await handleApi(request, env)

    expect(response?.status).toBe(400)
    expect(await response?.json()).toEqual({
      error: {
        code: 'empty_audio',
        message: 'There was no audio to transcribe.',
        retryable: false,
      },
    })
  })
})

