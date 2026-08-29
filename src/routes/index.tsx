import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowUp,
  AudioLines,
  Mic,
  RotateCcw,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiErrorBody, ChatRole } from '../lib/openrouter'

export const Route = createFileRoute('/')({
  component: HomePage,
})

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking'

interface Message {
  id: string
  role: ChatRole
  content: string
  createdAt: string
  pending?: boolean
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

const STORAGE_KEY = 'gideon-conversation-v1'

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'assistant',
  content:
    "I'm here. Talk to me, type a thought, or choose a starting point below. What is on your mind?",
  createdAt: 'Ready now',
}

const STARTERS = [
  'Help me untangle a decision',
  'Teach me something surprising',
  'Plan the rest of my day',
]

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function timeLabel() {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date())
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

async function readError(response: Response) {
  try {
    const body = (await response.json()) as ApiErrorBody
    return body.error?.message || 'The request could not be completed.'
  } catch {
    return 'The request could not be completed.'
  }
}

function deltaText(data: unknown) {
  if (!data || typeof data !== 'object') return ''
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return ''
  const content = choices[0]?.delta?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('')
  }
  return ''
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
      // Non-JSON provider metadata is safe to ignore.
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

function VoiceAperture({ phase }: { phase: Phase }) {
  return (
    <div className="voice-aperture" data-phase={phase} aria-hidden="true">
      <div className="aperture-halo" />
      <div className="aperture-ring aperture-ring-outer" />
      <div className="aperture-ring aperture-ring-inner" />
      <div className="aperture-core">
        {Array.from({ length: 17 }, (_, index) => (
          <span
            className="aperture-bar"
            key={index}
            style={{ '--bar-index': index } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  )
}

function HomePage() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE])
  const [draft, setDraft] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [voiceEnabled, setVoiceEnabled] = useState(true)
  const [speechSupported, setSpeechSupported] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [retryText, setRetryText] = useState<string | null>(null)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [lastLatency, setLastLatency] = useState<number | null>(null)
  const [hydrated, setHydrated] = useState(false)

  const transcriptRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)

  const isWorking = phase === 'thinking' || phase === 'listening'
  const visibleModel = useMemo(
    () => config?.chatModel.split('/').at(-1)?.replace(':free', '') || 'checking',
    [config],
  )

  useEffect(() => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    setSpeechSupported(Boolean(Recognition))

    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length && parsed.every(isStoredMessage)) {
          setMessages(parsed.slice(-40))
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
  }, [])

  useEffect(() => {
    if (!hydrated) return
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(messages.filter((message) => !message.pending).slice(-40)),
    )
  }, [hydrated, messages])

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: phase === 'thinking' ? 'smooth' : 'auto',
    })
  }, [messages, liveTranscript, phase])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`
  }, [draft])

  useEffect(
    () => () => {
      abortRef.current?.abort()
      recognitionRef.current?.abort()
      audioRef.current?.pause()
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    },
    [],
  )

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
    setPhase((current) => (current === 'speaking' ? 'idle' : current))
  }

  async function speak(text: string) {
    if (!voiceEnabled || !text.trim()) return
    stopAudio()

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
      audioUrlRef.current = url
      audioRef.current = audio
      audio.onplay = () => setPhase('speaking')
      audio.onended = stopAudio
      audio.onerror = () => {
        stopAudio()
        setNotice('The spoken reply could not be played. The text is still here.')
      }
      await audio.play()
    } catch (error) {
      stopAudio()
      setNotice(
        error instanceof Error
          ? error.message
          : 'The spoken reply could not be generated.',
      )
    }
  }

  async function sendMessage(rawText: string) {
    const text = rawText.trim()
    if (!text || isWorking) return

    stopAudio()
    setNotice(null)
    setRetryText(null)
    setDraft('')
    setLiveTranscript('')

    const userMessage: Message = {
      id: makeId(),
      role: 'user',
      content: text,
      createdAt: timeLabel(),
    }
    const assistantId = makeId()
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: timeLabel(),
      pending: true,
    }
    const context = [...messages, userMessage]

    setMessages([...context, assistantMessage])
    setPhase('thinking')
    const controller = new AbortController()
    abortRef.current = controller
    const startedAt = performance.now()
    let receivedFirstToken = false

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
        if (!receivedFirstToken) {
          receivedFirstToken = true
          setLastLatency(Math.max(1, Math.round(performance.now() - startedAt)))
        }
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, content: message.content + delta }
              : message,
          ),
        )
      })

      if (!completeText.trim()) {
        throw new Error('The model returned an empty reply. Try that again.')
      }

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, pending: false } : message,
        ),
      )
      setPhase('idle')
      await speak(completeText)
    } catch (error) {
      setMessages((current) => current.filter((message) => message.id !== assistantId))
      if ((error as Error).name !== 'AbortError') {
        setNotice(error instanceof Error ? error.message : 'The reply was interrupted.')
        setRetryText(text)
      }
      setPhase('idle')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  function toggleListening() {
    if (phase === 'listening') {
      recognitionRef.current?.stop()
      return
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) {
      setSpeechSupported(false)
      setNotice('Live speech input is not supported in this browser. Type below or use Chrome or Edge.')
      textareaRef.current?.focus()
      return
    }

    stopAudio()
    setNotice(null)
    setLiveTranscript('')
    let finalText = ''
    let recognitionFailed = false
    const recognition = new Recognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'

    recognition.onresult = (event) => {
      let interimText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result.isFinal) finalText += `${result[0].transcript} `
        else interimText += result[0].transcript
      }
      const visibleText = `${finalText}${interimText}`.trim()
      setLiveTranscript(visibleText)
      setDraft(visibleText)
    }
    recognition.onerror = (event) => {
      recognitionFailed = true
      const messagesByError: Record<string, string> = {
        'not-allowed': 'Microphone access was blocked. Allow it for localhost, then try again.',
        'audio-capture': 'No working microphone was found. Check your input device.',
        network: 'Speech recognition lost its connection. You can keep typing instead.',
        'no-speech': 'I did not hear anything. Tap the microphone when you are ready.',
      }
      setNotice(messagesByError[event.error] || 'Speech recognition stopped unexpectedly.')
    }
    recognition.onend = () => {
      recognitionRef.current = null
      setPhase('idle')
      const spokenText = finalText.trim()
      setLiveTranscript('')
      if (!recognitionFailed && spokenText) void sendMessage(spokenText)
    }

    recognitionRef.current = recognition
    setPhase('listening')
    try {
      recognition.start()
    } catch {
      recognitionRef.current = null
      setPhase('idle')
      setNotice('The microphone could not start. Wait a moment and try again.')
    }
  }

  function stopInteraction() {
    if (phase === 'listening') recognitionRef.current?.stop()
    if (phase === 'thinking') abortRef.current?.abort()
    if (phase === 'speaking') stopAudio()
  }

  function newConversation() {
    stopInteraction()
    setMessages([WELCOME_MESSAGE])
    setDraft('')
    setNotice(null)
    setRetryText(null)
    setLastLatency(null)
    localStorage.removeItem(STORAGE_KEY)
    textareaRef.current?.focus()
  }

  function toggleVoice() {
    if (voiceEnabled) stopAudio()
    setVoiceEnabled((current) => !current)
  }

  const phaseCopy = {
    idle: 'Ready when you are',
    listening: 'Listening closely',
    thinking: 'Forming a reply',
    speaking: 'Speaking with you',
  }[phase]

  return (
    <main className="gideon-shell">
      <aside className="presence-rail" aria-label="GIDEON status">
        <header className="brand-lockup">
          <div>
            <p className="eyebrow">Conversational intelligence</p>
            <h1>GIDEON</h1>
          </div>
          <span
            className={`connection-dot ${config?.configured ? 'is-online' : ''}`}
            title={config?.configured ? 'OpenRouter connected' : 'OpenRouter key needed'}
          />
        </header>

        <section className="presence-stage" aria-live="polite">
          <VoiceAperture phase={phase} />
          <div className="phase-copy">
            <span className="phase-kicker">{phase === 'idle' ? 'Standing by' : 'Live'}</span>
            <strong>{phaseCopy}</strong>
            {phase === 'listening' && liveTranscript ? (
              <span className="heard-text">“{liveTranscript}”</span>
            ) : (
              <span className="phase-detail">
                {voiceEnabled ? 'Voice replies are on' : 'Text replies only'}
              </span>
            )}
          </div>
        </section>

        <dl className="session-facts">
          <div>
            <dt>Conversation</dt>
            <dd>{visibleModel}</dd>
          </div>
          <div>
            <dt>Voice</dt>
            <dd>Fish S2.1 · free</dd>
          </div>
          <div>
            <dt>First response</dt>
            <dd>{lastLatency ? `${(lastLatency / 1000).toFixed(1)} s` : '—'}</dd>
          </div>
        </dl>

        <button className="new-chat-button" type="button" onClick={newConversation}>
          <RotateCcw size={15} aria-hidden="true" />
          New conversation
        </button>
      </aside>

      <section className="conversation-panel" aria-label="Conversation">
        <header className="conversation-header">
          <div className="mobile-brand">
            <span className="mobile-mark">G</span>
            <div>
              <strong>GIDEON</strong>
              <span>{phaseCopy}</span>
            </div>
          </div>
          <div className="conversation-title">
            <p className="eyebrow">Current exchange</p>
            <h2>A place to think out loud</h2>
          </div>
          <div className="header-actions">
            <button
              className={`icon-button voice-toggle ${voiceEnabled ? 'is-active' : ''}`}
              type="button"
              onClick={toggleVoice}
              aria-label={voiceEnabled ? 'Turn voice replies off' : 'Turn voice replies on'}
              aria-pressed={voiceEnabled}
            >
              {voiceEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
              <span>{voiceEnabled ? 'Voice on' : 'Voice off'}</span>
            </button>
            <button
              className="icon-button mobile-clear"
              type="button"
              onClick={newConversation}
              aria-label="Start a new conversation"
            >
              <Trash2 size={18} />
            </button>
          </div>
        </header>

        {config && !config.configured ? (
          <div className="config-banner" role="status">
            <span className="config-pulse" />
            <div>
              <strong>One local step remains</strong>
              <span>
                Copy <code>.env.example</code> to <code>.env</code>, add your OpenRouter key,
                then restart the server.
              </span>
            </div>
          </div>
        ) : null}

        <div className="transcript" ref={transcriptRef}>
          <div className="message-stack">
            {messages.map((message) => (
              <article
                className={`message message-${message.role} ${message.pending ? 'is-pending' : ''}`}
                key={message.id}
              >
                <div className="message-meta">
                  <span>{message.role === 'assistant' ? 'GIDEON' : 'YOU'}</span>
                  <time>{message.createdAt}</time>
                </div>
                <div className="message-bubble">
                  {message.content ? (
                    <p>{message.content}</p>
                  ) : (
                    <span className="typing-indicator" aria-label="GIDEON is replying">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              </article>
            ))}

            {messages.length === 1 ? (
              <div className="starter-group" aria-label="Conversation starters">
                <p>Begin somewhere</p>
                <div>
                  {STARTERS.map((starter) => (
                    <button
                      type="button"
                      key={starter}
                      onClick={() => void sendMessage(starter)}
                    >
                      <span>{starter}</span>
                      <ArrowUp size={15} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {notice ? (
              <div className="notice-card" role="alert">
                <div>
                  <strong>The conversation paused</strong>
                  <p>{notice}</p>
                </div>
                <div className="notice-actions">
                  {retryText ? (
                    <button type="button" onClick={() => void sendMessage(retryText)}>
                      Try again
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="dismiss-notice"
                    onClick={() => setNotice(null)}
                    aria-label="Dismiss message"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <footer className="composer-zone">
          <div className={`composer ${phase === 'listening' ? 'is-listening' : ''}`}>
            <button
              type="button"
              className="talk-button"
              onClick={toggleListening}
              disabled={phase === 'thinking'}
              aria-label={phase === 'listening' ? 'Stop listening' : 'Talk to GIDEON'}
              title={speechSupported ? 'Talk to GIDEON' : 'Speech input needs Chrome or Edge'}
            >
              {phase === 'listening' ? <Square size={17} fill="currentColor" /> : <Mic size={20} />}
              <span>{phase === 'listening' ? 'Finish' : 'Talk'}</span>
            </button>

            <label className="sr-only" htmlFor="message-input">
              Message GIDEON
            </label>
            <textarea
              id="message-input"
              ref={textareaRef}
              value={draft}
              rows={1}
              maxLength={8000}
              placeholder={phase === 'listening' ? 'I’m listening…' : 'Say what’s on your mind…'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage(draft)
                }
              }}
              disabled={phase === 'thinking'}
            />

            {phase === 'thinking' || phase === 'speaking' ? (
              <button
                type="button"
                className="send-button stop-button"
                onClick={stopInteraction}
                aria-label={phase === 'thinking' ? 'Stop response' : 'Stop speaking'}
              >
                <Square size={16} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                onClick={() => void sendMessage(draft)}
                disabled={!draft.trim() || phase === 'listening'}
                aria-label="Send message"
              >
                <ArrowUp size={19} strokeWidth={2.4} />
              </button>
            )}
          </div>

          <div className="composer-footnote">
            <span>
              {speechSupported ? (
                <><Mic size={12} /> Speech input available</>
              ) : (
                <><AudioLines size={12} /> Type to chat in this browser</>
              )}
            </span>
            <span>Enter to send · Shift + Enter for a new line</span>
          </div>
        </footer>
      </section>
    </main>
  )
}
