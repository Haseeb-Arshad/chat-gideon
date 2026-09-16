/** Async input work belongs to one utterance/session, never merely a UI phase. */
export class InputGeneration {
  private generation = 0
  private requests = new Set<AbortController>()

  invalidate() {
    this.generation += 1
    for (const controller of this.requests) controller.abort()
    this.requests.clear()
  }

  request() {
    const generation = this.generation
    const controller = new AbortController()
    this.requests.add(controller)
    return {
      controller,
      signal: controller.signal,
      isCurrent: () => generation === this.generation && !controller.signal.aborted,
      finish: () => { this.requests.delete(controller) },
    }
  }
}

/** Publish only visible word boundaries, not every audio-clock tick. */
export function playbackCaption(text: string, chars: number): string {
  const visible = text.slice(0, Math.max(0, Math.min(chars, text.length)))
  const boundary = visible.search(/\s+\S*$/)
  return visible.length < text.length && !/\s$/.test(visible)
    ? boundary > 0 ? visible.slice(0, boundary) : ''
    : visible.trimEnd()
}

export interface TranscriptSegment {
  frames: Float32Array[]
  sampleRate: number
  ms: number
  continued?: boolean
}

interface SegmentToken {
  signal: AbortSignal
  isCurrent: () => boolean
  finish: () => void
}

/** Serialize bounded audio segments; only the final segment submits a turn. */
export class SegmentAccumulator {
  private pending = Promise.resolve()
  private revision = 0
  private text = ''

  constructor(
    private readonly transcribe: (segment: TranscriptSegment, token: SegmentToken) => Promise<{ text: string } | null>,
    private readonly hooks: {
      token: () => SegmentToken
      onPartial: (text: string) => void
      onFinal: (text: string) => void
    },
  ) {}

  push(segment: TranscriptSegment, eager?: Promise<{ text: string } | null>) {
    const revision = this.revision
    const token = this.hooks.token()
    const current = () => revision === this.revision && token.isCurrent()
    this.pending = this.pending.then(async () => {
      try {
        if (!current()) return
        let piece = ''
        if (eager) {
          // The eager attempt, when there is one, already transcribed this
          // exact audio the moment silence began.
          piece = (await eager.then((result) => result?.text?.trim() ?? '').catch(() => '')) ?? ''
          if (!current()) return
        }
        if (!piece) piece = (await this.transcribe(segment, token))?.text?.trim() ?? ''
        if (!current()) return
        if (piece) this.text = [this.text, piece].filter(Boolean).join(' ')
        if (segment.continued) {
          this.hooks.onPartial(this.text)
        } else {
          const text = this.text
          this.text = ''
          this.hooks.onFinal(text)
        }
      } catch {
        // The transcriber reports network errors; cancellation is silent.
      } finally {
        token.finish()
      }
    })
    return this.pending
  }

  clear() {
    this.revision += 1
    this.text = ''
    // A transport ignoring abort must not block a new utterance's work.
    this.pending = Promise.resolve()
  }
}

export function isComposingKey(event: { isComposing?: boolean; keyCode?: number }) {
  // Safari may end composition just before dispatching the confirming Enter.
  return event.isComposing || event.keyCode === 229
}
