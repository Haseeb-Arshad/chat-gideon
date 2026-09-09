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
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatRole } from '../lib/openrouter'
import { Listener, speechRecognitionSupported } from '../lib/listener'
import {
  NEUTRAL_MOOD,
  type EyeEmotion,
  type Mood,
  SPEAKER_WEIGHT,
  blendMood,
  deriveEmotion,
  emotionForTurn,
  nudgeMood,
  scoreText,
} from '../lib/mood'
import { RealtimeLink } from '../lib/realtime-client'
import { VoiceQueue } from '../lib/voice-queue'
import { EmotionField } from './EmotionField'
import { GideonEyes, type EyePhase } from './GideonEyes'

/**
 * `replying` is the state between the first streamed token and audible playback.
 * Voice turns reveal the caption from playback progress, so the text and voice
 * share one timeline. Muted turns still receive the text immediately.
 */
type Phase = 'idle' | 'listening' | 'thinking' | 'replying' | 'speaking' | 'paused'
type VoiceMode = 'active' | 'paused' | 'muted'

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

const STORAGE_KEY = 'gideon-conversation-v2'

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'assistant',
  content: "Hey, I'm GIDEON. I'm listening.",
  createdAt: 'now',
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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

/** The face has no separate `replying` pose; it reads as the speaking one. */
function eyePhaseFor(phase: Phase): EyePhase {
  return phase === 'replying' ? 'speaking' : phase
}

function LivingPresence({
  phase,
  emotion,
  levelRef,
}: {
  phase: Phase
  emotion: EyeEmotion
  levelRef: React.RefObject<number>
}) {
  return (
    <div className="robot-presence" data-phase={phase} data-emotion={emotion} aria-hidden="true">
      <GideonEyes phase={eyePhaseFor(phase)} emotion={emotion} levelRef={levelRef} />
    </div>
  )
}

