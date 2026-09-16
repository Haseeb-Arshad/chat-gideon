import { describe, expect, it, vi } from 'vitest'
import { InputGeneration, SegmentAccumulator, isComposingKey, playbackCaption, type TranscriptSegment } from './agentLifecycle'

const segment = (continued = false): TranscriptSegment => ({ frames: [new Float32Array(16)], sampleRate: 16_000, ms: 1, continued })

function setup() {
  const generation = new InputGeneration()
  const transcribe = vi.fn<(s: TranscriptSegment, token: { signal: AbortSignal }) => Promise<{ text: string } | null>>()
  const onFinal = vi.fn()
  const accumulator = new SegmentAccumulator(transcribe, { token: () => generation.request(), onPartial: vi.fn(), onFinal })
  return { generation, transcribe, onFinal, accumulator }
}

describe('segmented transcription', () => {
  it('retains the first segment after its request finishes, then appends the tail', async () => {
    const { accumulator, transcribe, onFinal } = setup()
    transcribe.mockResolvedValueOnce({ text: 'one' }).mockResolvedValueOnce({ text: 'two' })
    await accumulator.push(segment(true))
    expect(onFinal).not.toHaveBeenCalled()
    await accumulator.push(segment())
    expect(onFinal.mock.calls).toEqual([['one two']])
  })
  it('appends eager tail to earlier segments', async () => {
    const { accumulator, transcribe, onFinal } = setup()
    transcribe.mockResolvedValueOnce({ text: 'one' })
    await accumulator.push(segment(true))
    await accumulator.push(segment(), Promise.resolve({ text: 'two' }))
    expect(onFinal).toHaveBeenCalledWith('one two')
    expect(transcribe).toHaveBeenCalledTimes(1)
  })
  it('aborts in-flight work and drops queued segments on reset', async () => {
    const { accumulator, generation, transcribe, onFinal } = setup()
    let resolve!: (result: { text: string }) => void
    transcribe.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const first = accumulator.push(segment(true))
    const last = accumulator.push(segment())
    await Promise.resolve()
    const signal = transcribe.mock.calls[0][1].signal
    generation.invalidate()
    accumulator.clear()
    resolve({ text: 'stale' })
    await Promise.all([first, last])
    expect(signal.aborted).toBe(true)
    expect(onFinal).not.toHaveBeenCalled()
    expect(transcribe).toHaveBeenCalledTimes(1)
    transcribe.mockResolvedValueOnce({ text: 'fresh' })
    await accumulator.push(segment())
    expect(onFinal.mock.calls).toEqual([['fresh']])
  })
})

it('publishes only complete playback words', () => {
  expect(playbackCaption('one two three', 8)).toBe('one two')
  expect(playbackCaption('one two three', 10)).toBe('one two')
  expect(playbackCaption('one two three', 13)).toBe('one two three')
})
it('recognizes IME confirmation keys', () => {
  expect(isComposingKey({ isComposing: true })).toBe(true)
  expect(isComposingKey({ keyCode: 229 })).toBe(true)
  expect(isComposingKey({ isComposing: false, keyCode: 13 })).toBe(false)
})
