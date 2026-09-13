export const VOICE_SILENCE_TIMEOUT_MS = 5 * 60_000

export interface InactivityTimer {
  reset: () => void
  clear: () => void
}

/** A restartable one-shot timer used for voice inactivity. */
export function createInactivityTimer(
  onTimeout: () => void,
  timeoutMs = VOICE_SILENCE_TIMEOUT_MS,
): InactivityTimer {
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  return {
    reset: () => {
      clear()
      timer = setTimeout(() => {
        timer = null
        onTimeout()
      }, timeoutMs)
    },
    clear,
  }
}