export function AgentPage() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE])
  const [draft, setDraft] = useState('')
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [voiceMode, setVoiceModeState] = useState<VoiceMode>('active')
  const [emotion, setEmotion] = useState<EyeEmotion>('neutral')
  /**
   * The running feel of the conversation, which is a different question from
   * the pose the eyes are holding right now: the room keeps the colour of what
   * has been said for a while, the face only reacts to the last thing.
   */
  const [mood, setMood] = useState<Mood>(NEUTRAL_MOOD)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [assistantCaption, setAssistantCaption] = useState(WELCOME_MESSAGE.content)
  const [spokenChars, setSpokenChars] = useState(WELCOME_MESSAGE.content.length)
  const [captionTurn, setCaptionTurn] = useState(0)
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
  const messagesRef = useRef<Message[]>([WELCOME_MESSAGE])
  const linkRef = useRef<RealtimeLink | null>(null)
  const listenerRef = useRef<Listener | null>(null)
  const voiceRef = useRef<VoiceQueue | null>(null)
  const turnRef = useRef<{ cancel: () => void } | null>(null)
  const levelRef = useRef(0)
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startListeningRef = useRef<(preserveDeadline?: boolean) => void>(() => undefined)

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  const setVoiceMode = useCallback((next: VoiceMode) => {
    voiceModeRef.current = next
    setVoiceModeState(next)
  }, [])

  const scheduleListen = useCallback((delay: number, preserveDeadline = false) => {
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
    restartTimerRef.current = setTimeout(() => startListeningRef.current(preserveDeadline), delay)
  }, [])

  /** Fold one utterance into the running mood. */
  const feel = useCallback((text: string, weight = 1) => {
    setMood((current) => blendMood(current, scoreText(text), weight))
  }, [])

  const stopVoice = useCallback(() => {
    voiceRef.current?.cancel()
    voiceRef.current = null
    levelRef.current = 0
  }, [])

  // -- Realtime link -------------------------------------------------------

  useEffect(() => {
    const link = new RealtimeLink({ onConfig: (next) => setConfig(next) })
    linkRef.current = link
    link.connect()

    // The HTTP fallback never receives a `ready` frame, so config is fetched
    // directly; that request doubles as an upstream warm-up on the server.
    void fetch('/api/config')
      .then((response) => response.json())
      .then((data: PublicConfig) => setConfig((current) => current ?? data))
      .catch(() => undefined)

    return () => {
      link.dispose()
      linkRef.current = null
    }
  }, [])

  // -- Restore and persist -------------------------------------------------

  useEffect(() => {
    const supported = speechRecognitionSupported()
    setSpeechSupported(supported)
    if (!supported) setVoiceMode('muted')

    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length && parsed.every(isStoredMessage)) {
          const restored = parsed.slice(-40) as Message[]
          setMessages(restored)
          messagesRef.current = restored
          const lastAssistant = [...restored].reverse().find((m) => m.role === 'assistant')
          const lastUser = [...restored].reverse().find((m) => m.role === 'user')
          if (lastAssistant) {
            setAssistantCaption(lastAssistant.content)
            setSpokenChars(lastAssistant.content.length)
            setEmotion(deriveEmotion(lastAssistant.content))
          }
          if (lastUser) setUserCaption(lastUser.content)
          setMood(
            restored.reduce(
              (acc, message) =>
                blendMood(acc, scoreText(message.content), SPEAKER_WEIGHT[message.role]),
              NEUTRAL_MOOD,
            ),
          )
        }
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
    setHydrated(true)

    if (supported) scheduleListen(600)

    return () => {
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
      listenerRef.current?.abort()
      turnRef.current?.cancel()
      voiceRef.current?.cancel()
    }
  }, [scheduleListen, setVoiceMode])

  useEffect(() => {
    if (!hydrated) return
    messagesRef.current = messages
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)))
  }, [hydrated, messages])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 112)}px`
  }, [draft])

  // -- One turn ------------------------------------------------------------

  const sendMessage = useCallback(
    (rawText: string) => {
      const text = rawText.trim()
      if (!text) return

      const link = linkRef.current
      if (!link) return

      listenerRef.current?.abort()
      listenerRef.current = null
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
      turnRef.current?.cancel()
      stopVoice()

      setNotice(null)
      setRetryText(null)
      setDraft('')
      setLiveTranscript('')
      setUserCaption(text)
      setAssistantCaption('')
      setSpokenChars(0)
      setCaptionTurn((current) => current + 1)
      setEmotion(deriveEmotion(text) === 'concerned' ? 'concerned' : 'focused')
      feel(text, SPEAKER_WEIGHT.user)
      setPhase('thinking')

      const userMessage: Message = {
        id: makeId(),
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      }
      const context = [...messagesRef.current, userMessage]
      messagesRef.current = context
      setMessages(context)

      const turnId = makeId()
      let complete = ''
      let spokenProgress = 0
      const voice =
        voiceModeRef.current === 'active'
          ? new VoiceQueue({
              request: (seq, chunk, signal) => link.speak(turnId, seq, chunk, signal),
              onSpeakingChange: (isSpeaking) => {
                if (isSpeaking) setPhase('speaking')
                else if (phaseRef.current === 'speaking') setPhase('replying')
              },
               onLevel: (value) => {
                 levelRef.current = value
               },
               onProgress: (chars) => {
                 spokenProgress = Math.max(spokenProgress, chars)
                 setSpokenChars(spokenProgress)
                 const visible = complete.slice(0, Math.min(spokenProgress, complete.length))
                 const boundary = visible.lastIndexOf(' ')
                 const caption =
                   visible.length < complete.length && !/\s$/.test(visible)
                     ? boundary > 0
                       ? visible.slice(0, boundary)
                       : ''
                     : visible.trimEnd()
                 setAssistantCaption(caption)
               },
              onError: (message) => setNotice(message),
            })
          : null
      voiceRef.current = voice

      let sawDelta = false

      const finish = async (finalText: string) => {
        const assistantMessage: Message = {
          id: makeId(),
          role: 'assistant',
          content: finalText,
          createdAt: new Date().toISOString(),
        }
        const next = [...context, assistantMessage]
        messagesRef.current = next
        setMessages(next)
        setEmotion(emotionForTurn(text, finalText))
        feel(finalText, SPEAKER_WEIGHT.assistant)

        if (voice) {
          voice.finish()
          await voice.idle()
        } else {
          setAssistantCaption(finalText)
          setSpokenChars(finalText.length)
        }
        if (voiceRef.current !== voice) return

        // A voice turn reaches the complete caption only after its last chunk
        // has finished, keeping the visible words and the audio in step.
        setAssistantCaption(finalText)
        setSpokenChars(finalText.length)
        voiceRef.current = null
        turnRef.current = null

        if (voiceModeRef.current === 'active') {
          setPhase('idle')
          scheduleListen(120)
        } else {
          setPhase(voiceModeRef.current === 'paused' ? 'paused' : 'idle')
        }
      }

      turnRef.current = link.startTurn(
        turnId,
        context.map(({ role, content }) => ({ role, content })),
        {
          onDelta: (delta) => {
            complete += delta
            if (!sawDelta) {
              sawDelta = true
              setPhase('replying')
            }
            if (!voice) setAssistantCaption(complete)
            voice?.feed(delta)
          },
          onDone: (finalText) => {
            complete = finalText || complete
            void finish(complete)
          },
          onError: (message, retryable) => {
            stopVoice()
            turnRef.current = null
            setNotice(message)
            if (retryable) setRetryText(text)
            if (!complete) {
              setAssistantCaption('I lost the connection for a moment.')
              setSpokenChars(0)
            }
            setEmotion('concerned')
            setMood((current) => nudgeMood(current, 'concerned', 0.45))
            setPhase(voiceModeRef.current === 'active' ? 'idle' : 'paused')
            if (voiceModeRef.current === 'active') scheduleListen(700)
          },
        },
      )
    },
    [feel, scheduleListen, setPhase, stopVoice],
  )

  // -- Microphone ----------------------------------------------------------

  const startListening = useCallback(
    (preserveDeadline = false) => {
      if (!speechRecognitionSupported()) {
        setSpeechSupported(false)
        setVoiceMode('muted')
        setPhase('idle')
        setNotice('Live voice needs Chrome or Edge. You can still type below.')
        return
      }
      if (phaseRef.current === 'thinking' || phaseRef.current === 'replying') return
      if (phaseRef.current === 'speaking') return
      if (listenerRef.current?.active) return

      const listener = new Listener({
        onInterim: (value) => {
          setLiveTranscript(value)
          setUserCaption(value)
          if (phaseRef.current === 'listening') {
            setEmotion(deriveEmotion(value) === 'happy' ? 'happy' : 'curious')
          }
        },
        onCommit: (value) => {
          listenerRef.current = null
          sendMessage(value)
        },
        onError: (_code, message) => setNotice(message),
        onSilenceTimeout: () => {
          listenerRef.current = null
          setLiveTranscript('')
          setVoiceMode('paused')
          setPhase('paused')
        },
        onEnd: (reason) => {
          if (reason === 'restart' && voiceModeRef.current === 'active') {
            listenerRef.current = null
            scheduleListen(140, true)
            return
          }
          if (reason === 'error') {
            listenerRef.current = null
            setVoiceMode('paused')
            setPhase('paused')
          }
        },
      })

      listenerRef.current = listener
      setVoiceMode('active')
      setNotice(null)
      setLiveTranscript('')
      if (listener.start(preserveDeadline)) {
        setPhase('listening')
      } else {
        listenerRef.current = null
        setVoiceMode('paused')
        setPhase('paused')
      }
    },
    [scheduleListen, sendMessage, setPhase, setVoiceMode],
  )

  startListeningRef.current = startListening

  const handleVoiceControl = useCallback(() => {
    if (voiceModeRef.current === 'active') {
      setVoiceMode('muted')
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
      listenerRef.current?.abort()
      listenerRef.current = null
      stopVoice()
      if (phaseRef.current !== 'thinking' && phaseRef.current !== 'replying') setPhase('idle')
      setLiveTranscript('')
      return
    }
    setNotice(null)
    startListening(false)
  }, [setPhase, setVoiceMode, startListening, stopVoice])

  const stopCurrentTurn = useCallback(() => {
    turnRef.current?.cancel()
    turnRef.current = null
    stopVoice()
    setPhase('idle')
    setAssistantCaption((current) => current || 'Stopped.')
    if (voiceModeRef.current === 'active') scheduleListen(220)
  }, [scheduleListen, setPhase, stopVoice])

  const newConversation = useCallback(() => {
    turnRef.current?.cancel()
    turnRef.current = null
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
    listenerRef.current?.abort()
    listenerRef.current = null
    stopVoice()

    messagesRef.current = [WELCOME_MESSAGE]
    setMessages([WELCOME_MESSAGE])
    setAssistantCaption(WELCOME_MESSAGE.content)
    setSpokenChars(WELCOME_MESSAGE.content.length)
    setUserCaption('')
    setEmotion('neutral')
    setMood(NEUTRAL_MOOD)
    setNotice(null)
    setRetryText(null)
    setDraft('')
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // A cleared conversation that cannot be persisted is still cleared here.
    }

    if (voiceModeRef.current === 'active') {
      setPhase('idle')
      scheduleListen(220)
    } else {
      setPhase(voiceModeRef.current === 'paused' ? 'paused' : 'idle')
    }
  }, [scheduleListen, setPhase, stopVoice])

  // The metal face still tilts toward the pointer; the eyes track it themselves.
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

  const statusCopy =
    voiceMode === 'paused'
      ? 'Quiet pause'
      : {
          idle: voiceMode === 'muted' ? 'Voice muted' : 'Here with you',
          listening: liveTranscript ? 'I hear you' : 'Listening…',
          thinking: 'Thinking with you…',
          replying: 'Replying',
          speaking: 'Speaking',
          paused: 'Quiet pause',
        }[phase]

  const voiceControl =
    voiceMode === 'paused'
      ? { icon: <Play size={19} fill="currentColor" />, label: 'Resume voice', hint: 'Paused after 30s' }
      : voiceMode === 'muted'
        ? { icon: <MicOff size={19} />, label: 'Voice muted', hint: 'Tap to resume' }
        : phase === 'speaking'
          ? { icon: <AudioLines size={20} />, label: 'Speaking', hint: 'Tap to mute' }
          : phase === 'thinking' || phase === 'replying'
            ? { icon: <Sparkles size={19} />, label: 'Replying', hint: 'Tap to mute' }
             : {
                icon: <Mic size={20} />,
                label: phase === 'listening' ? 'Listening' : 'Voice live',
               hint: 'Tap to mute',
             }

  // Words already voiced are shown at full strength, so text arriving ahead of
  // the audio reads as intent rather than as lag.
  const words = assistantCaption ? assistantCaption.split(/\s+/).filter(Boolean) : []
  let cursor = 0
  const spokenIndex = words.map((word) => {
    const start = assistantCaption.indexOf(word, cursor)
    cursor = start + word.length
    return cursor <= spokenChars
  })

  return (
    <main
      className="presence-shell"
      ref={stageRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetGaze}
    >
      <EmotionField
        mood={mood}
        active={phase === 'listening' || phase === 'replying' || phase === 'speaking'}
        levelRef={levelRef}
      />

      <div className="floating-brand" aria-label="GIDEON">
        <span className="brand-seed" />
        <span>GIDEON</span>
      </div>

      <button
        className="reset-button"
        type="button"
        onClick={newConversation}
        aria-label="New conversation"
      >
        <RotateCcw size={17} />
        <span>New</span>
      </button>

      {config && !config.configured ? (
        <div className="setup-note" role="status">
          Add the local OpenRouter key, then restart GIDEON.
        </div>
      ) : null}

      <section className="agent-presence" aria-label="GIDEON voice presence">
        <LivingPresence phase={phase} emotion={emotion} levelRef={levelRef} />

        <div className="live-captions" aria-live="polite" aria-atomic="false">
          {userCaption ? (
            <p className="user-caption">
              <span>You</span>
              {userCaption}
            </p>
          ) : null}
          <p
            className={`assistant-caption ${
              phase === 'thinking' && !assistantCaption ? 'is-thinking' : ''
            }`}
          >
            {assistantCaption ? (
              words.map((word, index) => (
                <span
                  className={`caption-word${spokenIndex[index] ? ' is-spoken' : ''}`}
                  key={`${captionTurn}-${index}`}
                >
                  {word}
                </span>
              ))
            ) : (
              <span className="thought-pulse">•••</span>
            )}
          </p>
        </div>
      </section>

      <section className="voice-dock" aria-label="Voice and text controls">
        <div className="presence-status" aria-live="polite" data-phase={phase}>
          <span className="status-dot" />
          <span>{statusCopy}</span>
          {voiceMode === 'paused' ? <small>30 seconds of quiet · tap Resume below</small> : null}
        </div>

        {notice ? (
          <div className="inline-notice" role="alert">
            <span>{notice}</span>
            {retryText ? (
              <button type="button" onClick={() => sendMessage(retryText)}>
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
            <span className="voice-icon">
              {speechSupported ? voiceControl.icon : <MicOff size={19} />}
            </span>
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

          {phase === 'thinking' || phase === 'replying' || phase === 'speaking' ? (
            <button
              type="button"
              className="stop-turn-button"
              onClick={stopCurrentTurn}
              aria-label="Stop current response"
            >
              <Square size={15} fill="currentColor" />
            </button>
          ) : null}
        </div>

        <div className="text-composer">
          <label className="sr-only" htmlFor="message-input">
            Type to GIDEON
          </label>
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
                sendMessage(draft)
              }
            }}
          />
          <button
            type="button"
            onClick={() => sendMessage(draft)}
            disabled={!draft.trim()}
            aria-label="Send typed message"
          >
            <ArrowUp size={18} strokeWidth={2.5} />
          </button>
        </div>
      </section>
    </main>
  )
}
