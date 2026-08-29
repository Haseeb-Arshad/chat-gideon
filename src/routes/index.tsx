import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowUp,
  AudioLines,
  Mic,
  MicOff,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ApiErrorBody, ChatRole } from '../lib/openrouter'

export const Route = createFileRoute('/')({
  component: HomePage,
})

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused'
type VoiceMode = 'active' | 'paused' | 'muted'
type Emotion = 'neutral' | 'curious' | 'focused' | 'happy' | 'concerned'

interface Message {
  id: string
  role: ChatRole
  content: string
  createdAt: string
}

interface PublicConfig {
  configured: boolean
  chatModel: string
  voiceModel: string
}

interface BrowserSpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number
  results: ArrayLike<{
    isFinal: boolean
    0: { transcript: string }
  }>
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

const STORAGE_KEY = 'gideon-conversation-v2'
const SILENCE_LIMIT_MS = 30_000

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'assistant',
  content: "Hey, I'm GIDEON. I'm listening.",
  createdAt: 'now',
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function isStoredMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<Message>
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    typeof message.createdAt === 'string'
  )
}

function deriveEmotion(text: string): Emotion {
  const value = text.toLowerCase()
  if (/\b(ha|haha|hehe|lol|love|lovely|delight|wonderful|amazing|awesome|great|good|glad|happy|funny|joy|joke|laugh|smile|flattered)\b/.test(value)) {
    return 'happy'
  }
  if (/\b(sorry|sad|hurt|hard|difficult|afraid|worried|loss|unfortunately)\b/.test(value)) {
    return 'concerned'
  }
  if (value.includes('?') || /\b(why|how|wonder|curious|maybe)\b/.test(value)) {
    return 'curious'
  }
  return 'neutral'
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as ApiErrorBody
    return body.error?.message || 'That connection did not complete.'
  } catch {
    return 'That connection did not complete.'
  }
}

function deltaText(data: unknown) {
  if (!data || typeof data !== 'object') return ''
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return ''
  const content = choices[0]?.delta?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? String((part as { text: unknown }).text)
        : '',
    )
    .join('')
}

async function consumeOpenRouterStream(
  response: Response,
  onDelta: (delta: string) => void,
) {
  if (!response.body) throw new Error('The response stream was empty.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completeText = ''

  const processLine = (line: string) => {
    if (!line.startsWith('data:')) return false
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return payload === '[DONE]'

    try {
      const delta = deltaText(JSON.parse(payload))
      if (delta) {
        completeText += delta
        onDelta(delta)
      }
    } catch {
      // Provider comments and metadata are not part of the visible response.
    }
    return false
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (processLine(line)) return completeText
    }
    if (done) break
  }

  if (buffer) processLine(buffer)
  return completeText
}

function LivingEyes({ phase, emotion }: { phase: Phase; emotion: Emotion }) {
  return (
    <div className="living-eyes" data-phase={phase} data-emotion={emotion} aria-hidden="true">
      <div className="eye eye-left">
        <div className="eye-surface">
          <div className="iris">
            <div className="iris-light" />
            <div className="pupil" />
            <div className="eye-glint" />
          </div>
          <div className="upper-lid" />
        </div>
        <div className="happy-arc" />
        <div className="brow" />
      </div>
      <div className="eye eye-right">
        <div className="eye-surface">
          <div className="iris">
            <div className="iris-light" />
            <div className="pupil" />
            <div className="eye-glint" />
          </div>
          <div className="upper-lid" />
        </div>
        <div className="happy-arc" />
        <div className="brow" />
      </div>
      <div className="laugh-mark laugh-mark-left">✦</div>
      <div className="laugh-mark laugh-mark-right">✦</div>
    </div>
  )
}

