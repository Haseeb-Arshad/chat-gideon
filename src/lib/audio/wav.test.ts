import { describe, expect, it } from 'vitest'
import { concatFrames, encodeWav, resample, utteranceToWav } from './wav'

function readAscii(view: DataView, offset: number, length: number) {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i))
  return out
}

describe('resample', () => {
  it('leaves audio alone when the rate already matches', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(resample(input, 16_000, 16_000)).toBe(input)
  })

  it('halves the length when halving the rate', () => {
    const input = new Float32Array(480)
    expect(resample(input, 48_000, 24_000).length).toBe(240)
  })

  it('preserves a constant signal through interpolation', () => {
    const input = new Float32Array(120).fill(0.5)
    const out = resample(input, 48_000, 16_000)
    for (const sample of out) expect(sample).toBeCloseTo(0.5, 5)
  })

  it('is empty-safe', () => {
    expect(resample(new Float32Array(0), 48_000, 16_000).length).toBe(0)
  })
})

describe('concatFrames', () => {
  it('joins frames in order', () => {
    const out = concatFrames([new Float32Array([1, 2]), new Float32Array([3])])
    expect([...out]).toEqual([1, 2, 3])
  })

  it('stops at an explicit total rather than overrunning', () => {
    const out = concatFrames([new Float32Array([1, 2]), new Float32Array([3, 4])], 3)
    expect([...out]).toEqual([1, 2, 3])
  })

  it('is empty-safe', () => {
    expect(concatFrames([]).length).toBe(0)
  })
})

describe('encodeWav', () => {
  it('writes a header a decoder will accept', () => {
    const buffer = encodeWav(new Float32Array(100), 16_000)
    const view = new DataView(buffer)

    expect(readAscii(view, 0, 4)).toBe('RIFF')
    expect(readAscii(view, 8, 4)).toBe('WAVE')
    expect(readAscii(view, 12, 4)).toBe('fmt ')
    expect(readAscii(view, 36, 4)).toBe('data')
    // Uncompressed PCM, one channel, 16 bits.
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    // 44 bytes of header plus two bytes per sample.
    expect(buffer.byteLength).toBe(44 + 200)
    expect(view.getUint32(4, true)).toBe(36 + 200)
    expect(view.getUint32(40, true)).toBe(200)
  })

  it('clamps rather than wrapping a sample past full scale', () => {
    // Without the clamp this wraps and a loud syllable becomes noise the model
    // hears as a different word.
    const view = new DataView(encodeWav(new Float32Array([2, -2]), 16_000))
    expect(view.getInt16(44, true)).toBe(32_767)
    expect(view.getInt16(46, true)).toBe(-32_768)
  })

  it('round-trips a mid-scale sample within quantisation error', () => {
    const view = new DataView(encodeWav(new Float32Array([0.5]), 16_000))
    expect(view.getInt16(44, true) / 0x7fff).toBeCloseTo(0.5, 4)
  })
})

describe('utteranceToWav', () => {
  it('resamples and encodes in one step', () => {
    const frames = [new Float32Array(480).fill(0.25), new Float32Array(480).fill(0.25)]
    const buffer = utteranceToWav(frames, 48_000, 16_000)
    // 960 samples at 48 kHz is 320 at 16 kHz.
    expect(buffer.byteLength).toBe(44 + 320 * 2)
    expect(new DataView(buffer).getUint32(24, true)).toBe(16_000)
  })
})
