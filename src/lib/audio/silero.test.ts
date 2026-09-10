import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as ort from 'onnxruntime-web'
import { SILERO_WINDOW, SileroStream, sileroModel, type SileroModel } from './silero'
import { resample } from './wav'

/**
 * The stream around the model, with a fake model; then the real model, on
 * the sounds that used to interrupt GIDEON and on a real spoken sentence.
 */

function fakeModel(probabilities: number[] = []) {
  const windows: Float32Array[] = []
  const states: number[] = []
  const model: SileroModel = {
    async run(window, state) {
      windows.push(window)
      states.push(state[0])
      const next = new Float32Array(state.length)
      next[0] = state[0] + 1
      return { probability: probabilities[windows.length - 1] ?? 0, state: next }
    },
  }
  return { model, windows, states }
}

function frames(stream: SileroStream, count: number, size = 320, value = (i: number) => i) {
  for (let i = 0; i < count; i += 1) stream.push(new Float32Array(size).fill(value(i)))
}

describe('SileroStream', () => {
  it('gathers 20 ms frames into 32 ms windows and threads the state through', async () => {
    const { model, windows, states } = fakeModel()
    const stream = new SileroStream(model)
    // Eight frames of 320 samples are 2,560 samples: five whole windows.
    frames(stream, 8)
    await stream.idle()

    expect(windows).toHaveLength(5)
    expect(windows.every((window) => window.length === SILERO_WINDOW)).toBe(true)
    expect(states).toEqual([0, 1, 2, 3, 4])
    // Samples keep their order across frame boundaries.
    expect(windows[0][0]).toBe(0)
    expect(windows[0][511]).toBe(1)
  })

  it('resamples a 48 kHz microphone to the 16 kHz the model needs', async () => {
    const { model, windows } = fakeModel()
    const stream = new SileroStream(model, 48_000)
    frames(stream, 16, 960)
    await stream.idle()

    const perFrame = resample(new Float32Array(960), 48_000, 16_000).length
    expect(windows).toHaveLength(Math.floor((16 * perFrame) / SILERO_WINDOW))
  })

  it('counts speech as it is heard, and keeps the run under way for a new utterance', async () => {
    const { model } = fakeModel([0.9, 0.9, 0.1, 0.8, 0.95])
    const stream = new SileroStream(model)
    frames(stream, 8)
    await stream.idle()

    expect(stream.probability).toBeCloseTo(0.95)
    expect(stream.recent).toBeCloseTo(0.95)
    expect(stream.speechRunMs).toBe(64)
    expect(stream.speechMs).toBe(128)

    stream.markUtterance()
    expect(stream.speechMs).toBe(64)
  })

  it('discards a window still being scored when it is reset', async () => {
    let release: (value: { probability: number; state: Float32Array }) => void = () => undefined
    const model: SileroModel = {
      run: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    }
    const stream = new SileroStream(model)
    stream.push(new Float32Array(SILERO_WINDOW))
    stream.reset()
    release({ probability: 0.99, state: new Float32Array(256).fill(7) })
    await stream.idle()

    expect(stream.probability).toBe(0)
    expect(stream.speechRunMs).toBe(0)
  })

  it('treats a failed window as no reading, not an error', async () => {
    const model: SileroModel = { run: () => Promise.reject(new Error('wasm hiccup')) }
    const stream = new SileroStream(model)
    frames(stream, 4)
    await stream.idle()
    expect(stream.probability).toBe(0)
  })
})

// -- The real model ----------------------------------------------------------

const RATE = 16_000

function seeded(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function scaled(signal: Float32Array, target: number) {
  let sum = 0
  for (const value of signal) sum += value * value
  const gain = target / (Math.sqrt(sum / signal.length) || 1)
  return signal.map((value) => value * gain)
}

/** Brown-noise rumble with a motor hum on top, at a level that used to interrupt. */
function fan(seconds: number) {
  const random = seeded(7)
  const out = new Float32Array(seconds * RATE)
  let brown = 0
  for (let i = 0; i < out.length; i += 1) {
    brown = (brown + (random() * 2 - 1) * 0.02) * 0.998
    const t = i / RATE
    out[i] = brown * 6 + 0.25 * Math.sin(2 * Math.PI * 120 * t) + 0.12 * Math.sin(2 * Math.PI * 240 * t)
  }
  return scaled(out, 0.06)
}

/** Key clicks at typing speed: a broadband snap and a low thud each. */
function typing(seconds: number) {
  const random = seeded(11)
  const out = new Float32Array(seconds * RATE)
  let t = 0.1
  while (t < seconds - 0.05) {
    const start = Math.floor(t * RATE)
    const amp = 0.7 * (0.5 + random() * 0.5)
    for (let k = 0; k < (0.004 + random() * 0.005) * RATE && start + k < out.length; k += 1) {
      out[start + k] += (random() * 2 - 1) * amp * Math.exp(-k / (0.0015 * RATE))
    }
    const pitch = 150 + random() * 100
    for (let k = 0; k < 0.03 * RATE && start + k < out.length; k += 1) {
      out[start + k] += Math.sin((2 * Math.PI * pitch * k) / RATE) * Math.exp(-k / (0.01 * RATE)) * 0.3 * amp
    }
    t += 0.09 + random() * 0.17
  }
  return out
}

function mix(a: Float32Array, b: Float32Array) {
  const out = new Float32Array(Math.max(a.length, b.length))
  for (let i = 0; i < out.length; i += 1) out[i] = (a[i] ?? 0) + (b[i] ?? 0)
  return out
}

function speech() {
  const raw = readFileSync('src/lib/audio/fixtures/speech-16k.pcm')
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2)
  return Float32Array.from(pcm, (value) => (value / 32768) * 0.8)
}

async function score(model: SileroModel, signal: Float32Array) {
  const probabilities: number[] = []
  const recording: SileroModel = {
    async run(window, state) {
      const result = await model.run(window, state)
      probabilities.push(result.probability)
      return result
    },
  }
  const stream = new SileroStream(recording)
  for (let i = 0; i + 320 <= signal.length; i += 320) stream.push(signal.subarray(i, i + 320))
  await stream.idle()
  // Guards the guard: with no readings at all, the maximum is -Infinity and
  // every "never hears noise as speech" check would pass for nothing.
  expect(probabilities.length).toBeGreaterThan(signal.length / 512 - 2)

  let longest = 0
  let run = 0
  for (const p of probabilities) {
    run = p >= 0.5 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return { max: Math.max(...probabilities), longestMs: longest * 32 }
}

describe('Silero v5 on the sounds that used to interrupt GIDEON', () => {
  const loaded = sileroModel(ort, readFileSync('public/models/silero_vad_v5.onnx'))

  it.each([
    ['a loud fan', () => fan(6)],
    ['typing', () => typing(6)],
    ['a fan and typing together', () => mix(fan(6), typing(6))],
  ])('never hears %s as speech', { timeout: 30_000 }, async (_, make) => {
    const { max } = await score(await loaded, make())
    expect(max).toBeLessThan(0.5)
  })

  it('hears a real sentence, alone and over the fan', { timeout: 30_000 }, async () => {
    const model = await loaded
    const sentence = speech()
    expect((await score(model, sentence)).longestMs).toBeGreaterThanOrEqual(512)
    expect((await score(model, mix(sentence, fan(5)))).longestMs).toBeGreaterThanOrEqual(512)
  })
})
