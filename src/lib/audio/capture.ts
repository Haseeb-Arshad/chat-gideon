/**
 * The microphone, owned in one place.
 *
 * GIDEON needs three different things from the same input stream, and the whole
 * reason this module exists is that they used to be answered by three unrelated
 * mechanisms: the browser recogniser decided when you had finished, an analyser
 * node on the playback element drove the eyes, and nothing at all knew whether
 * you were talking while GIDEON was. One capture graph now answers all three,
 * which is also the only way the echo guard can work — the barge-in decision
 * has to see the same frames as the level meter.
 *
 * The stream stays open across turns. Re-acquiring `getUserMedia` per turn cost
 * a few hundred milliseconds and, on some platforms, an audible click.
 */

import {
  BargeInDetector,
  VoiceActivityDetector,
  type FrameFeatures,
  type VadConfig,
  type VadFrameResult,
} from './vad'
import { WORKLET_NAME, workletUrl } from './worklet-source'

/** 16 kHz mono in 20 ms frames: what every streaming recogniser wants. */
export const TARGET_SAMPLE_RATE = 16_000
export const FRAME_MS = 20

export interface CaptureHandlers {
  /** Every frame, with the detector's verdict attached. */
  onFrame?: (result: VadFrameResult, features: FrameFeatures) => void
  onSpeechStart?: () => void
  /** An utterance finished. `ms` is its length, hangover excluded. */
  onSpeechEnd?: (ms: number) => void
  /** Sustained speech while GIDEON was audible. */
  onBargeIn?: () => void
  /** Smoothed 0–1 input level for the interface. */
  onLevel?: (level: number) => void
  onError?: (code: string, message: string) => void
}

export interface CaptureOptions extends CaptureHandlers {
  vad?: Partial<VadConfig>
  /** Raised while GIDEON speaks so his own voice cannot interrupt him. */
  duckDb?: number
}

export type CaptureStatus = 'idle' | 'starting' | 'running' | 'denied' | 'unsupported' | 'failed'

interface MicFrameMessage extends FrameFeatures {
  peak: number
  pcm: Float32Array
  at: number
}

export function captureSupported(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      (window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) &&
      typeof AudioWorkletNode !== 'undefined',
  )
}

const PERMISSION_ERRORS = new Set(['NotAllowedError', 'SecurityError'])
const DEVICE_ERRORS = new Set(['NotFoundError', 'OverconstrainedError', 'NotReadableError'])

export class MicCapture {
  status: CaptureStatus = 'idle'

  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private readonly vad: VoiceActivityDetector
  private readonly barge = new BargeInDetector()
  private level = 0
  /**
   * True while GIDEON's voice is coming out of the speakers. It raises the
   * detector's bar and is the only thing that routes a detection to barge-in
   * rather than to ordinary endpointing.
   */
  private ducking = false
  private disposed = false

  constructor(private readonly options: CaptureOptions = {}) {
    this.vad = new VoiceActivityDetector(options.vad)
  }

  /** True once frames are flowing. */
  get running() {
    return this.status === 'running'
  }

  get noiseFloor() {
    return this.vad.noiseFloor
  }

  async start(): Promise<boolean> {
    if (this.disposed) return false
    if (this.status === 'running' || this.status === 'starting') return true
    if (!captureSupported()) {
      this.status = 'unsupported'
      this.options.onError?.(
        'unsupported',
        'This browser cannot open a microphone. You can still type.',
      )
      return false
    }

    this.status = 'starting'

    try {
      // The browser's own echo cancellation is the first line of defence
      // against GIDEON hearing himself; the duck below is the second.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
    } catch (error) {
      const name = (error as Error)?.name ?? ''
      if (PERMISSION_ERRORS.has(name)) {
        this.status = 'denied'
        this.options.onError?.(
          'denied',
          'Microphone access is blocked. Allow it in the address bar, then tap Resume.',
        )
      } else if (DEVICE_ERRORS.has(name)) {
        this.status = 'failed'
        this.options.onError?.('no-device', 'No working microphone was found.')
      } else {
        this.status = 'failed'
        this.options.onError?.('failed', 'The microphone could not be opened.')
      }
      return false
    }

    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      // Asking for the target rate lets the browser resample in native code.
      // Safari ignores it and hands back the hardware rate, which is why the
      // frame size below is derived from the context rather than assumed.
      this.context = new Ctor({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' })
      if (this.context.state === 'suspended') await this.context.resume()

      await this.context.audioWorklet.addModule(workletUrl())
      if (this.disposed) {
        await this.teardown()
        return false
      }

      const frameSize = Math.round((this.context.sampleRate * FRAME_MS) / 1000)
      this.source = this.context.createMediaStreamSource(this.stream)
      this.node = new AudioWorkletNode(this.context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { frameSize },
      })
      this.node.port.onmessage = (event) => this.handleFrame(event.data as MicFrameMessage)
      this.source.connect(this.node)

      this.status = 'running'
      return true
    } catch {
      await this.teardown()
      this.status = 'failed'
      this.options.onError?.('failed', 'The audio pipeline could not be started.')
      return false
    }
  }

  /** Called when GIDEON starts and stops being audible. */
  setDucking(ducking: boolean) {
    if (this.ducking === ducking) return
    this.ducking = ducking
    this.vad.duckDb = ducking ? (this.options.duckDb ?? 14) : 0
    this.barge.reset()
  }

  /** Forget the current utterance without dropping the stream. */
  resetUtterance() {
    this.vad.reset()
    this.barge.reset()
  }

  async stop() {
    await this.teardown()
    if (this.status !== 'denied' && this.status !== 'unsupported') this.status = 'idle'
  }

  async dispose() {
    this.disposed = true
    await this.teardown()
  }

  private handleFrame(message: MicFrameMessage) {
    if (!message || this.disposed) return

    const features: FrameFeatures = {
      rms: message.rms,
      zcr: message.zcr,
      lowRatio: message.lowRatio,
    }
    const result = this.vad.push(features)

    // Attack fast, release slow: a level meter that decays as fast as it rises
    // flickers, and one that rises slowly misses the start of every word.
    const target = Math.min(1, message.peak * 2.6)
    this.level += (target - this.level) * (target > this.level ? 0.55 : 0.12)
    this.options.onLevel?.(this.level)

    this.options.onFrame?.(result, features)

    if (this.ducking) {
      // While GIDEON is talking, sustained speech is an interruption, and the
      // ordinary endpointer's edges are meaningless — the utterance it would
      // report started against a raised threshold mid-playback.
      if (this.barge.push(result.probability)) this.options.onBargeIn?.()
      return
    }

    if (result.onSpeechStart) this.options.onSpeechStart?.()
    if (result.onSpeechEnd) this.options.onSpeechEnd?.(result.speechMs)
  }

  private async teardown() {
    try {
      this.node?.port.postMessage({ type: 'stop' })
    } catch {
      // The port is already gone; nothing to tell it.
    }
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
      this.node = null
    }
    this.source?.disconnect()
    this.source = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    if (this.context) {
      const context = this.context
      this.context = null
      await context.close().catch(() => undefined)
    }
    this.vad.reset()
    this.barge.reset()
    this.level = 0
  }
}
