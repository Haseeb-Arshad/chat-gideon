import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { transcribeAudio } from './agent-core'

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'fixture')
  vi.stubEnv('OPENROUTER_STT_MODEL', 'primary')
  vi.stubEnv('OPENROUTER_STT_FALLBACK_MODEL', 'fallback')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
const audio = new ArrayBuffer(44)

it.each([['en-US', 'en'], ['pt-BR', 'pt'], ['zh-Hant', 'zh'], ['en_US', 'en'], ['bad hint!', 'en']])('normalizes browser language %s to %s', async (hint, language) => {
  const request = vi.fn(async () => Response.json({ text: 'hello' }))
  vi.stubGlobal('fetch', request)
  await transcribeAudio(audio, new AbortController().signal, { language: hint })
  expect(JSON.parse((request.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string).language).toBe(language)
})

it('uses one provider attempt for a disposable caption', async () => {
  const request = vi.fn(async () => new Response('', { status: 503 }))
  vi.stubGlobal('fetch', request)
  expect((await transcribeAudio(audio, new AbortController().signal, { caption: true })).ok).toBe(false)
  expect(request).toHaveBeenCalledTimes(1)
})

it('retains one fallback for a finished utterance', async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ text: 'the whole sentence' }))
  vi.stubGlobal('fetch', request)
  expect(await transcribeAudio(audio, new AbortController().signal)).toMatchObject({ ok: true, model: 'fallback', text: 'the whole sentence' })
  expect(request).toHaveBeenCalledTimes(2)
})

it('bounds two hung providers to under six seconds instead of twenty-four', async () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  const request = vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }))
  vi.stubGlobal('fetch', request)
  const pending = transcribeAudio(audio, new AbortController().signal)
  // The second is asked once the first has been quiet for two seconds.
  await vi.advanceTimersByTimeAsync(2_000)
  expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(3_500)
  expect((await pending).ok).toBe(false)
  expect(request).toHaveBeenCalledTimes(2)
})

it('asks the fallback beside a slow first model and takes whichever answers first', async () => {
  vi.useFakeTimers()
  let primaryAborted = false
  const request = vi.fn((_url, init: RequestInit) => {
    const model = JSON.parse(init.body as string).model
    if (model === 'fallback') return Promise.resolve(Response.json({ text: 'from the fallback' }))
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { primaryAborted = true; reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    })
  })
  vi.stubGlobal('fetch', request)
  const pending = transcribeAudio(audio, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(1_999)
  expect(request).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toMatchObject({ ok: true, model: 'fallback', text: 'from the fallback' })
  expect(primaryAborted).toBe(true)
})

it('keeps a quick first answer without asking the fallback', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async () => Response.json({ text: 'quick' }))
  vi.stubGlobal('fetch', request)
  expect(await transcribeAudio(audio, new AbortController().signal)).toMatchObject({ ok: true, model: 'primary' })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(request).toHaveBeenCalledTimes(1)
})

it('does not fail over when the user cancels', async () => {
  const controller = new AbortController()
  const request = vi.fn(async () => {
    controller.abort()
    throw new DOMException('aborted', 'AbortError')
  })
  vi.stubGlobal('fetch', request)
  expect((await transcribeAudio(audio, controller.signal)).code).toBe('aborted')
  expect(request).toHaveBeenCalledTimes(1)
})
