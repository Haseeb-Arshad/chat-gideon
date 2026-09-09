/**
 * The audio thread half of the microphone pipeline.
 *
 * This runs inside an AudioWorkletProcessor, which means it runs on the audio
 * rendering thread with a hard deadline every 128 samples and no access to
 * anything on the main thread. Missing that deadline is an audible glitch, so
 * everything here is O(n) over one render quantum with no allocation in the
 * steady state.
 *
 * It ships as a source string rather than a file because a worklet has to be
 * loaded from a URL, and generating a Blob URL from this constant keeps the
 * bundler out of it entirely: no separate entry point, no asset path to get
 * wrong between dev and a built server, no chance of the worklet and the code
 * that reads its messages drifting apart across a deploy.
 *
 * The main thread receives features, not audio. Sixty frames a second of raw
 * PCM across the message port would cost more than the analysis does.
 */
export const WORKLET_NAME = 'gideon-mic'

export const WORKLET_SOURCE = /* js */ `
class GideonMicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const config = (options && options.processorOptions) || {}
    this.frameSize = config.frameSize || 320
    this.buffer = new Float32Array(this.frameSize)
    this.filled = 0
    this.previous = 0
    // One-pole low pass, used only to split the frame's energy into bands.
    // A biquad would be sharper; at this job a single pole is plenty and costs
    // one multiply-add per sample.
    this.lowState = 0
    this.lowCoefficient = config.lowCoefficient || 0.28
    this.running = true
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'stop') this.running = false
    }
  }

  analyse(frame) {
    let sum = 0
    let lowSum = 0
    let crossings = 0
    let peak = 0
    let previous = this.previous

    for (let i = 0; i < frame.length; i += 1) {
      const sample = frame[i]
      sum += sample * sample

      this.lowState += this.lowCoefficient * (sample - this.lowState)
      lowSum += this.lowState * this.lowState

      // A sign change with both sides above a small floor: comparing raw signs
      // would count dither around zero as hundreds of crossings in silence.
      if ((sample > 1e-4 && previous < -1e-4) || (sample < -1e-4 && previous > 1e-4)) {
        crossings += 1
      }
      previous = sample

      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > peak) peak = magnitude
    }

    this.previous = previous
    const rms = Math.sqrt(sum / frame.length)
    const lowRms = Math.sqrt(lowSum / frame.length)

    return {
      rms,
      peak,
      zcr: crossings / frame.length,
      // Guarded: in true digital silence both terms are zero and the ratio is
      // meaningless, so it reports "not tonal" rather than NaN.
      lowRatio: rms > 1e-6 ? Math.min(1, lowRms / rms) : 0,
    }
  }

  process(inputs) {
    if (!this.running) return false

    const input = inputs[0]
    if (!input || !input.length) return true
    const channel = input[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.filled] = channel[i]
      this.filled += 1

      if (this.filled === this.frameSize) {
        const features = this.analyse(this.buffer)
        // The frame is copied because the port transfers asynchronously and the
        // buffer is about to be overwritten by the next quantum.
        features.pcm = this.buffer.slice(0)
        features.at = currentTime
        this.port.postMessage(features, [features.pcm.buffer])
        this.filled = 0
      }
    }

    return true
  }
}

registerProcessor('${WORKLET_NAME}', GideonMicProcessor)
`

let cachedUrl: string | null = null

/**
 * A stable Blob URL for the worklet.
 *
 * Cached because `addModule` is called again on every microphone restart and
 * each `createObjectURL` would otherwise leak a blob for the life of the page.
 */
export function workletUrl(): string {
  if (cachedUrl) return cachedUrl
  cachedUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  return cachedUrl
}
