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
   */
  async run(
    frames: Float32Array[],
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<TranscriptResult | null> {
    if (!frames.length) return null

    const seq = ++this.sequence
    const started = performance.now()
    this.inFlight += 1

    try {
      const wav = utteranceToWav(frames, sampleRate)
      const response = await fetch(backendUrl('/api/transcribe'), {
        method: 'POST',
        headers: {
          ...backendHeaders('audio/wav'),
          ...(this.options.language ? { 'X-Gideon-Language': this.options.language } : {}),
        },
        body: wav,
        signal,
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string; retryable?: boolean }
        } | null
        this.options.onError?.(
          body?.error?.message ?? 'Speech could not be transcribed.',
          Boolean(body?.error?.retryable),
        )
        return null
      }

      const body = (await response.json()) as { text?: string; model?: string }
      // A slower earlier request finishing last must not overwrite a newer
      // transcript that is already on screen.
      if (seq < this.latestShown) return null
      this.latestShown = seq

      const text = (body.text ?? '').trim()
      if (!text) return null
      return { text, model: body.model ?? '', ms: Math.round(performance.now() - started) }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return null
      this.options.onError?.('Speech recognition could not be reached.', true)
      return null
    } finally {
      this.inFlight -= 1
    }
  }

  /** Forget ordering state between utterances. */
  reset() {
    this.latestShown = 0
  }
}
