/**
 * Turns a streaming reply into speech without making the screen wait for it.
 *
 * Two things matter for perceived speed:
 *
 * 1. The first spoken chunk is deliberately short. Waiting for a whole sentence
 *    before asking for audio meant the first sound landed a second or more late,
 *    so the opening chunk is cut at the first natural clause boundary instead.
 * 2. Audio for later chunks starts generating as soon as the previous provider
 *    response arrives, while earlier chunks are still playing. Requests to the
 *    free voice provider stay serialised because concurrent calls can sit in a
 *    long queue or time out; playback itself remains strictly ordered.
 *
 * The queue also reports playback amplitude, which drives the eyes, and how far
 * through the text the voice has reached, which drives the caption highlight.
 */

/** The opening chunk is cut aggressively so speech starts sooner. */
const FIRST_CHUNK_MAX = 96
const FIRST_CHUNK_MIN = 28
const CHUNK_MAX = 220
const CHUNK_MIN = 90
const MAX_INFLIGHT = 1

export interface SpeakableChunk {
  text: string
  /** Index in the fed text immediately after this chunk. */
  end: number
}

/**
 * Pulls complete speakable chunks off the front of a buffer.
 * `first` uses the tighter opening budget; `flush` releases the tail.
 */
export function splitSpeakable(
  value: string,
  options: { flush?: boolean; first?: boolean } = {},
): { chunks: SpeakableChunk[]; remainder: string; consumed: number } {
  const { flush = false, first = false } = options
  const chunks: SpeakableChunk[] = []
  let consumed = 0
  let opening = first

  const budget = () => (opening ? FIRST_CHUNK_MAX : CHUNK_MAX)
  const floor = () => (opening ? FIRST_CHUNK_MIN : CHUNK_MIN)

  const take = (upTo: number) => {
    const raw = value.slice(consumed, upTo)
    const text = raw.trim()
    consumed = upTo
    if (text) {
      chunks.push({ text, end: consumed })
      opening = false
    }
  }

  for (;;) {
    const rest = value.slice(consumed)
    if (!rest.trim()) break

    // A sentence ending inside the current budget is always the best cut.
    const sentence = /[.!?](?:["')\]]+)?(?=\s|$)/g
    sentence.lastIndex = 0
    let sentenceEnd = -1
    let match: RegExpExecArray | null
    while ((match = sentence.exec(rest))) {
      const end = match.index + match[0].length
      if (end <= budget()) sentenceEnd = end
      break
    }
    if (sentenceEnd > 0) {
      take(consumed + sentenceEnd)
      continue
    }

    if (rest.length <= budget()) break

    // No sentence in range: cut at the latest clause break, then whitespace.
    const window = rest.slice(0, budget())
    const clause = Math.max(
      window.lastIndexOf(', '),
      window.lastIndexOf('; '),
      window.lastIndexOf(': '),
      window.lastIndexOf(' — '),
    )
    const space = window.lastIndexOf(' ')
    const cut =
      clause >= floor() ? clause + 1 : space >= floor() ? space : budget()
    take(consumed + cut)
  }

  if (flush && value.slice(consumed).trim()) take(value.length)

  return { chunks, remainder: value.slice(consumed), consumed }
}

export interface VoiceQueueOptions {
  request: (seq: number, text: string, signal: AbortSignal) => Promise<Blob>
  onSpeakingChange?: (speaking: boolean) => void
  /** 0–1 playback amplitude, driven by the audio itself. */
  onLevel?: (level: number) => void
  /** How many characters of the reply the voice has reached. */
  onProgress?: (chars: number) => void
  onError?: (message: string) => void
}

interface QueueItem {
  seq: number
  text: string
  startChar: number
  audio: Promise<Blob>
}

export class VoiceQueue {
  private buffer = ''
  private base = 0
  private seq = 0
  private items: QueueItem[] = []
  private playIndex = 0
  private draining: Promise<void> | null = null
  private inflight = 0
  private waiting: Array<() => void> = []
  private controller = new AbortController()
  private element: HTMLAudioElement | null = null
  private objectUrl: string | null = null
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private frame = 0
  private speaking = false
  private failed = false

  constructor(private readonly options: VoiceQueueOptions) {}

  get signal() {
    return this.controller.signal
  }

  get hadError() {
    return this.failed
  }

  get queued() {
    return this.seq > 0
  }

  /** Feeds newly streamed reply text; complete chunks are dispatched at once. */
  feed(text: string) {
    if (this.controller.signal.aborted) return
    this.buffer += text
    this.drainBuffer(false)
  }

  /** Marks the reply complete so the tail is spoken too. */
  finish() {
    if (this.controller.signal.aborted) return
    this.drainBuffer(true)
  }

  /**
   * Resolves once every queued chunk has played (or failed). The loop matters:
   * a drain that finishes while later chunks are still arriving immediately
   * starts another one, and awaiting only the first would return too early.
   */
  async idle() {
    while (this.draining) await this.draining
  }

  cancel() {
    if (this.controller.signal.aborted) return
    this.controller.abort()
    this.stopMeter()
    this.releaseElement()
    this.setSpeaking(false)
    for (const release of this.waiting.splice(0)) release()
  }

  private drainBuffer(flush: boolean) {
    const { chunks, remainder } = splitSpeakable(this.buffer, {
      flush,
      first: this.seq === 0,
    })
    if (!chunks.length) {
      if (flush) this.buffer = remainder
      return
    }

    let cursor = 0
    for (const chunk of chunks) {
      this.enqueue(chunk.text, this.base + cursor)
      cursor = chunk.end
    }
    this.base += cursor
    this.buffer = remainder
  }

  private enqueue(text: string, startChar: number) {
    const seq = this.seq++
    const item: QueueItem = {
      seq,
      text,
      startChar,
      audio: this.generate(seq, text),
    }
    this.items.push(item)
    this.startDraining()
  }

  /** Generation runs ahead of playback without overloading the voice provider. */
  private async generate(seq: number, text: string): Promise<Blob> {
    await this.acquire()
    try {
      if (this.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return await this.options.request(seq, text, this.controller.signal)
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.inflight < MAX_INFLIGHT) {
      this.inflight += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.inflight += 1
        resolve()
      })
    })
  }

  private release() {
    this.inflight -= 1
    const next = this.waiting.shift()
    if (next) next()
  }

  private startDraining() {
    if (this.draining) return
    this.draining = this.drainQueue().finally(() => {
      this.draining = null
      // Chunks that arrived while the last one was finishing.
      if (this.playIndex < this.items.length && !this.controller.signal.aborted) {
        this.startDraining()
      } else {
        this.setSpeaking(false)
      }
    })
  }

  private async drainQueue() {
    while (this.playIndex < this.items.length) {
      if (this.controller.signal.aborted) return
      const item = this.items[this.playIndex]
      this.playIndex += 1

      let blob: Blob
      try {
        blob = await item.audio
      } catch (error) {
        if ((error as Error).name === 'AbortError') return
        if (!this.failed) {
          this.failed = true
          this.options.onError?.(
            error instanceof Error ? error.message : 'The voice could not be generated.',
          )
        }
        continue
      }

      if (this.controller.signal.aborted) return
      await this.play(item, blob)
    }
  }

  private play(item: QueueItem, blob: Blob) {
    return new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.preload = 'auto'
      this.element = audio
      this.objectUrl = url

      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        this.controller.signal.removeEventListener('abort', done)
        this.stopMeter()
        this.options.onProgress?.(item.startChar + item.text.length)
        this.releaseElement()
        resolve()
      }

      this.controller.signal.addEventListener('abort', done, { once: true })

      audio.onplaying = () => {
        this.setSpeaking(true)
        const firstWordEnd = item.text.search(/\s/)
        const initialProgress =
          firstWordEnd > 0
            ? Math.min(item.text.length, firstWordEnd + 1)
            : Math.min(item.text.length, 1)
        this.options.onProgress?.(item.startChar + initialProgress)
        this.attachMeter(audio)
        this.trackProgress(audio, item)
      }
      audio.onended = done
      audio.onerror = () => {
        if (!this.failed) {
          this.failed = true
          this.options.onError?.('That line could not be played aloud.')
        }
        done()
      }

      void audio.play().catch(() => {
        if (!this.failed) {
          this.failed = true
          this.options.onError?.('Autoplay is blocked. Tap anywhere, then try again.')
        }
        done()
      })
    })
  }

  private trackProgress(audio: HTMLAudioElement, item: QueueItem) {
    const step = () => {
      if (this.element !== audio) return
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      if (duration) {
        const ratio = Math.min(1, audio.currentTime / duration)
        this.options.onProgress?.(item.startChar + Math.round(ratio * item.text.length))
      }
      this.frame = requestAnimationFrame(step)
    }
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(step)
  }

  /** Web Audio taps the element so the eyes can move with the actual voice. */
  private attachMeter(audio: HTMLAudioElement) {
    if (!this.options.onLevel) return
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) {
        this.simulateLevel(audio)
        return
      }
      this.context ??= new Ctor()
      void this.context.resume().catch(() => undefined)

      // Routing through Web Audio replaces the element's own output, so this is
      // only safe once the context is actually running. A suspended context
      // would silence the reply outright.
      if (this.context.state !== 'running') {
        this.simulateLevel(audio)
        return
      }

      const source = this.context.createMediaElementSource(audio)
      const analyser = this.context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.72
      source.connect(analyser)
      analyser.connect(this.context.destination)
      this.analyser = analyser

      const data = new Uint8Array(analyser.frequencyBinCount)
      const sample = () => {
        if (this.analyser !== analyser) return
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let index = 0; index < data.length; index += 1) {
          const centered = (data[index] - 128) / 128
          sum += centered * centered
        }
        const rms = Math.sqrt(sum / data.length)
        this.options.onLevel?.(Math.min(1, rms * 3.4))
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    } catch {
      this.analyser = null
      this.simulateLevel(audio)
    }
  }

  /**
   * When the real amplitude is unavailable, the eyes still need something to
   * move with, so a soft speech-shaped rhythm stands in for it.
   */
  private simulateLevel(audio: HTMLAudioElement) {
    const started = performance.now()
    const tick = () => {
      if (this.element !== audio || audio.paused) return
      const t = (performance.now() - started) / 1000
      const wave =
        0.34 +
        0.22 * Math.sin(t * 11.3) +
        0.14 * Math.sin(t * 4.1 + 1.7) +
        0.1 * Math.sin(t * 19.7 + 0.4)
      this.options.onLevel?.(Math.max(0.05, Math.min(1, wave)))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  private stopMeter() {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.analyser = null
    this.options.onLevel?.(0)
  }

  private releaseElement() {
    if (this.element) {
      this.element.onplaying = null
      this.element.onended = null
      this.element.onerror = null
      this.element.pause()
      this.element = null
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
  }

  private setSpeaking(next: boolean) {
    if (this.speaking === next) return
    this.speaking = next
    this.options.onSpeakingChange?.(next)
  }
}
