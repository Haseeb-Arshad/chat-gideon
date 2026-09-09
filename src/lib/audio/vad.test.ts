import { describe, expect, it } from 'vitest'
import {
  BargeInDetector,
  DEFAULT_VAD,
  NoiseFloor,
  VoiceActivityDetector,
  speechProbability,
  type FrameFeatures,
} from './vad'

/** A frame that looks like a vowel: loud, low-frequency, few zero crossings. */
function voice(rms = 0.12): FrameFeatures {
  return { rms, zcr: 0.08, lowRatio: 0.78 }
}

/** A frame that looks like a quiet room: near-silent and broadband. */
function room(rms = 0.006): FrameFeatures {
  return { rms, zcr: 0.22, lowRatio: 0.3 }
}

/** Loud but broadband and jittery: a fan, a hiss, a chair scrape. */
function noise(rms = 0.14): FrameFeatures {
  return { rms, zcr: 0.55, lowRatio: 0.18 }
}

function feed(vad: VoiceActivityDetector, frame: FrameFeatures, count: number) {
  const events: string[] = []
  for (let i = 0; i < count; i += 1) {
    const result = vad.push(frame)
    if (result.onSpeechStart) events.push('start')
    if (result.onSpeechEnd) events.push('end')
    if (result.onFalseStart) events.push('false')
  }
  return events
}

const FRAMES_PER_SECOND = 1000 / DEFAULT_VAD.frameMs

describe('NoiseFloor', () => {
  it('drops toward a new quiet quickly', () => {
    const floor = new NoiseFloor(0.1)
    for (let i = 0; i < 30; i += 1) floor.update(0.001, false)
    expect(floor.value).toBeLessThan(0.01)
  })

  it('climbs toward a louder room only slowly', () => {
    const floor = new NoiseFloor(0.001)
    for (let i = 0; i < 50; i += 1) floor.update(0.05, false)
    // Fifty frames is one second; a second of noise must not become the floor.
    expect(floor.value).toBeLessThan(0.01)
  })

  it('refuses to learn anything while someone is speaking', () => {
    const floor = new NoiseFloor(0.002)
    const before = floor.value
    for (let i = 0; i < 200; i += 1) floor.update(0.2, true)
    expect(floor.value).toBe(before)
  })
})

describe('speechProbability', () => {
  it('is zero below the absolute silence floor however good the ratio', () => {
    expect(speechProbability({ rms: 0.0001, zcr: 0.05, lowRatio: 0.9 }, 40, DEFAULT_VAD)).toBe(0)
  })

  it('rises with signal-to-noise ratio', () => {
    const low = speechProbability(voice(), 4, DEFAULT_VAD)
    const high = speechProbability(voice(), 20, DEFAULT_VAD)
    expect(high).toBeGreaterThan(low)
    expect(high).toBeGreaterThan(0.8)
  })

  it('discounts loud broadband noise against equally loud speech', () => {
    const spoken = speechProbability(voice(0.14), 18, DEFAULT_VAD)
    const hiss = speechProbability(noise(0.14), 18, DEFAULT_VAD)
    expect(hiss).toBeLessThan(spoken * 0.6)
  })
})

describe('VoiceActivityDetector', () => {
  it('stays silent through a quiet room', () => {
    const vad = new VoiceActivityDetector()
    expect(feed(vad, room(), 100)).toEqual([])
    expect(vad.currentState).toBe('silence')
  })

  it('declares speech only after the onset run is satisfied', () => {
    const vad = new VoiceActivityDetector()
    feed(vad, room(), 30)
    const first = vad.push(voice())
    expect(first.onSpeechStart).toBeUndefined()
    expect(first.state).toBe('onset')
    vad.push(voice())
    expect(vad.push(voice()).onSpeechStart).toBe(true)
  })

  it('reports the end of an utterance once the hangover expires', () => {
    const vad = new VoiceActivityDetector()
    feed(vad, room(), 30)
    feed(vad, voice(), 40)
    expect(vad.currentState).toBe('speech')

    const hangoverFrames = DEFAULT_VAD.hangoverMs / DEFAULT_VAD.frameMs
    // One frame short of the hangover the utterance is still open.
    expect(feed(vad, room(), hangoverFrames - 1)).toEqual([])
    expect(feed(vad, room(), 1)).toEqual(['end'])
  })

  it('treats a pause between words as one utterance, not two', () => {
    const vad = new VoiceActivityDetector()
    feed(vad, room(), 30)
    const events = [
      ...feed(vad, voice(), 20),
      // A gap comfortably shorter than the hangover.
      ...feed(vad, room(), 6),
      ...feed(vad, voice(), 20),
    ]
    expect(events).toEqual(['start'])
    expect(vad.currentState).toBe('speech')
  })

  it('discards a blip too short to be a word', () => {
    const vad = new VoiceActivityDetector({ onsetFrames: 1, minSpeechMs: 200 })
    feed(vad, room(), 30)
    const events = [...feed(vad, voice(), 3), ...feed(vad, room(), 40)]
    expect(events).toContain('false')
    expect(events).not.toContain('end')
  })

  it('does not trigger on steady broadband noise', () => {
    const vad = new VoiceActivityDetector()
    feed(vad, room(), 30)
    expect(feed(vad, noise(), Math.round(FRAMES_PER_SECOND * 3))).toEqual([])
  })

  it('holds its threshold higher while GIDEON is audible', () => {
    const quiet = { rms: 0.02, zcr: 0.08, lowRatio: 0.78 }

    const open = new VoiceActivityDetector()
    feed(open, room(0.004), 40)
    expect(feed(open, quiet, 10)).toEqual(['start'])

    const ducked = new VoiceActivityDetector()
    ducked.duckDb = 14
    feed(ducked, room(0.004), 40)
    expect(feed(ducked, quiet, 10)).toEqual([])
  })

  it('starts clean after a reset', () => {
    const vad = new VoiceActivityDetector()
    feed(vad, room(), 30)
    feed(vad, voice(), 10)
    vad.reset()
    expect(vad.currentState).toBe('silence')
  })
})

describe('BargeInDetector', () => {
  it('needs sustained confidence, not one loud frame', () => {
    const barge = new BargeInDetector(180, 0.62, 20)
    // Eight frames is 160 ms, which is short of the window however loud it is.
    for (let i = 0; i < 8; i += 1) expect(barge.push(0.9)).toBe(false)
    expect(barge.push(0.9)).toBe(true)
  })

  it('forgets the run as soon as confidence drops', () => {
    const barge = new BargeInDetector(180, 0.62, 20)
    for (let i = 0; i < 8; i += 1) barge.push(0.9)
    barge.push(0.1)
    // The run restarted, so the next burst has to earn the full window again.
    for (let i = 0; i < 8; i += 1) expect(barge.push(0.9)).toBe(false)
    expect(barge.push(0.9)).toBe(true)
  })

  it('ignores a long stretch of low confidence entirely', () => {
    const barge = new BargeInDetector()
    for (let i = 0; i < 200; i += 1) expect(barge.push(0.4)).toBe(false)
  })
})
