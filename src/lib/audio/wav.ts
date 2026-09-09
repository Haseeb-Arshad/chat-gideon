/**
 * PCM to WAV, because the transcription endpoint wants a container.
 *
 * WAV is used rather than something compressed for one reason: the browser has
 * no MP3 or FLAC encoder, and the only compressed option — Opus through
 * WebCodecs — hands back raw frames that would still need muxing into a
 * container by hand. A WAV header is 44 bytes of arithmetic and cannot go
 * wrong, and at 16 kHz mono a spoken sentence is a couple of hundred
 * kilobytes, which costs less on the wire than the encoder would cost in
 * complexity and risk.
 */

/** 16 kHz mono is the standard input rate for every speech model worth using. */
export const WAV_SAMPLE_RATE = 16_000

/**
 * Linear resampling to the target rate.
 *
 * Safari ignores the requested `sampleRate` on an AudioContext and hands back
 * the hardware rate, so this is not optional. Linear interpolation is crude
 * for music and entirely adequate for speech that is about to be fed to a
 * model trained on telephone-quality audio.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input
  const ratio = from / to
  const length = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(length)

  for (let i = 0; i < length; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = input[index] ?? 0
    const b = input[index + 1] ?? a
    output[i] = a + (b - a) * fraction
  }
  return output
}

/** Joins frames into one buffer. */
export function concatFrames(frames: Float32Array[], total?: number): Float32Array {
  const length = total ?? frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Float32Array(length)
  let offset = 0
  for (const frame of frames) {
    if (offset + frame.length > length) {
      out.set(frame.subarray(0, length - offset), offset)
      break
    }
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

/**
 * A mono 16-bit PCM WAV file.
 *
 * Samples are clamped before scaling: a float outside -1..1 would otherwise
 * wrap around the 16-bit range and turn a loud syllable into a burst of noise
 * that the model hears as a different word.
 */
export function encodeWav(samples: Float32Array, sampleRate = WAV_SAMPLE_RATE): ArrayBuffer {
  const bytesPerSample = 2
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample)
  const view = new DataView(buffer)

  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }

  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * bytesPerSample, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  // 1 is uncompressed PCM; everything else here describes one 16-bit channel.
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * bytesPerSample, true)

  let offset = 44
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i]
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += bytesPerSample
  }

  return buffer
}

/** Everything above, in the order a caller always wants it. */
export function utteranceToWav(
  frames: Float32Array[],
  sourceRate: number,
  targetRate = WAV_SAMPLE_RATE,
): ArrayBuffer {
  return encodeWav(resample(concatFrames(frames), sourceRate, targetRate), targetRate)
}
