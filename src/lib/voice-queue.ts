/**
 * Turns a streaming reply into speech without making the screen wait for it.
 *
 * Two things matter for perceived speed:
 *
 * 1. The first spoken chunk is deliberately short. Waiting for a whole sentence
 *    before asking for audio meant the first sound landed a second or more late,
 *    so the opening chunk is cut at the first natural clause boundary instead.
 * 2. Audio for later chunks is generated *while earlier chunks are still
 *    playing*, a few requests deep, then played strictly in order. Generation is
 *    no longer serialised behind playback.
 *
 * Playback itself is not this module's job any more. Chunks are handed to a
 * `ScheduledPlayer`, which queues them against the audio clock so the joins
 * between them are sample-accurate; this file only decides what to say next and
 * how far ahead to run.
 */

import { ScheduledPlayer } from './audio/player'

/** The opening chunk is cut aggressively so speech starts sooner. */
const FIRST_CHUNK_MAX = 96
const FIRST_CHUNK_MIN = 28
const CHUNK_MAX = 220
const CHUNK_MIN = 90
const MAX_INFLIGHT = 3

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
  /** The first chunk has been asked for. Used only for latency marks. */
  onFirstRequest?: () => void
  /** Its audio has arrived. */
  onFirstAudio?: () => void
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
  private failed = false
  private sawAudio = false
  private readonly player: ScheduledPlayer

  constructor(private readonly options: VoiceQueueOptions) {
    this.player = new ScheduledPlayer({
      onSpeakingChange: options.onSpeakingChange,
      onLevel: options.onLevel,
      onProgress: options.onProgress,
      onError: options.onError,
    })
  }

  get signal() {
    return this.controller.signal
  }

  get hadError() {
    return this.failed
  }

  get queued() {
    return this.seq > 0
  }

  get speaking() {
    return this.player.isSpeaking
  }

  /** How far through the reply the voice has actually reached. */
  get spokenChars() {
    return this.player.spokenChars
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
    if (!this.controller.signal.aborted) await this.player.drain()
  }

  cancel() {
    if (this.controller.signal.aborted) return
    this.controller.abort()
    this.player.stop()
    for (const release of this.waiting.splice(0)) release()
  }

  /** Lower the voice without losing the place, while an interruption is checked. */
  duck() {
    this.player.duck()
  }

  unduck() {
    this.player.unduck()
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
    if (seq === 0) this.options.onFirstRequest?.()
    const item: QueueItem = {
      seq,
      text,
      startChar,
      audio: this.generate(seq, text),
    }
    this.items.push(item)
    this.startDraining()
  }

  /** Generation runs ahead of playback, bounded by MAX_INFLIGHT. */
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
      // Chunks that arrived while the last one was being scheduled.
      if (this.playIndex < this.items.length && !this.controller.signal.aborted) {
        this.startDraining()
      }
    })
  }

  /**
   * Hands finished audio to the player strictly in sequence.
   *
   * The await is on the *audio* rather than on playback: the player schedules
   * each buffer directly after the one before it, so this loop can run as far
   * ahead as generation allows without the joins drifting.
   */
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
      if (!this.sawAudio) {
        this.sawAudio = true
        this.options.onFirstAudio?.()
      }

      try {
        await this.player.enqueue(blob, item.startChar, item.text.length)
      } catch (error) {
        if (this.controller.signal.aborted) return
        if (!this.failed) {
          this.failed = true
          this.options.onError?.(
            error instanceof Error && /decod/i.test(error.message)
              ? 'That line came back as audio I could not decode.'
              : 'That line could not be played aloud.',
          )
        }
      }
    }
  }
}
