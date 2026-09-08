/**
 * Microphone listener built on the browser Speech Recognition API.
 *
 * The API only marks a result `isFinal` after its own fairly generous silence
 * window, which was the single largest source of the "why is it still thinking"
 * delay. This wrapper endpoints on transcript *stability* instead: once the
 * interim text stops changing for a short, content-aware interval, the turn is
 * committed immediately. A finished sentence commits fastest; a hesitant
 * fragment is given more room.
 */

export interface ListenerHandlers {
  onInterim: (text: string) => void
  onCommit: (text: string) => void
  onError: (code: string, message: string) => void
  onSilenceTimeout: () => void
  onEnd: (reason: 'committed' | 'error' | 'stopped' | 'restart') => void
}

interface BrowserSpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

interface BrowserSpeechRecognitionErrorEvent {
  error: string
}

interface SpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

/** How long the transcript must hold still before the turn is sent. */
const SETTLED_SENTENCE_MS = 420
const SETTLED_PHRASE_MS = 700
const SETTLED_FRAGMENT_MS = 1_050

export const SILENCE_LIMIT_MS = 30_000

const ERROR_COPY: Record<string, string> = {
  'not-allowed': 'Allow microphone access, then tap Resume to start talking.',
  'service-not-allowed': 'Allow microphone access, then tap Resume to start talking.',
  'audio-capture': 'No working microphone was found. Check your input device.',
  network: 'Voice recognition lost its connection. Tap to resume.',
}

export function speechRecognitionSupported() {
  if (typeof window === 'undefined') return false
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

function settleDelay(text: string) {
  if (/[.!?]["')\]]?$/.test(text)) return SETTLED_SENTENCE_MS
  return text.trim().split(/\s+/).length >= 3 ? SETTLED_PHRASE_MS : SETTLED_FRAGMENT_MS
}

export class Listener {
  private recognition: BrowserSpeechRecognition | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private silenceDeadline = 0
  private committed = false
  private failed = false
  private stopping = false
  private finalText = ''
  private interimText = ''

  constructor(private readonly handlers: ListenerHandlers) {}

  get active() {
    return this.recognition !== null
  }

  /**
   * @param preserveDeadline keeps the running 30s quiet countdown when the
   * recogniser is simply being restarted mid-silence.
   */
  start(preserveDeadline = false) {
    if (this.recognition) return true

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) {
      this.handlers.onError('unsupported', 'Live voice needs Chrome or Edge. You can still type.')
      return false
    }

    this.committed = false
    this.failed = false
    this.stopping = false
    this.finalText = ''
    this.interimText = ''

    if (!preserveDeadline) this.silenceDeadline = Date.now() + SILENCE_LIMIT_MS
    this.armSilence()

    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.lang = navigator.language || 'en-US'

    recognition.onresult = (event) => {
      if (this.committed) return

      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcript = result[0].transcript
        if (result.isFinal) this.finalText += `${transcript} `
        else interim += transcript
      }
      this.interimText = interim

      const visible = `${this.finalText}${interim}`.replace(/\s+/g, ' ').trim()
      if (!visible) return

      this.silenceDeadline = Date.now() + SILENCE_LIMIT_MS
      this.armSilence()
      this.handlers.onInterim(visible)

      // A recogniser-confirmed final needs no further waiting.
      if (this.finalText.trim() && !interim) {
        this.commit(visible)
        return
      }
      this.scheduleSettle(visible)
    }

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      this.failed = true
      this.handlers.onError(
        event.error,
        ERROR_COPY[event.error] || 'Voice recognition paused. Tap to resume.',
      )
    }

    recognition.onend = () => {
      if (this.recognition === recognition) this.recognition = null
      this.clearSettle()

      if (this.committed) {
        this.handlers.onEnd('committed')
        return
      }
      if (this.failed) {
        this.clearSilence()
        this.handlers.onEnd('error')
        return
      }
      if (this.stopping) {
        this.clearSilence()
        this.handlers.onEnd('stopped')
        return
      }

      // A pending fragment survives the recogniser's own restart cycle.
      const pending = `${this.finalText}${this.interimText}`.replace(/\s+/g, ' ').trim()
      if (pending) {
        this.commit(pending)
        this.handlers.onEnd('committed')
        return
      }

      if (Date.now() < this.silenceDeadline) {
        this.handlers.onEnd('restart')
        return
      }
      this.clearSilence()
      this.handlers.onSilenceTimeout()
    }

    this.recognition = recognition
    try {
      recognition.start()
      return true
    } catch {
      this.recognition = null
      this.clearSilence()
      this.handlers.onError('start-failed', 'Tap Resume to give the microphone another try.')
      return false
    }
  }

  /** Stops without committing whatever has been heard so far. */
  stop() {
    this.stopping = true
    this.committed = true
    this.clearSettle()
    this.clearSilence()
    this.recognition?.stop()
  }

  abort() {
    this.stopping = true
    this.committed = true
    this.clearSettle()
    this.clearSilence()
    this.recognition?.abort()
    this.recognition = null
  }

  get silenceRemaining() {
    return Math.max(0, this.silenceDeadline - Date.now())
  }

  private commit(text: string) {
    if (this.committed) return
    this.committed = true
    this.clearSettle()
    this.clearSilence()
    this.handlers.onCommit(text)
    // Release the microphone; the caller decides when to listen again.
    try {
      this.recognition?.stop()
    } catch {
      // Already ending.
    }
  }

  private scheduleSettle(text: string) {
    this.clearSettle()
    this.settleTimer = setTimeout(() => this.commit(text), settleDelay(text))
  }

  private clearSettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
  }

  private armSilence() {
    this.clearSilence()
    this.silenceTimer = setTimeout(
      () => {
        if (this.committed) return
        this.stopping = true
        this.recognition?.stop()
        this.recognition = null
        this.handlers.onSilenceTimeout()
      },
      Math.max(0, this.silenceDeadline - Date.now()),
    )
  }

  private clearSilence() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = null
  }
}
