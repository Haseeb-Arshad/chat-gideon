import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitSpeakable, VoiceQueue } from './voice-queue'
import { ScheduledPlayer } from './audio/player'

const texts = (value: string, options?: { flush?: boolean; first?: boolean }) =>
  splitSpeakable(value, options).chunks.map((chunk) => chunk.text)

describe('splitSpeakable', () => {
  it('holds an incomplete sentence back until it can be spoken well', () => {
    const result = splitSpeakable('The ocean is', { first: true })
    expect(result.chunks).toEqual([])
    expect(result.remainder).toBe('The ocean is')
  })
  it('releases a sentence as soon as it closes', () => {
    expect(texts('The ocean is deep. And it is', { first: true })).toEqual(['The ocean is deep.'])
  })
  it('cuts the opening chunk at a clause so speech can start sooner', () => {
    const [first] = texts('There is something genuinely strange about the deep ocean, and it took decades to understand why that is.', { first: true })
    expect(first.length).toBeLessThanOrEqual(96)
    expect(first.endsWith(',')).toBe(true)
  })
  it('gives later chunks a longer budget than the opening one', () => {
    const long = `${'word '.repeat(70)}end`
    expect(texts(long)[0].length).toBeGreaterThan(texts(long, { first: true })[0].length)
  })
  it('reports where each chunk ends so captions can track the voice', () => {
    const value = 'One. Two. Three.'
    const { chunks } = splitSpeakable(value, { flush: true })
    expect(chunks.map((chunk) => chunk.text)).toEqual(['One.', 'Two.', 'Three.'])
    expect(chunks.at(-1)?.end).toBe(value.length)
  })
  it('flushes the trailing fragment when the reply is complete', () => {
    expect(texts('All done', { flush: true })).toEqual(['All done'])
    expect(splitSpeakable('All done', { flush: true }).remainder).toBe('')
  })
  it('always consumes input so a chunkless buffer cannot spin', () => {
    const value = 'x'.repeat(600)
    const { chunks, remainder } = splitSpeakable(value)
    expect(chunks.length).toBeGreaterThan(0)
    expect(remainder.length).toBeLessThan(value.length)
  })
  it('treats whitespace-only input as nothing to say', () => {
    expect(texts('   \n  ', { flush: true })).toEqual([])
  })
})

class FakeSource {
  buffer: unknown = null
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}
class FakeContext {
  static instances: FakeContext[] = []
  currentTime = 0
  state = 'running'
  destination = {}
  sources: FakeSource[] = []
  close = vi.fn(async () => { this.state = 'closed' })
  decodeAudioData = vi.fn(async () => ({ duration: 1 }))
  constructor() { FakeContext.instances.push(this) }
  createGain() {
    return { connect: vi.fn(), gain: {
      value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    } }
  }
  createAnalyser() {
    return { connect: vi.fn(), frequencyBinCount: 32,
      getByteTimeDomainData: (samples: Uint8Array) => samples.fill(128) }
  }
  createBufferSource() {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
  endAll() {
    this.currentTime = 100
    for (const source of this.sources) source.onended?.()
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const audio = () => new Blob(['audio'])
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

describe('VoiceQueue and ScheduledPlayer lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeContext.instances = []
    vi.stubGlobal('window', { AudioContext: FakeContext })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('disposes successful playback once, preserving final progress', async () => {
    const queue = new VoiceQueue({ request: async () => audio() })
    queue.feed('One.')
    queue.finish()
    await flush()
    const context = FakeContext.instances[0]
    expect(context.sources).toHaveLength(1)
    expect(context.close).not.toHaveBeenCalled()
    context.endAll()
    await vi.advanceTimersByTimeAsync(200)
    await queue.idle()
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(queue.spokenChars).toBe(4)
    expect(queue.speaking).toBe(false)
    queue.cancel()
    await vi.advanceTimersByTimeAsync(200)
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('fades cancellation, closes once, and retains partial spoken progress', async () => {
    const queue = new VoiceQueue({ request: async () => audio() })
    queue.feed('One.')
    await flush()
    const context = FakeContext.instances[0]
    context.currentTime = 0.56
    expect(queue.spokenChars).toBe(2)
    queue.cancel()
    queue.cancel()
    expect(queue.spokenChars).toBe(2)
    expect(context.sources[0].stop).toHaveBeenCalledExactlyOnceWith(expect.closeTo(0.62, 8))
    expect(context.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(queue.speaking).toBe(false)
    await queue.idle()
  })

  it('handles a second chunk rejection immediately while the first request is delayed', async () => {
    const first = deferred<Blob>()
    const second = deferred<Blob>()
    const onError = vi.fn()
    const queue = new VoiceQueue({ request: (seq) => seq === 0 ? first.promise : second.promise, onError })
    queue.feed('One. Two.')
    queue.finish()
    await flush()
    second.reject(new Error('Synthesis service unavailable'))
    // Give unhandled-rejection reporting a macrotask, while chunk one still blocks drain.
    await vi.advanceTimersByTimeAsync(10)
    expect(onError).not.toHaveBeenCalled()
    first.resolve(audio())
    await flush()
    expect(onError).toHaveBeenCalledExactlyOnceWith('Synthesis service unavailable')
    expect(queue.hadError).toBe(true)
    FakeContext.instances[0].endAll()
    await vi.advanceTimersByTimeAsync(200)
    await queue.idle()
  })

  it('observes late generation rejections after cancellation', async () => {
    const pending = [deferred<Blob>(), deferred<Blob>()]
    const onError = vi.fn()
    const queue = new VoiceQueue({ request: (seq) => pending[seq].promise, onError })
    queue.feed('One. Two.')
    await flush()
    queue.cancel()
    pending[1].reject(new Error('Late failed request'))
    await vi.advanceTimersByTimeAsync(1)
    pending[0].reject(new DOMException('Aborted', 'AbortError'))
    await queue.idle()
    expect(onError).not.toHaveBeenCalled()
    expect(FakeContext.instances).toHaveLength(0)
  })

  it('keeps cumulative progress when completed source nodes leave a playback gap', async () => {
    const onProgress = vi.fn()
    const player = new ScheduledPlayer({ onProgress })
    await player.enqueue(new ArrayBuffer(1), 0, 4)
    const context = FakeContext.instances[0]
    context.currentTime = 1.06
    context.sources[0].onended?.()
    expect(player.spokenChars).toBe(4)
    expect(onProgress).toHaveBeenLastCalledWith(4)
    context.currentTime = 2
    await player.enqueue(new ArrayBuffer(1), 4, 5)
    expect(player.spokenChars).toBe(4)
    context.currentTime = 2.56
    expect(player.spokenChars).toBe(7)
    context.endAll()
    await player.dispose()
    expect(player.spokenChars).toBe(9)
    expect(context.close).toHaveBeenCalledTimes(1)
  })
})