function HomePage() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE])
  const [draft, setDraft] = useState('')
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [voiceMode, setVoiceModeState] = useState<VoiceMode>('active')
  const [emotion, setEmotion] = useState<Emotion>('neutral')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [assistantCaption, setAssistantCaption] = useState(WELCOME_MESSAGE.content)
  const [userCaption, setUserCaption] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [retryText, setRetryText] = useState<string | null>(null)
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [speechSupported, setSpeechSupported] = useState(true)
  const [hydrated, setHydrated] = useState(false)

  const stageRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const phaseRef = useRef<Phase>('idle')
  const voiceModeRef = useRef<VoiceMode>('active')
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const suppressRecognitionRestartRef = useRef(false)
  const silenceDeadlineRef = useRef(0)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const startListeningRef = useRef<(preserveDeadline?: boolean) => void>(() => undefined)

  function setPhase(next: Phase) {
    phaseRef.current = next
    setPhaseState(next)
  }

  function setVoiceMode(next: VoiceMode) {
    voiceModeRef.current = next
    setVoiceModeState(next)
  }

  function clearSilenceTimer() {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
    silenceTimerRef.current = null
  }

  function stopRecognition(suppressRestart = true) {
    if (!recognitionRef.current) return
    suppressRecognitionRestartRef.current = suppressRestart
    recognitionRef.current.stop()
  }

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
  }

  function pauseForSilence() {
    setVoiceMode('paused')
    setPhase('paused')
    setLiveTranscript('')
    clearSilenceTimer()
    if (recognitionRef.current) {
      suppressRecognitionRestartRef.current = true
      recognitionRef.current.stop()
    }
  }

  function armSilenceTimer(resetDeadline: boolean) {
    clearSilenceTimer()
    if (resetDeadline) silenceDeadlineRef.current = Date.now() + SILENCE_LIMIT_MS
    const remaining = Math.max(0, silenceDeadlineRef.current - Date.now())
    silenceTimerRef.current = setTimeout(pauseForSilence, remaining)
  }

  useEffect(() => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    setSpeechSupported(Boolean(Recognition))
    if (!Recognition) setVoiceMode('muted')

    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length && parsed.every(isStoredMessage)) {
          const restored = parsed.slice(-40)
          setMessages(restored)
          const lastAssistant = [...restored].reverse().find((message) => message.role === 'assistant')
          const lastUser = [...restored].reverse().find((message) => message.role === 'user')
          if (lastAssistant) {
            setAssistantCaption(lastAssistant.content)
            setEmotion(deriveEmotion(lastAssistant.content))
          }
          if (lastUser) setUserCaption(lastUser.content)
        }
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
    setHydrated(true)

    void fetch('/api/config')
      .then((response) => response.json())
      .then((data: PublicConfig) => setConfig(data))
      .catch(() => setConfig(null))

    if (Recognition) {
      autoStartTimerRef.current = setTimeout(() => startListeningRef.current(false), 900)
    }

    return () => {
      if (autoStartTimerRef.current) clearTimeout(autoStartTimerRef.current)
      clearSilenceTimer()
      abortRef.current?.abort()
      recognitionRef.current?.abort()
      stopAudio()
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)))
  }, [hydrated, messages])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 112)}px`
  }, [draft])

  async function speak(text: string) {
    if (voiceModeRef.current !== 'active' || !text.trim()) {
      setPhase('idle')
      return
    }

    stopAudio()
    setPhase('speaking')
    try {
      const response = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!response.ok) throw new Error(await readError(response))

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio
      audioUrlRef.current = url
      audio.onended = () => {
        stopAudio()
        setPhase('idle')
        if (voiceModeRef.current === 'active') {
          setTimeout(() => startListeningRef.current(false), 260)
        }
      }
      audio.onerror = () => {
        stopAudio()
        setPhase('idle')
        setNotice('The voice could not play, but the reply is here.')
        if (voiceModeRef.current === 'active') {
          setTimeout(() => startListeningRef.current(false), 260)
        }
      }
      await audio.play()
    } catch (error) {
      stopAudio()
      setPhase('idle')
      setNotice(error instanceof Error ? error.message : 'The voice could not be generated.')
      if (voiceModeRef.current === 'active') {
        setTimeout(() => startListeningRef.current(false), 260)
      }
    }
  }

  async function sendMessage(rawText: string) {
    const text = rawText.trim()
    if (!text || phaseRef.current === 'thinking') return

    clearSilenceTimer()
    stopRecognition(true)
    stopAudio()
    setNotice(null)
    setRetryText(null)
    setDraft('')
    setLiveTranscript('')
    setUserCaption(text)
    setAssistantCaption('')
    setEmotion(deriveEmotion(text) === 'concerned' ? 'concerned' : 'focused')
    setPhase('thinking')

    const userMessage: Message = {
      id: makeId(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    const context = [...messages, userMessage]
    setMessages(context)

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: context.map(({ role, content }) => ({ role, content })),
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(await readError(response))

      const completeText = await consumeOpenRouterStream(response, (delta) => {
        setAssistantCaption((current) => current + delta)
      })
      if (!completeText.trim()) throw new Error('I lost that thought. Ask me once more.')

      const assistantMessage: Message = {
        id: makeId(),
        role: 'assistant',
        content: completeText,
        createdAt: new Date().toISOString(),
      }
      setMessages([...context, assistantMessage])
      setEmotion(deriveEmotion(`${text} ${completeText}`))
      await speak(completeText)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        const message = error instanceof Error ? error.message : 'The reply was interrupted.'
        setNotice(message)
        setRetryText(text)
        setAssistantCaption('I lost the connection for a moment.')
        setEmotion('concerned')
      }
      setPhase('idle')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  function startListening(preserveDeadline = false) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) {
      setSpeechSupported(false)
      setVoiceMode('muted')
      setPhase('idle')
      setNotice('Live voice needs Chrome or Edge. You can still type below.')
      return
    }
    if (phaseRef.current === 'thinking' || phaseRef.current === 'speaking') return
    if (recognitionRef.current) return

    setVoiceMode('active')
    setPhase('listening')
    setNotice(null)
    setLiveTranscript('')
    suppressRecognitionRestartRef.current = false
    if (!preserveDeadline) silenceDeadlineRef.current = Date.now() + SILENCE_LIMIT_MS
    armSilenceTimer(false)

    let finalText = ''
    let failed = false
    let silentEnd = false
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'

    recognition.onresult = (event) => {
      let interimText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcript = result[0].transcript
        if (result.isFinal) finalText += `${transcript} `
        else interimText += transcript
      }

      const visibleText = `${finalText}${interimText}`.trim()
      if (visibleText) {
        armSilenceTimer(true)
        setLiveTranscript(visibleText)
        setUserCaption(visibleText)
        setEmotion(deriveEmotion(visibleText) === 'happy' ? 'happy' : 'curious')
      }

      if (finalText.trim()) recognition.stop()
    }

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') {
        silentEnd = true
        return
      }
      failed = true
      const messagesByError: Record<string, string> = {
        'not-allowed': 'Tap Resume voice and allow microphone access to start talking.',
        'audio-capture': 'No working microphone was found. Check your input device.',
        network: 'Voice recognition lost its connection. Tap to resume.',
      }
      setNotice(messagesByError[event.error] || 'Voice recognition paused. Tap to resume.')
    }

    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null
      const spokenText = finalText.trim()
      const suppressed = suppressRecognitionRestartRef.current
      suppressRecognitionRestartRef.current = false

      if (spokenText && !failed) {
        clearSilenceTimer()
        void sendMessage(spokenText)
        return
      }
      if (suppressed) return

      if (
        (silentEnd || !failed) &&
        voiceModeRef.current === 'active' &&
        Date.now() < silenceDeadlineRef.current
      ) {
        setTimeout(() => startListeningRef.current(true), 220)
        return
      }

      clearSilenceTimer()
      if (voiceModeRef.current === 'active') {
        setVoiceMode('paused')
        setPhase('paused')
      }
    }

    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      recognitionRef.current = null
      clearSilenceTimer()
      setVoiceMode('paused')
      setPhase('paused')
      setNotice('Tap Resume voice to give the microphone another try.')
    }
  }

  startListeningRef.current = startListening

  function handleVoiceControl() {
    if (voiceModeRef.current === 'active') {
      setVoiceMode('muted')
      clearSilenceTimer()
      stopRecognition(true)
      stopAudio()
      if (phaseRef.current !== 'thinking') setPhase('idle')
      setLiveTranscript('')
      return
    }

    setVoiceMode('active')
    setNotice(null)
    startListening(false)
  }

  function stopCurrentTurn() {
    abortRef.current?.abort()
    stopAudio()
    setPhase('idle')
    setAssistantCaption((current) => current || 'Stopped.')
    if (voiceModeRef.current === 'active') {
      setTimeout(() => startListeningRef.current(false), 220)
    }
  }

  function newConversation() {
    abortRef.current?.abort()
    clearSilenceTimer()
    stopRecognition(true)
    stopAudio()
    setMessages([WELCOME_MESSAGE])
    setAssistantCaption(WELCOME_MESSAGE.content)
    setUserCaption('')
    setEmotion('neutral')
    setNotice(null)
    setRetryText(null)
    setDraft('')
    localStorage.removeItem(STORAGE_KEY)
    if (voiceModeRef.current === 'active') {
      setPhase('idle')
      setTimeout(() => startListeningRef.current(false), 220)
    } else {
      setPhase(voiceModeRef.current === 'paused' ? 'paused' : 'idle')
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>) {
    const x = Math.max(-1, Math.min(1, (event.clientX / window.innerWidth - 0.5) * 2))
    const y = Math.max(-1, Math.min(1, (event.clientY / window.innerHeight - 0.5) * 2))
    stageRef.current?.style.setProperty('--gaze-x', x.toFixed(3))
    stageRef.current?.style.setProperty('--gaze-y', y.toFixed(3))
  }

  function resetGaze() {
    stageRef.current?.style.setProperty('--gaze-x', '0')
    stageRef.current?.style.setProperty('--gaze-y', '0')
  }

  const statusCopy = {
    idle: voiceMode === 'muted' ? 'Voice muted' : 'Here with you',
    listening: liveTranscript ? 'I hear you' : 'Listening…',
    thinking: 'Thinking with you…',
    speaking: 'Speaking',
    paused: 'Voice paused after 30 seconds of quiet',
  }[phase]

  const voiceControl =
    voiceMode === 'paused'
      ? { icon: <Play size={19} fill="currentColor" />, label: 'Resume voice', hint: 'Paused after 30s' }
      : voiceMode === 'muted'
        ? { icon: <MicOff size={19} />, label: 'Voice muted', hint: 'Tap to resume' }
        : phase === 'speaking'
          ? { icon: <AudioLines size={20} />, label: 'Speaking', hint: 'Tap to mute' }
          : phase === 'thinking'
            ? { icon: <Sparkles size={19} />, label: 'Thinking', hint: 'Tap to mute' }
            : { icon: <Mic size={20} />, label: phase === 'listening' ? 'Listening' : 'Voice live', hint: 'Tap to mute' }

  return (
    <main
      className="presence-shell"
      ref={stageRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetGaze}
    >
      <div className="ambient-field" aria-hidden="true">
        <span className="ambient-orbit orbit-one" />
        <span className="ambient-orbit orbit-two" />
        <span className="ambient-grain" />
      </div>

      <div className="floating-brand" aria-label="GIDEON">
        <span className="brand-seed" />
        <span>GIDEON</span>
      </div>

      <button className="reset-button" type="button" onClick={newConversation} aria-label="New conversation">
        <RotateCcw size={17} />
        <span>New</span>
      </button>

      {config && !config.configured ? (
        <div className="setup-note" role="status">
          Add the local OpenRouter key, then restart GIDEON.
        </div>
      ) : null}

      <section className="agent-presence" aria-label="GIDEON voice presence">
        <LivingEyes phase={phase} emotion={emotion} />
        <div className="presence-status" aria-live="polite">
          <span className="status-dot" />
          {statusCopy}
        </div>

        <div className="live-captions" aria-live="polite" aria-atomic="false">
          {userCaption ? (
            <p className="user-caption">
              <span>You</span>
              {userCaption}
            </p>
          ) : null}
          <p className={`assistant-caption ${phase === 'thinking' && !assistantCaption ? 'is-thinking' : ''}`}>
            {assistantCaption || <span className="thought-pulse">•••</span>}
          </p>
        </div>
      </section>

      <section className="voice-dock" aria-label="Voice and text controls">
        {notice ? (
          <div className="inline-notice" role="alert">
            <span>{notice}</span>
            {retryText ? (
              <button type="button" onClick={() => void sendMessage(retryText)}>
                Try again
              </button>
            ) : null}
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message">
              <X size={14} />
            </button>
          </div>
        ) : null}

        <div className="voice-action-row">
          <button
            type="button"
            className="voice-mode-button"
            data-mode={voiceMode}
            data-phase={phase}
            onClick={handleVoiceControl}
            aria-label={voiceMode === 'active' ? 'Mute voice mode' : 'Resume voice mode'}
            aria-pressed={voiceMode === 'active'}
          >
            <span className="voice-icon">{speechSupported ? voiceControl.icon : <MicOff size={19} />}</span>
            <span className="voice-label">
              <strong>{speechSupported ? voiceControl.label : 'Voice unavailable'}</strong>
              <small>{speechSupported ? voiceControl.hint : 'Type below'}</small>
            </span>
            <span className="voice-level" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
          </button>

          {phase === 'thinking' || phase === 'speaking' ? (
            <button type="button" className="stop-turn-button" onClick={stopCurrentTurn} aria-label="Stop current response">
              <Square size={15} fill="currentColor" />
            </button>
          ) : null}
        </div>

        <div className="text-composer">
          <label className="sr-only" htmlFor="message-input">Type to GIDEON</label>
          <textarea
            id="message-input"
            ref={textareaRef}
            value={draft}
            rows={1}
            maxLength={8000}
            placeholder="Or type something…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void sendMessage(draft)
              }
            }}
            disabled={phase === 'thinking'}
          />
          <button
            type="button"
            onClick={() => void sendMessage(draft)}
            disabled={!draft.trim() || phase === 'thinking'}
            aria-label="Send typed message"
          >
            <ArrowUp size={18} strokeWidth={2.5} />
          </button>
        </div>
      </section>
    </main>
  )
}
