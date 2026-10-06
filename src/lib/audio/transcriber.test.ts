import { afterEach, describe, expect, it, vi } from 'vitest'
import { Transcriber } from './transcriber'

const frames = [new Float32Array(160)]

function deferredFetch() {
  const replies: Array<(text: string) => void> = []
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
    replies.push((text) => resolve(new Response(JSON.stringify({ text, model: 'test' }), { status: 200 })))
  })))
  return replies
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('transcriber ordering', () => {
  it('drops a caption that lands after a newer one', async () => {
    const replies = deferredFetch()
    const transcriber = new Transcriber()
    const older = transcriber.run(frames, 16_000)
    const newer = transcriber.run(frames, 16_000)
    replies[1]('newer')
    expect((await newer)?.text).toBe('newer')
    replies[0]('older')
    expect(await older).toBeNull()
  })
  it('keeps an utterance transcript even when a newer caption landed first', async () => {
    const replies = deferredFetch()
    const transcriber = new Transcriber()
    const utterance = transcriber.run(frames, 16_000, undefined, false)
    const caption = transcriber.run(frames, 16_000)
    replies[1]('caption')
    await caption
    replies[0]('the words before the pause')
    expect((await utterance)?.text).toBe('the words before the pause')
  })
})
