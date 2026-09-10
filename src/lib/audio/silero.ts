/**
 * Silero VAD: a small neural network that tells speech from everything else.
 *
 * The detector in `vad.ts` judges each frame by loudness and spectral shape.
 * That is fast and needs nothing downloaded, but it cannot tell a voice from a
 * desk fan at the same level: fed six seconds of a synthetic fan while GIDEON
 * was talking, it declared thirty-three interruptions, the first after 160 ms.
 * Silero v5, trained on noisy speech in thousands of languages, scored that fan
 * at 0.06 and keyboard clicks at 0.17, while real speech scored 1.0 even with
 * the same fan running underneath it.
 *
 * It works alongside the energy detector rather than replacing it. Silero
 * cannot tell the user's voice from GIDEON's own voice leaking back into the
 * microphone, since both are speech, and loudness can. So an interruption needs
 * both: loud enough to be the person at the mic, and speech-shaped enough to be
 * a person at all.
 */

import { resample } from './wav'

/** The model runs at 16 kHz, on windows of 512 samples: 32 ms each. */
export const SILERO_RATE = 16_000
export const SILERO_WINDOW = 512
const WINDOW_MS = (SILERO_WINDOW / SILERO_RATE) * 1000
/** Silero's own recommended line between speech and not. */
export const SPEECH_THRESHOLD = 0.5
const STATE_SIZE = 2 * 128

export interface SileroModel {
  /** One window at 16 kHz, with the recurrent state the previous one left. */
  run(window: Float32Array, state: Float32Array): Promise<{ probability: number; state: Float32Array }>
}

/**
 * Microphone frames in, a running speech probability out.
 *
 * Frames arrive every 20 ms and the model wants 32 ms windows, so samples are
 * gathered until a window is full. Windows are run strictly one at a time,
 * each on the state the last one produced, which is what the model's memory of
 * the last few hundred milliseconds depends on.
 */
export class SileroStream {
  private buffer = new Float32Array(SILERO_WINDOW)
  private filled = 0
  private queue: Float32Array[] = []
  private draining: Promise<void> | null = null
  private state: Float32Array = new Float32Array(STATE_SIZE)
  /** Bumped by `reset`, so a window already in flight cannot write afterwards. */
  private generation = 0
  private previous = 0

  /** The latest window's speech probability. */
  probability = 0
  /** Unbroken speech up to the latest window, in milliseconds. */
  speechRunMs = 0
  /** Speech heard since the current utterance began, in milliseconds. */
  speechMs = 0

  constructor(
    private readonly model: SileroModel,
    private readonly inputRate = SILERO_RATE,
  ) {}

  /**
   * The higher of the last two windows. An energy frame is 20 ms and a window
   * 32, so this is the reading whose audio actually overlaps the frame being
   * judged, rather than one that may have ended just before it.
   */
  get recent() {
    return Math.max(this.probability, this.previous)
  }

  push(frame: Float32Array) {
    const samples =
      this.inputRate === SILERO_RATE ? frame : resample(frame, this.inputRate, SILERO_RATE)
    let offset = 0
    while (offset < samples.length) {
      const take = Math.min(SILERO_WINDOW - this.filled, samples.length - offset)
      this.buffer.set(samples.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === SILERO_WINDOW) {
        this.queue.push(this.buffer.slice())
        this.filled = 0
      }
    }
    this.kick()
  }

  /**
   * Starts a pass over the queue unless one is running. A pass that is just
   * finishing when more windows arrive restarts itself rather than leaving
   * them queued until the next frame happens to come along.
   */
  private kick() {
    if (this.draining || !this.queue.length) return
    this.draining = this.drain().finally(() => {
      this.draining = null
      this.kick()
    })
  }

  /** Resolves once every window pushed so far has been run. */
  async idle() {
    while (this.draining) await this.draining
  }

  /**
   * Count speech from here on, for a new utterance. The run already under way
   * is kept, because detection begins a few frames into speech and those
   * frames are part of what was said.
   */
  markUtterance() {
    this.speechMs = this.speechRunMs
  }

  reset() {
    this.generation += 1
    this.queue = []
    this.filled = 0
    this.state = new Float32Array(STATE_SIZE)
    this.probability = 0
    this.previous = 0
    this.speechRunMs = 0
    this.speechMs = 0
  }

  private async drain() {
    while (this.queue.length) {
      const generation = this.generation
      const window = this.queue.shift()!
      let result: { probability: number; state: Float32Array }
      try {
        result = await this.model.run(window, this.state)
      } catch {
        // One failed window leaves the last reading standing; the energy
        // detector carries on either way.
        continue
      }
      if (generation !== this.generation) continue

      this.state = result.state
      this.previous = this.probability
      this.probability = result.probability
      if (result.probability >= SPEECH_THRESHOLD) {
        this.speechRunMs += WINDOW_MS
        this.speechMs += WINDOW_MS
      } else {
        this.speechRunMs = 0
      }
    }
  }
}

/** The slice of onnxruntime this needs, so Node tests and the browser share it. */
interface OrtLike {
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => unknown
  InferenceSession: {
    create(model: ArrayBuffer | Uint8Array, options?: object): Promise<OrtSession>
  }
}

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>
}

export async function sileroModel(ort: OrtLike, bytes: ArrayBuffer | Uint8Array): Promise<SileroModel> {
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SILERO_RATE)]), [1])
  return {
    async run(window, state) {
      const out = await session.run({
        input: new ort.Tensor('float32', window, [1, SILERO_WINDOW]),
        state: new ort.Tensor('float32', state, [2, 1, 128]),
        sr,
      })
      return {
        probability: (out.output.data as Float32Array)[0],
        state: Float32Array.from(out.stateN.data as Float32Array),
      }
    },
  }
}

const MODEL_URL = '/models/silero_vad_v5.onnx'
let loading: Promise<SileroModel | null> | null = null

/**
 * Loads the model once per page, or resolves null if it cannot be.
 *
 * The runtime's WebAssembly is fetched from the CDN at the exact version
 * installed, rather than shipped with the app: it is fourteen megabytes, and a
 * page that has to download it before it can listen is worse than one that
 * listens with the energy detector alone for the few seconds it takes.
 */
export function loadSilero(): Promise<SileroModel | null> {
  // Server builds never listen, and this keeps the runtime out of them.
  if (import.meta.env.SSR) return Promise.resolve(null)
  loading ??= (async () => {
    try {
      const ort = await import('onnxruntime-web/wasm')
      ort.env.wasm.numThreads = 1
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`
      const response = await fetch(MODEL_URL)
      if (!response.ok) return null
      return await sileroModel(ort as unknown as OrtLike, await response.arrayBuffer())
    } catch {
      return null
    }
  })()
  return loading
}
