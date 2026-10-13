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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bounded transcription', () => {
  function abortableFetch() {
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })))
  }
  it('releases a hung final request after ten seconds without retrying audio', async () => {
    vi.useFakeTimers()
    abortableFetch()
    const onError = vi.fn()
    const transcriber = new Transcriber({ onError })
    const pending = transcriber.run(frames, 16_000, undefined, false)
    expect(transcriber.busy).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toBeNull()
    expect(transcriber.busy).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('too long'), true)
  })
  it('silently drops a slow caption after three seconds', async () => {
    vi.useFakeTimers()
    abortableFetch()
    const onError = vi.fn()
    const transcriber = new Transcriber({ onError })
    const pending = transcriber.run(frames, 16_000)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await pending).toBeNull()
    expect(onError).not.toHaveBeenCalled()
    expect(transcriber.busy).toBe(false)
  })
  it('drops a cancelled response even when the transport ignores abort', async () => {
    const replies = deferredFetch()
    const controller = new AbortController()
    const transcriber = new Transcriber()
    const pending = transcriber.run(frames, 16_000, controller.signal, false)
    controller.abort()
    replies[0]('stale')
    expect(await pending).toBeNull()
  })
  it('does not upload audio from an already cancelled session', async () => {
    deferredFetch()
    const controller = new AbortController()
    controller.abort()
    expect(await new Transcriber().run(frames, 16_000, controller.signal)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('streamed transcript delivery', () => {
  function streamed() {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } })))
    return {
      send: (frame: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`)),
      close: () => controller.close(),
    }
  }
  it('displays the preview but waits for saved completion before returning a transcript', async () => {
    const stream = streamed()
    const preview = vi.fn()
    let complete = false
    const pending = new Transcriber().run(frames, 16_000, undefined, false, preview).then(result => { complete = true; return result })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    stream.send({ t: 'preview', text: 'The words I said.' })
    await vi.waitFor(() => expect(preview).toHaveBeenCalledWith('The words I said.'))
    expect(complete).toBe(false)
    stream.send({ t: 'done', text: 'The words I said.', model: 'primary' })
    expect(await pending).toMatchObject({ text: 'The words I said.', model: 'primary' })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('does not commit a preview when audit persistence fails', async () => {
    const stream = streamed()
    const onError = vi.fn()
    const pending = new Transcriber({ onError }).run(frames, 16_000, undefined, false)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    stream.send({ t: 'preview', text: 'not saved' })
    stream.send({ t: 'error', error: { message: 'Recording could not be saved.', retryable: true } })
    expect(await pending).toBeNull()
    expect(onError).toHaveBeenCalledWith('Recording could not be saved.', true)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('rejects a truncated stream instead of treating provisional words as committed', async () => {
    const stream = streamed()
    const onError = vi.fn()
    const pending = new Transcriber({ onError }).run(frames, 16_000, undefined, false)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    stream.send({ t: 'preview', text: 'incomplete' })
    stream.close()
    expect(await pending).toBeNull()
    expect(onError).toHaveBeenCalledOnce()
  })
  it('ignores streamed previews and completion from an invalidated input', async () => {
    const stream = streamed()
    const controller = new AbortController()
    const preview = vi.fn()
    const pending = new Transcriber().run(frames, 16_000, controller.signal, false, preview)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    controller.abort()
    stream.send({ t: 'preview', text: 'stale' })
    expect(await pending).toBeNull()
    expect(preview).not.toHaveBeenCalled()
  })
})

describe('transcriber purpose', () => {
  it('uses the warm socket without sending a second HTTP transcription', async () => {
    deferredFetch()
    const preview = vi.fn()
    const request = vi.fn(async (_audio: ArrayBuffer, _signal: AbortSignal, _caption: boolean, show?: (text: string) => void) => {
      show?.('recognized'); return { text: 'recognized', model: 'primary' }
    })
    const result = await new Transcriber({ request }).run(frames, 16_000, undefined, false, preview)
    expect(result?.text).toBe('recognized')
    expect(preview).toHaveBeenCalledWith('recognized')
    expect(fetch).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })
  it('does not retry audio over HTTP after the socket has submitted it and failed', async () => {
    deferredFetch()
    const request = vi.fn().mockRejectedValue(new Error('socket lost'))
    expect(await new Transcriber({ request }).run(frames, 16_000, undefined, false)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })
  it('marks captions so the server can leave them unrecorded, and utterances not', async () => {
    deferredFetch()
    const transcriber = new Transcriber()
    void transcriber.run(frames, 16_000)
    void transcriber.run(frames, 16_000, undefined, false)
    const calls = vi.mocked(fetch).mock.calls
    expect((calls[0][1]?.headers as Record<string, string>)['X-Gideon-Purpose']).toBe('caption')
    expect((calls[1][1]?.headers as Record<string, string>)['X-Gideon-Purpose']).toBeUndefined()
  })
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
