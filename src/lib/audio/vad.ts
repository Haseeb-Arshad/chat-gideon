/**
 * Voice activity detection, and the endpointing decision built on top of it.
 *
 * The browser's Speech Recognition API already reports when it thinks you have
 * finished, but it decides that on its own schedule — generously, and without
 * telling anyone why. That single delay was the largest fixed cost in a turn.
 * Worse, it only answers the question "was that a complete utterance"; it
 * cannot answer "is someone talking right now", which is what barge-in needs
 * while GIDEON is the one making noise.
 *
 * So this decides both, from the audio itself, twenty milliseconds at a time.
 * It is deliberately a signal-processing problem rather than a model: the
 * features below run in a few microseconds per frame, need no download, and
 * work offline. `FrameFeatures` is the seam a neural detector would slot into
 * if one ever earns its weight.
 */

/** Everything the detector needs to know about 20 ms of microphone. */
export interface FrameFeatures {
  /** Root-mean-square amplitude, 0–1. */
  rms: number
  /** Zero crossings per sample, 0–1. High means fricatives, hiss or clicks. */
  zcr: number
  /**
   * Share of energy below roughly 1 kHz.
   *
   * Voiced speech puts most of its energy in the first formants; fans, hiss and
   * air conditioning are far flatter. This is the cheapest feature that
   * separates "a person" from "a room", and it costs one biquad.
   */
  lowRatio: number
}

export interface VadConfig {
  /** Frame duration in milliseconds. */
  frameMs: number
  /** Decibels above the noise floor before a frame counts as speech. */
  onsetDb: number
  /** Hysteresis: speech continues until it falls this far above the floor. */
  releaseDb: number
  /** Consecutive speech frames required before speech is declared. */
  onsetFrames: number
  /**
   * Silence tolerated inside one utterance before it is called finished.
   *
   * This is the single most consequential number in the file. Set too long and
   * every reply feels sluggish; set too short and it interrupts people
   * mid-thought, which is far worse. Conversational speech pauses for 300 to
   * 800 milliseconds between clauses and to breathe, so anything under about
   * half a second reliably cuts a sentence in half.
   */
  hangoverMs: number
  /** Utterances shorter than this are noise, not speech. */
  minSpeechMs: number
  /** Below this share of low-frequency energy, loudness is not a voice. */
  minLowRatio: number
  /** Above this zero-crossing rate the frame is hiss or a click, not a vowel. */
  maxZcr: number
  /** Absolute floor: below this RMS nothing is ever speech, however quiet the room. */
  silenceFloor: number
}

export const DEFAULT_VAD: VadConfig = {
  frameMs: 20,
  onsetDb: 9,
  releaseDb: 5,
  onsetFrames: 3,
  // Was 340, which sat inside the range of an ordinary pause for breath and so
  // ended sentences their speaker had not finished. The cost of the extra wait
  // is largely absorbed elsewhere: transcription now starts when silence
  // begins, so it runs during this window rather than after it.
  hangoverMs: 700,
  minSpeechMs: 140,
  minLowRatio: 0.32,
  maxZcr: 0.36,
  silenceFloor: 0.004,
}

export type VadState = 'silence' | 'onset' | 'speech' | 'trailing'

export interface VadEvent {
  /** Speech has just begun. */
  onSpeechStart?: boolean
  /** Speech has just ended and the utterance was long enough to keep. */
  onSpeechEnd?: boolean
  /** The utterance ended but was too short to be one; nothing was spoken. */
  onFalseStart?: boolean
}

export interface VadFrameResult extends VadEvent {
  state: VadState
  /** 0–1 confidence that this frame contains speech. */
  probability: number
  /** How far this frame sits above the tracked noise floor, in dB. */
  snrDb: number
  /** The current estimate of the room. */
  noiseFloor: number
  /** Milliseconds of speech in the utterance so far, hangover excluded. */
  speechMs: number
}

function toDb(ratio: number) {
  return 20 * Math.log10(Math.max(1e-6, ratio))
}

/**
 * Tracks the quiet level of the room.
 *
 * Asymmetric on purpose: it drops toward a new quiet almost immediately but
 * climbs toward a loud one over tens of seconds. A symmetric follower learns
 * the speaker's own voice as "the room" within a sentence or two and then goes
 * deaf to them, which is the classic way a naive energy detector fails.
 */
export class NoiseFloor {
  value: number

  constructor(initial = 0.01, private readonly fall = 0.35, private readonly rise = 0.0008) {
    this.value = initial
  }

  /** `speaking` freezes the estimate so a voice is never learned as silence. */
  update(rms: number, speaking: boolean): number {
    if (rms < this.value) {
      this.value += (rms - this.value) * this.fall
    } else if (!speaking) {
      this.value += (rms - this.value) * this.rise
    }
    this.value = Math.max(1e-5, this.value)
    return this.value
  }

  reset(value = 0.01) {
    this.value = value
  }
}

/**
 * Probability shaped from the three features rather than a hard threshold.
 *
 * The state machine below only needs a boolean, but barge-in wants a graded
 * answer: "somebody might be starting to talk" should be able to duck GIDEON's
 * voice slightly before it is confident enough to interrupt him outright.
 */
