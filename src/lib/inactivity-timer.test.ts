import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInactivityTimer, VOICE_SILENCE_TIMEOUT_MS } from './inactivity-timer'

describe('createInactivityTimer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits five minutes before firing by default', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const timer = createInactivityTimer(onTimeout)

    timer.reset()
    vi.advanceTimersByTime(VOICE_SILENCE_TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('restarts the window when activity resets it', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const timer = createInactivityTimer(onTimeout, 1_000)

    timer.reset()
    vi.advanceTimersByTime(800)
    timer.reset()
    vi.advanceTimersByTime(999)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('can be cleared without firing', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const timer = createInactivityTimer(onTimeout, 1_000)

    timer.reset()
    timer.clear()
    vi.advanceTimersByTime(1_000)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
