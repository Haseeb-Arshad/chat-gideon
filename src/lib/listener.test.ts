import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Listener, SILENCE_LIMIT_MS } from './listener'

class Recognition {
  static latest: Recognition
  onend: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn()
  abort = vi.fn()
  constructor() { Recognition.latest = this }
}
function harness() {
  const handlers = {
    onInterim: vi.fn(), onCommit: vi.fn(), onError: vi.fn(),
    onSilenceTimeout: vi.fn(), onEnd: vi.fn(), onStable: vi.fn(),
  }
  return { listener: new Listener(handlers), handlers }
}
describe('Listener silence deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.stubGlobal('window', { SpeechRecognition: Recognition })
    vi.stubGlobal('navigator', { language: 'en-US' })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('starts a fresh valid deadline if preserve is requested on a new listener', async () => {
    const { listener, handlers } = harness()
    expect(listener.start(true)).toBe(true)
    expect(listener.silenceRemaining).toBe(SILENCE_LIMIT_MS)
    await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS - 1)
    expect(handlers.onSilenceTimeout).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(handlers.onSilenceTimeout).toHaveBeenCalledTimes(1)
    listener.abort()
  })

  it('preserves the original deadline through recognizer restarts and scheduling delay', async () => {
    const { listener, handlers } = harness()
    listener.start()
    await vi.advanceTimersByTimeAsync(12_000)
    Recognition.latest.onend?.()
    expect(handlers.onEnd).toHaveBeenLastCalledWith('restart')
    expect(listener.active).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    listener.start(true)
    expect(listener.silenceRemaining).toBe(17_500)
    await vi.advanceTimersByTimeAsync(17_500)
    expect(handlers.onSilenceTimeout).toHaveBeenCalledTimes(1)
    listener.abort()
  })

  it('does not revive an expired deadline when preserving but resets on explicit fresh start', async () => {
    const { listener, handlers } = harness()
    listener.start()
    listener.abort()
    await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS + 1)
    listener.start(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(handlers.onSilenceTimeout).toHaveBeenCalledTimes(1)
    listener.abort()
    listener.start(false)
    expect(listener.silenceRemaining).toBe(SILENCE_LIMIT_MS)
    listener.abort()
  })
})
