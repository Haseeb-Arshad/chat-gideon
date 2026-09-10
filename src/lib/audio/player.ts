/**
 * Speech playback on the audio clock.
 *
 * The reply arrives as a series of separately synthesised chunks, and the old
 * player handed each one to its own `HTMLAudioElement` as the previous ended.
 * That hands the timing to the main thread: the gap between chunks is however
 * long it took a `ended` event to dispatch, an element to be constructed and a
 * network-backed `play()` to begin. It is small, it is variable, and it is
 * audible — a sentence assembled that way has seams in it.
 *
 * Scheduling instead removes the main thread from the timing entirely. Each
 * buffer is queued against `AudioContext.currentTime`, which is a sample counter
 * on the audio thread, so chunk two begins on the sample after chunk one ends
 * whatever the page is doing. Caption progress and the level that drives the
 * eyes are then read from that same clock, so the words, the voice and the face
 * are all working from one timeline rather than three approximations of one.
 */

export interface PlayerHandlers {
  onSpeakingChange?: (speaking: boolean) => void
  /** 0–1 output amplitude, sampled from the graph. */
  onLevel?: (level: number) => void
  /** Characters of the reply the voice has reached. */
  onProgress?: (chars: number) => void
  onError?: (message: string) => void
}

interface Scheduled {
  source: AudioBufferSourceNode
  /** Context time this chunk begins. */
  startAt: number
  duration: number
  startChar: number
  chars: number
}

/** Long enough to absorb a decode, short enough not to be heard as latency. */
const SCHEDULE_LEAD = 0.06
/** A hard cut is a click; this is the shortest fade that is not one. */
const FADE_MS = 60
/**
 * Where the voice sits while a possible interruption is checked: low enough to
 * talk over, loud enough that nothing seems to have broken.
 */
const DUCK_LEVEL = 0.15
const DUCK_MS = 120
const RESTORE_MS = 260

export class ScheduledPlayer {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private samples: Uint8Array | null = null
  private readonly playing: Scheduled[] = []
  /** Context time the next chunk should begin. */
  private cursor = 0
  private frame = 0
  private speaking = false
  private stopped = false
  private levelValue = 0
  /** 1 normally; lower while an interruption is being checked. */
  private volume = 1

  constructor(private readonly handlers: PlayerHandlers = {}) {}

  get isSpeaking() {
    return this.speaking
  }

  /**
   * How far into the reply the voice has reached, in characters.
   *
   * Interpolated within the chunk that is currently sounding: chunk boundaries
   * are every few words, which would make the caption advance in visible jumps
   * if progress were only reported when one ended.
   */
  get spokenChars(): number {
    const context = this.context
    if (!context) return 0
    const now = context.currentTime
    let reached = 0
    for (const item of this.playing) {
      if (now >= item.startAt + item.duration) {
        reached = Math.max(reached, item.startChar + item.chars)
      } else if (now > item.startAt && item.duration > 0) {
        const ratio = (now - item.startAt) / item.duration
        reached = Math.max(reached, item.startChar + Math.round(ratio * item.chars))
      }
    }
    return reached
  }

  private ensureContext(): AudioContext | null {
    if (this.stopped) return null
    if (this.context) return this.context

    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null

    const context = new Ctor({ latencyHint: 'interactive' })
    const gain = context.createGain()
    gain.gain.value = this.volume
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    gain.connect(analyser)
    analyser.connect(context.destination)

    this.context = context
    this.gain = gain
    this.analyser = analyser
    this.samples = new Uint8Array(analyser.frequencyBinCount)
    return context
  }

  /**
   * Decodes one chunk and queues it directly after whatever is already queued.
   * Resolves when it has been scheduled, not when it has finished sounding.
   */
  async enqueue(audio: ArrayBuffer | Blob, startChar: number, chars: number): Promise<void> {
    if (this.stopped) return
    const context = this.ensureContext()
    if (!context) throw new Error('This browser cannot play audio.')

    // Autoplay policy suspends a context created before any gesture. Resuming
    // is cheap and a no-op when it is already running.
    if (context.state === 'suspended') await context.resume().catch(() => undefined)

    const bytes = audio instanceof Blob ? await audio.arrayBuffer() : audio
    // decodeAudioData detaches the buffer it is given, so a caller that still
    // holds a reference to these bytes keeps a usable copy.
    const buffer = await context.decodeAudioData(bytes.slice(0))
    if (this.stopped) return

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain!)

