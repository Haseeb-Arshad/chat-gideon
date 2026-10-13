/**
 * The browser half of speech recognition.
 *
 * One job, and one rule about it: only the newest request matters. A partial
 * transcript that lands after a later one has already been shown would make the
 * caption jump backwards, so every request carries a sequence number and
 * anything stale is dropped on arrival rather than raced.
 */

import { utteranceToWav } from './wav'
import { backendHeaders, backendUrl } from '../backend'

export interface TranscriptResult {
  text: string
  /** Which model answered, for the latency panel. */
  model: string
  /** Round trip in milliseconds. */
  ms: number
}

export interface TranscriberOptions {
  /** BCP-47 hint. Improves accuracy and rules out a wrong-language guess. */
  language?: string
  onError?: (message: string, retryable: boolean) => void
  /** undefined means no socket request was sent, so HTTP may handle it once. */
  request?: (audio: ArrayBuffer, signal: AbortSignal, caption: boolean, preview?: (text: string) => void) => Promise<{ text: string; model: string } | undefined>
}

export class Transcriber {
  private sequence = 0
  private latestShown = 0
  private inFlight = 0

  constructor(private readonly options: TranscriberOptions = {}) {}

  get busy() {
    return this.inFlight > 0
  }

  /**
   * Transcribes one buffer of audio.
   *
   * Resolves `null` when the answer is stale, superseded, or empty — all three
   * mean "nothing to show", and collapsing them here keeps the decision out of
   * the caller.
   *
   * @param ordered drops the answer when a newer ordered request has already
   * been shown. Only captions want that: a finished utterance's transcript is
   * the words themselves, and a later caption landing first must not discard it.
   */
  async run(
    frames: Float32Array[],
    sampleRate: number,
    signal?: AbortSignal,
    ordered = true,
    preview?: (text: string) => void,
  ): Promise<TranscriptResult | null> {
    if (!frames.length || signal?.aborted) return null

    const seq = ++this.sequence
    const started = performance.now()
    this.inFlight += 1
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), ordered ? 3_000 : 10_000)
    const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal

    try {
      const wav = utteranceToWav(frames, sampleRate)
      const socketResult = this.options.request ? await this.options.request(wav, requestSignal, ordered, preview) : undefined
      if (this.options.request && requestSignal.aborted) return null
      if (socketResult) {
        if (ordered && seq < this.latestShown) return null
        if (ordered) this.latestShown = seq
        const text = socketResult.text.trim()
        return text ? { text, model: socketResult.model, ms: Math.round(performance.now() - started) } : null
      }
      const response = await fetch(backendUrl('/api/transcribe'), {
        method: 'POST',
        headers: {
          ...backendHeaders('audio/wav'),
          ...(this.options.language ? { 'X-Gideon-Language': this.options.language } : {}),
          // A caption is a throwaway read of audio that is still being spoken;
          // the server has no reason to keep it, only the utterance that follows.
          ...(ordered ? { 'X-Gideon-Purpose': 'caption' } : {}),
          ...(!ordered ? { Accept: 'application/x-ndjson' } : {}),
        },
        body: wav,
        signal: requestSignal,
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string; retryable?: boolean }
        } | null
        if (!ordered) this.options.onError?.(
          body?.error?.message ?? 'Speech could not be transcribed.',
          Boolean(body?.error?.retryable),
        )
        return null
      }

      let body: { text?: string; model?: string }
      if (response.headers.get('content-type')?.includes('application/x-ndjson') && response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let committed: typeof body | null = null
        try {
          while (!committed) {
            const chunk = await reader.read()
            buffer += decoder.decode(chunk.value, { stream: !chunk.done })
            if (buffer.length > 256_000) throw new Error('Transcript exceeds the stream limit')
            let end: number
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
              if (!line.trim()) continue
              const frame = JSON.parse(line) as { t: string; text?: string; model?: string; error?: { message?: string; retryable?: boolean } }
              if (requestSignal.aborted) return null
              if (frame.t === 'preview' && typeof frame.text === 'string') preview?.(frame.text.trim())
              if (frame.t === 'error') {
                this.options.onError?.(frame.error?.message ?? 'Speech could not be transcribed.', Boolean(frame.error?.retryable))
                return null
              }
              if (frame.t === 'done') { committed = frame; break }
            }
            if (chunk.done) break
          }
          if (!committed) throw new Error('Transcript stream ended before it was saved')
          body = committed
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      } else body = (await response.json()) as typeof body
      if (requestSignal.aborted) return null
      // A slower earlier request finishing last must not overwrite a newer
      // transcript that is already on screen.
      if (ordered) {
        if (seq < this.latestShown) return null
        this.latestShown = seq
      }

      const text = (body.text ?? '').trim()
      if (!text) return null
      return { text, model: body.model ?? '', ms: Math.round(performance.now() - started) }
    } catch (error) {
      if (deadline.signal.aborted && !signal?.aborted && !ordered) {
        this.options.onError?.('Speech recognition took too long. Please try again.', true)
      }
      if ((error as Error).name === 'AbortError') return null
      if (!ordered) this.options.onError?.('Speech recognition could not be reached.', true)
      return null
    } finally {
      clearTimeout(timer)
      this.inFlight -= 1
    }
  }

  /** Forget ordering state between utterances. */
  reset() {
    this.latestShown = 0
  }
}