export function speechProbability(
  features: FrameFeatures,
  snrDb: number,
  config: VadConfig,
): number {
  if (features.rms < config.silenceFloor) return 0

  // A soft ramp across the onset threshold, rather than a step at it.
  const level = 1 / (1 + Math.exp(-(snrDb - config.onsetDb) * 0.55))
  // Tonality: full credit once the low band carries the frame, nothing when it
  // is broadband hiss at the same loudness.
  const tonal = Math.min(1, Math.max(0, (features.lowRatio - config.minLowRatio * 0.6)) / 0.3)
  // Very high zero-crossing frames are consonants at best and clicks at worst.
  const smooth = features.zcr > config.maxZcr ? 0.45 : 1

  return Math.min(1, level * (0.35 + 0.65 * tonal) * smooth)
}

/**
 * The endpointer.
 *
 * Feeding it frames returns, per frame, both a live speech probability and the
 * two edges anything downstream actually cares about: speech started, speech
 * finished. `speechEnd` fires after the hangover, which is what makes this
 * faster than waiting on a recogniser — the hangover is ours to tune and the
 * recogniser's is not.
 */
export class VoiceActivityDetector {
  private readonly config: VadConfig
  private readonly floor = new NoiseFloor()
  private state: VadState = 'silence'
  private onsetRun = 0
  private speechMs = 0
  private silenceMs = 0

  /**
   * Extra dB demanded before speech counts, raised while GIDEON is audible.
   *
   * The microphone hears the speakers. Acoustic echo cancellation removes most
   * of it and never all of it, so during playback the bar is lifted rather than
   * trusted flat — the residual is quiet, and a real interruption is not.
   */
  duckDb = 0

  /**
   * Overrides the configured hangover for the current utterance.
   *
   * Someone who has just said "and" is going to keep talking; someone who has
   * finished a sentence is not. The transcript knows which, so the caller can
   * lengthen the wait when the words trail off mid-clause and shorten it when
   * they land — patience where it is needed without paying for it every turn.
   */
  hangoverOverrideMs: number | null = null

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD, ...config }
  }

  get currentState() {
    return this.state
  }

  get noiseFloor() {
    return this.floor.value
  }

  reset() {
    this.state = 'silence'
    this.onsetRun = 0
    this.speechMs = 0
    this.silenceMs = 0
    this.hangoverOverrideMs = null
    this.floor.reset()
  }

  push(features: FrameFeatures): VadFrameResult {
    const { config } = this
    const speaking = this.state === 'speech' || this.state === 'onset'
    const floor = this.floor.update(features.rms, speaking)
    const snrDb = toDb(features.rms / floor)

    const probability = speechProbability(features, snrDb, config)
    // Hysteresis: it takes more to start speaking than to keep speaking, which
    // is what stops the state flapping on the quiet part of a word.
    const threshold = (speaking ? config.releaseDb : config.onsetDb) + this.duckDb
    const active =
      features.rms >= config.silenceFloor &&
      snrDb >= threshold &&
      features.lowRatio >= config.minLowRatio * (speaking ? 0.75 : 1)

    const result: VadFrameResult = {
      state: this.state,
      probability,
      snrDb,
      noiseFloor: floor,
      speechMs: this.speechMs,
    }

    switch (this.state) {
      case 'silence':
        if (active) {
          this.onsetRun = 1
          this.speechMs = config.frameMs
          this.state = 'onset'
        }
        break

      case 'onset':
        if (active) {
          this.onsetRun += 1
          this.speechMs += config.frameMs
          if (this.onsetRun >= config.onsetFrames) {
            this.state = 'speech'
            result.onSpeechStart = true
          }
        } else {
          // Not enough to be a word. Nothing downstream ever hears about it.
          this.state = 'silence'
          this.onsetRun = 0
          this.speechMs = 0
        }
        break

      case 'speech':
        if (active) {
          this.speechMs += config.frameMs
        } else {
          this.state = 'trailing'
          this.silenceMs = config.frameMs
        }
        break

      case 'trailing':
        if (active) {
          // The gap was a pause between words, not the end of the sentence, so
          // the hangover is spent and the utterance simply continues.
          this.state = 'speech'
          this.speechMs += this.silenceMs + config.frameMs
          this.silenceMs = 0
        } else {
          this.silenceMs += config.frameMs
          if (this.silenceMs >= (this.hangoverOverrideMs ?? config.hangoverMs)) {
            if (this.speechMs >= config.minSpeechMs) result.onSpeechEnd = true
            else result.onFalseStart = true
            this.state = 'silence'
            this.onsetRun = 0
            this.speechMs = 0
            this.silenceMs = 0
          }
        }
        break
    }

    result.state = this.state
    result.speechMs = this.speechMs
    return result
  }
}

/**
 * Whether a run of frames is a genuine interruption or the room being a room.
 *
 * Barge-in has a much worse failure mode than endpointing: cutting GIDEON off
 * because a chair moved is far more jarring than a beat of extra silence. So
 * the bar is sustained probability over a window rather than any single loud
 * frame, and the window is long enough that a cough does not clear it.
 */
export class BargeInDetector {
  private run = 0

  constructor(
    private readonly sustainMs = 180,
    private readonly threshold = 0.62,
    private readonly frameMs = 20,
  ) {}

  reset() {
    this.run = 0
  }

  /** True on the frame the interruption becomes certain, once per run. */
  push(probability: number): boolean {
    if (probability < this.threshold) {
      this.run = 0
      return false
    }
    this.run += this.frameMs
    if (this.run >= this.sustainMs) {
      this.run = 0
      return true
    }
    return false
  }
}