    // The lead only applies when the queue has run dry; a chunk arriving while
    // another is still sounding is butted straight onto the end of it.
    const startAt = Math.max(context.currentTime + SCHEDULE_LEAD, this.cursor)
    source.start(startAt)
    this.cursor = startAt + buffer.duration

    const item: Scheduled = {
      source,
      startAt,
      duration: buffer.duration,
      startChar,
      chars,
    }
    this.playing.push(item)

    source.onended = () => {
      const index = this.playing.indexOf(item)
      if (index >= 0) this.playing.splice(index, 1)
      if (!this.playing.length) this.setSpeaking(false)
    }

    this.setSpeaking(true)
    this.startMeter()
  }

  /** Resolves when everything queued has finished sounding. */
  async drain(): Promise<void> {
    while (!this.stopped && this.playing.length) {
      const context = this.context
      if (!context) return
      const remaining = this.cursor - context.currentTime
      if (remaining <= 0) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(120, remaining * 1000 + 20)))
    }
  }

  /**
   * Drops the voice to a whisper without stopping it, while something that
   * might be the user is checked. Queued chunks keep their place, so nothing
   * is lost if it turns out to have been a fan.
   */
  duck(level = DUCK_LEVEL) {
    this.rampTo(level, DUCK_MS)
  }

  /** Back to full voice, from wherever it has got to. */
  unduck() {
    this.rampTo(1, RESTORE_MS)
  }

  private rampTo(value: number, ms: number) {
    this.volume = value
    const context = this.context
    const gain = this.gain
    if (!context || !gain || this.stopped) return
    const now = context.currentTime
    try {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(value, now + ms / 1000)
    } catch {
      // A context that is closing cannot be ramped, and no longer matters.
    }
  }

  /**
   * Stops immediately but not abruptly.
   *
   * The ramp is the whole point: an interruption that ends in a click reads as
   * a bug, and one that fades over a syllable reads as GIDEON stopping himself.
   */
  stop() {
    if (this.stopped) return
    this.stopped = true

    const context = this.context
    const gain = this.gain
    if (context && gain) {
      const now = context.currentTime
      const fade = FADE_MS / 1000
      try {
        gain.gain.cancelScheduledValues(now)
        gain.gain.setValueAtTime(gain.gain.value, now)
        gain.gain.linearRampToValueAtTime(0.0001, now + fade)
      } catch {
        // A context that is already closing cannot be ramped; the stop below
        // still silences it.
      }
      for (const item of this.playing) {
        try {
          item.source.onended = null
          item.source.stop(now + fade)
        } catch {
          // Already stopped or never started.
        }
      }
      // Closing before the ramp finishes would cut it off, which is the click
      // the ramp exists to avoid.
      setTimeout(() => void context.close().catch(() => undefined), FADE_MS + 40)
    }

    this.playing.length = 0
    this.context = null
    this.gain = null
    this.analyser = null
    this.stopMeter()
    this.setSpeaking(false)
  }

  private startMeter() {
    if (this.frame) return
    const step = () => {
      const analyser = this.analyser
      const samples = this.samples
      if (!analyser || !samples || this.stopped) {
        this.frame = 0
        return
      }

      analyser.getByteTimeDomainData(samples as Uint8Array<ArrayBuffer>)
      let sum = 0
      for (let i = 0; i < samples.length; i += 1) {
        const centred = (samples[i] - 128) / 128
        sum += centred * centred
      }
      const rms = Math.sqrt(sum / samples.length)
      this.levelValue = Math.min(1, rms * 3.4)
      this.handlers.onLevel?.(this.levelValue)
      this.handlers.onProgress?.(this.spokenChars)

      this.frame = requestAnimationFrame(step)
    }
    this.frame = requestAnimationFrame(step)
  }

  private stopMeter() {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.levelValue = 0
    this.handlers.onLevel?.(0)
  }

  private setSpeaking(next: boolean) {
    if (this.speaking === next) return
    this.speaking = next
    this.handlers.onSpeakingChange?.(next)
    if (!next) this.stopMeter()
  }
}
