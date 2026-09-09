import { describe, expect, it } from 'vitest'
import { FRAME_MS, MicCapture, type CaptureOptions, type Utterance } from './capture'

/**
 * The capture graph's bookkeeping, exercised without a browser.
 *
 * `start()` needs getUserMedia and an AudioWorklet, neither of which exists
 * here, so these drive `handleFrame` directly — which is where every decision
 * about what audio to keep actually lives. The one that matters most is the
 * echo guard: audio picked up while GIDEON was talking must never be handed
 * back as though the user had said it.
 */

interface Harness {
  capture: MicCapture
  frame: (rms: number, options?: { pcm?: boolean }) => void
  utterances: Utterance[]
  barges: number
  starts: number
}

const SAMPLES = 320

function harness(options: CaptureOptions = {}): Harness {
  const utterances: Utterance[] = []
  const state = { barges: 0, starts: 0 }

  const capture = new MicCapture({
    ...options,
    onUtterance: (utterance) => utterances.push(utterance),
    onBargeIn: () => {
      state.barges += 1
    },
    onSpeechStart: () => {
      state.starts += 1
    },
  })

  // `handleFrame` is private, and reaching it is the point: it is the whole
  // decision surface, and the alternative is testing nothing.
  const inner = capture as unknown as {
    handleFrame: (message: {
      rms: number
      zcr: number
      lowRatio: number
      peak: number
      pcm: Float32Array
      at: number
    }) => void
    preRollFrames: number
    maxFrames: number
    rate: number
  }
  inner.preRollFrames = Math.round(500 / FRAME_MS)
  inner.maxFrames = 16_000 * 30
  inner.rate = 16_000

  const frame = (rms: number) => {
    // A voiced frame when loud, a quiet broadband room when not.
    const voiced = rms > 0.02
    inner.handleFrame({
      rms,
      zcr: voiced ? 0.08 : 0.22,
      lowRatio: voiced ? 0.78 : 0.3,
      peak: rms * 1.4,
      pcm: new Float32Array(SAMPLES).fill(rms),
      at: 0,
    })
  }

  return {
    capture,
    frame,
    utterances,
    get barges() {
      return state.barges
    },
    get starts() {
      return state.starts
    },
  }
}

const ROOM = 0.005
const VOICE = 0.14

function feed(h: Harness, rms: number, count: number) {
  for (let i = 0; i < count; i += 1) h.frame(rms)
}

describe('MicCapture retention', () => {
  it('emits the utterance audio when speech ends', () => {
    const h = harness()
    feed(h, ROOM, 40)
    feed(h, VOICE, 40)
    feed(h, ROOM, 60)

    expect(h.utterances).toHaveLength(1)
    expect(h.utterances[0].sampleRate).toBe(16_000)
    expect(h.utterances[0].frames.length).toBeGreaterThan(40)
  })

  it('includes pre-roll, so the first consonant survives onset detection', () => {
    const h = harness()
    feed(h, ROOM, 40)
    feed(h, VOICE, 30)
    feed(h, ROOM, 60)

    // More frames than were spoken: the head came from the pre-roll window.
    expect(h.utterances[0].frames.length).toBeGreaterThan(30)
  })

  it('keeps a snapshot available mid-sentence for the live transcript', () => {
    const h = harness()
    feed(h, ROOM, 40)
    feed(h, VOICE, 30)

    const snapshot = h.capture.snapshot()
    expect(snapshot).not.toBeNull()
    expect(snapshot!.ms).toBeGreaterThan(0)
    // Snapshotting must not end the utterance.
    expect(h.utterances).toHaveLength(0)
  })

  it('discards a blip too short to be a word', () => {
    const h = harness({ vad: { onsetFrames: 1, minSpeechMs: 300 } })
    feed(h, ROOM, 40)
    feed(h, VOICE, 2)
    feed(h, ROOM, 60)
    expect(h.utterances).toEqual([])
  })
})

describe('MicCapture echo guard', () => {
  it('throws away audio captured while GIDEON was talking', () => {
    const h = harness()
    feed(h, ROOM, 40)

    h.capture.setDucking(true)
    // Loud enough to look like speech, but nobody actually interrupted: this
    // is GIDEON's own voice arriving back through the microphone.
    feed(h, VOICE, 8)
    h.capture.setDucking(false)

    // Now genuine silence. Nothing may be emitted from what was recorded
    // during playback — sending it would be GIDEON answering itself.
    feed(h, ROOM, 60)
    expect(h.utterances).toEqual([])
  })

  it('withholds the speech-start callback while ducked', () => {
    const h = harness()
    feed(h, ROOM, 40)
    h.capture.setDucking(true)
    feed(h, VOICE, 10)
    // Announcing a speech start here would set a live transcript running on
    // the echo of GIDEON's own reply.
    expect(h.starts).toBe(0)
  })

  it('keeps the interruption when a barge-in is confirmed', () => {
    // A low duck threshold and a short window, so the harness can confirm one.
    const h = harness({ duckDb: 0 })
    feed(h, ROOM, 40)

    h.capture.setDucking(true)
    // Sustained speech over the top of playback.
    feed(h, VOICE, 20)
    expect(h.barges).toBeGreaterThan(0)

    // Playback stops because of the interruption.
    h.capture.setDucking(false)
    feed(h, VOICE, 20)
    feed(h, ROOM, 60)

    // The sentence they cut in with is kept, from before playback stopped.
    expect(h.utterances).toHaveLength(1)
    expect(h.utterances[0].frames.length).toBeGreaterThan(20)
  })

  it('forgets a barge-in once it has been honoured', () => {
    const h = harness({ duckDb: 0 })
    feed(h, ROOM, 40)
    h.capture.setDucking(true)
    feed(h, VOICE, 20)
    h.capture.setDucking(false)
    feed(h, ROOM, 60)
    h.utterances.length = 0

    // A second reply, this time with only echo during it.
    h.capture.setDucking(true)
    feed(h, VOICE, 8)
    h.capture.setDucking(false)
    feed(h, ROOM, 60)
    expect(h.utterances).toEqual([])
  })
})

describe('MicCapture hangover control', () => {
  it('passes an override through to the detector', () => {
    const h = harness()
    feed(h, ROOM, 40)
    feed(h, VOICE, 30)
    h.capture.setHangover(1_400)

    const defaultFrames = Math.round(700 / FRAME_MS)
    feed(h, ROOM, defaultFrames + 4)
    // Still open: the override is longer than the configured default.
    expect(h.utterances).toEqual([])

    feed(h, ROOM, Math.round((1_400 - 700) / FRAME_MS))
    expect(h.utterances).toHaveLength(1)
  })

  it('restores the default when cleared', () => {
    const h = harness()
    h.capture.setHangover(5_000)
    h.capture.setHangover(null)
    feed(h, ROOM, 40)
    feed(h, VOICE, 30)
    feed(h, ROOM, Math.round(700 / FRAME_MS) + 2)
    expect(h.utterances).toHaveLength(1)
  })
})
