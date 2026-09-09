import {
  Activity,
  ArrowUp,
  AudioLines,
  Check,
  Link as LinkIcon,
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
import { MicCapture, captureSupported } from '../lib/audio/capture'
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
import { RealtimeLink, type TurnHandle } from '../lib/realtime-client'
import { SpeculationTracker } from '../lib/speculation'
import {
  ClientToolRunner,
  describeDuration,
  type OfferedLink,
  type Timer,
} from '../lib/tools/client-tools'
import { LatencyLog, TurnTimeline } from '../lib/telemetry'
import { VoiceQueue } from '../lib/voice-queue'
import { EmotionField } from './EmotionField'
import { GideonEyes, type EyePhase } from './GideonEyes'
import { LatencyHud } from './LatencyHud'

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
  tools?: string[]
}

/**
 * One thing GIDEON did, and whether it worked.
 *
 * An agent that only talks needs no ledger. One that remembers things, searches
 * the web and sets timers does: the user has to be able to see what was done on
 * their behalf without taking GIDEON's word for it, and spoken confirmation
 * disappears the moment it is said.
 */
interface LedgerEntry {
  id: string
  summary: string
  ok: boolean
  at: number
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

/**
 * A reply that is either being shown or being kept out of sight.
 *
 * A speculative turn is a fully live stream that nobody is allowed to see. It
 * accumulates here until the real transcript either vindicates it — at which
 * point everything buffered is released to the caption and the voice at once —
 * or contradicts it, at which point it is cancelled having cost only tokens.
 */
interface RunningTurn {
  id: string
  /** The user text this reply is an answer to. */
  text: string
  timeline: TurnTimeline
  handle: TurnHandle | null
  /** Everything streamed so far. */
  complete: string
  /** Set once the stream ends, whether or not anyone has seen it. */
  finished: boolean
  speculative: boolean
  cancelled: boolean
  voice: VoiceQueue | null
  /**
   * Set by `promote` when the stream is still running, so the settle step is
   * driven by whichever of the two happens second.
   */
  onFinish?: () => void
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
  const [hudOpen, setHudOpen] = useState(false)
  const [ledger, setLedger] = useState<LedgerEntry[]>([])
  const [links, setLinks] = useState<OfferedLink[]>([])

  const stageRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const phaseRef = useRef<Phase>('idle')
  const voiceModeRef = useRef<VoiceMode>('active')
  const messagesRef = useRef<Message[]>([WELCOME_MESSAGE])
  const linkRef = useRef<RealtimeLink | null>(null)
  const listenerRef = useRef<Listener | null>(null)
  const captureRef = useRef<MicCapture | null>(null)
  const turnRef = useRef<RunningTurn | null>(null)
  const levelRef = useRef(0)
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startListeningRef = useRef<(preserveDeadline?: boolean) => void>(() => undefined)

  /** Guesses in flight for the utterance currently being spoken by the user. */
  const speculationRef = useRef(new SpeculationTracker<RunningTurn>())
  const logRef = useRef(new LatencyLog())
  const toolsRef = useRef<ClientToolRunner | null>(null)
  /** The moment the detector last heard speech stop, for the hangover mark. */
  const speechEndRef = useRef(0)

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

  /** Tear a turn down completely, whether it was ever visible or not. */
  const abandon = useCallback((turn: RunningTurn | null) => {
    if (!turn || turn.cancelled) return
    turn.cancelled = true
    turn.handle?.cancel()
    turn.voice?.cancel()
    turn.voice = null
  }, [])

  const stopVoice = useCallback(() => {
    turnRef.current?.voice?.cancel()
    if (turnRef.current) turnRef.current.voice = null
    levelRef.current = 0
    captureRef.current?.setDucking(false)
  }, [])

  const note = useCallback((summary: string, ok = true) => {
    setLedger((current) => [
      ...current.slice(-5),
      { id: `${Date.now().toString(36)}-${current.length}`, summary, ok, at: Date.now() },
    ])
  }, [])

  // -- Browser-run tools ---------------------------------------------------

  /**
   * The tools the server cannot run for itself.
   *
   * A fired timer is the one moment GIDEON speaks without being spoken to, so
   * it is deliberately modest: the ledger records it and the caption says it,
   * and nothing is synthesised over whatever the user is currently doing.
   */
  useEffect(() => {
    const runner = new ClientToolRunner({
      onTimerSet: (timer: Timer) => {
        const seconds = Math.max(0, Math.round((timer.fireAt - Date.now()) / 1000))
        note(`Timer set for ${describeDuration(seconds)}${timer.label ? ` · ${timer.label}` : ''}`)
      },
      onTimerFired: (timer: Timer) => {
        note(timer.label ? `Timer finished · ${timer.label}` : 'Timer finished')
        const said = timer.label ? `Timer finished: ${timer.label}.` : 'Your timer finished.'
        setAssistantCaption(said)
        // Nothing synthesised this, so the caption has no audio clock to reveal
        // against; it is shown complete rather than word by word.
        setSpokenChars(said.length)
      },
      onLinkOffered: (link: OfferedLink) => {
        setLinks((current) => [...current.slice(-2), link])
        note(`Offered a link · ${link.title}`)
      },
    })
    toolsRef.current = runner
    return () => {
      runner.dispose()
      toolsRef.current = null
    }
  }, [note])

  // -- Realtime link -------------------------------------------------------

  useEffect(() => {
    const link = new RealtimeLink({
      onConfig: (next) => setConfig(next),
      runClientTool: (name, args) =>
        toolsRef.current?.run(name, args) ??
        Promise.resolve({ ok: false, content: 'The page is not ready to do that.' }),
    })
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
      turnRef.current?.handle?.cancel()
      turnRef.current?.voice?.cancel()
      void captureRef.current?.dispose()
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

  /** The panel is a developer tool, so it lives on a key rather than a button. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '`' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      event.preventDefault()
      setHudOpen((open) => !open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // -- Interruption --------------------------------------------------------

  /**
   * GIDEON stops talking because you started.
   *
   * The history entry is truncated to the words that were actually *heard*,
   * not the ones that were written. Leaving the full reply in place would mean
   * the next turn is reasoning about a paragraph you never received, and the
   * conversation quietly diverges from the one you are having.
   */
  const interrupt = useCallback(() => {
    const turn = turnRef.current
    if (!turn || turn.speculative) return

    const heard = turn.voice?.spokenChars ?? 0
    const spoken = turn.complete.slice(0, heard).trimEnd()

    turn.timeline.interrupted = true
    logRef.current.push(turn.timeline.summary())

    abandon(turn)
    turnRef.current = null
    captureRef.current?.setDucking(false)
    levelRef.current = 0

    if (spoken) {
      const assistantMessage: Message = {
        id: makeId(),
        role: 'assistant',
        content: `${spoken} [interrupted]`,
        createdAt: new Date().toISOString(),
      }
      const next = [...messagesRef.current, assistantMessage]
      messagesRef.current = next
      setMessages(next)
      setAssistantCaption(spoken)
      setSpokenChars(spoken.length)
    }

    // No `scheduleListen` here: the microphone never closed, and the person is
    // already mid-sentence. Anything else would drop the word they cut in on.
    setPhase('listening')
  }, [abandon, setPhase])

  // -- One turn ------------------------------------------------------------

  /**
   * Attaches a running turn to the interface.
   *
   * For an ordinary turn this happens the moment it starts. For a speculative
   * one it happens only once the final transcript has vindicated it, which is
   * why everything streamed so far is replayed into the voice in one go.
   */
  const promote = useCallback(
    (turn: RunningTurn, finalText: string, context: Message[]) => {
      turnRef.current = turn
      turn.speculative = false

      setNotice(null)
      setRetryText(null)
      setDraft('')
      setLiveTranscript('')
      setUserCaption(finalText)
      setAssistantCaption('')
      setSpokenChars(0)
      setCaptionTurn((current) => current + 1)
      setPhase(turn.complete ? 'replying' : 'thinking')

      const link = linkRef.current
      if (!link) return

      const voice =
        voiceModeRef.current === 'active'
          ? new VoiceQueue({
              request: (seq, chunk, signal) => link.speak(turn.id, seq, chunk, signal),
              onSpeakingChange: (isSpeaking) => {
                if (isSpeaking) {
                  turn.timeline.mark('first_sample')
                  captureRef.current?.setDucking(true)
                  setPhase('speaking')
                } else {
                  captureRef.current?.setDucking(false)
                  if (phaseRef.current === 'speaking') setPhase('replying')
                }
              },
              onLevel: (value) => {
                levelRef.current = value
              },
              onProgress: (chars) => {
                setSpokenChars(chars)
                // The caption is revealed on the audio clock, and cut at a word
                // boundary so a half-written word never flashes on screen.
                const visible = turn.complete.slice(0, Math.min(chars, turn.complete.length))
                const boundary = visible.lastIndexOf(' ')
                setAssistantCaption(
                  visible.length < turn.complete.length && !/\s$/.test(visible)
                    ? boundary > 0
                      ? visible.slice(0, boundary)
                      : ''
                    : visible.trimEnd(),
                )
              },
              onFirstRequest: () => turn.timeline.mark('speech_requested'),
              onFirstAudio: () => turn.timeline.mark('speech_received'),
              onError: (message) => setNotice(message),
            })
          : null
      turn.voice = voice

      // Everything the speculative stream had already produced.
      if (turn.complete) {
        if (voice) voice.feed(turn.complete)
        else setAssistantCaption(turn.complete)
      }

      const settle = async () => {
        const assistantMessage: Message = {
          id: makeId(),
          role: 'assistant',
          content: turn.complete,
          createdAt: new Date().toISOString(),
        }
        const next = [...context, assistantMessage]
        messagesRef.current = next
        setMessages(next)
        setEmotion(emotionForTurn(finalText, turn.complete))
        feel(turn.complete, SPEAKER_WEIGHT.assistant)

        if (voice) {
          voice.finish()
          await voice.idle()
        } else {
          setAssistantCaption(turn.complete)
          setSpokenChars(turn.complete.length)
        }
        if (turnRef.current !== turn || turn.cancelled) return

        // A voice turn reaches the complete caption only after its last chunk
        // has finished, keeping the visible words and the audio in step.
        setAssistantCaption(turn.complete)
        setSpokenChars(turn.complete.length)
        turn.timeline.mark('turn_done')
        logRef.current.push(turn.timeline.summary())

        turn.voice = null
        turnRef.current = null
        captureRef.current?.setDucking(false)

        if (voiceModeRef.current === 'active') {
          setPhase('idle')
          scheduleListen(120)
        } else {
          setPhase(voiceModeRef.current === 'paused' ? 'paused' : 'idle')
        }
      }

      // A speculative stream that had already finished before it was promoted
      // has no more deltas coming, so it settles immediately.
      if (turn.finished) void settle()
      else turn.onFinish = settle
    },
    [feel, scheduleListen, setPhase],
  )

  /**
   * Starts a turn against the model.
   *
   * A speculative turn is identical on the wire; the only difference is that
   * nothing it produces reaches the interface until `promote` says so.
   */
  const beginTurn = useCallback(
    (text: string, context: Message[], speculative: boolean): RunningTurn | null => {
      const link = linkRef.current
      if (!link) return null

      const turn: RunningTurn = {
        id: makeId(),
        text,
        timeline: new TurnTimeline(makeId()),
        handle: null,
        complete: '',
        finished: false,
        speculative,
        cancelled: false,
        voice: null,
      }

      if (!speculative) {
        if (speechEndRef.current) turn.timeline.mark('speech_end', speechEndRef.current)
        turn.timeline.mark('endpoint')
      }

      turn.handle = link.startTurn(
        turn.id,
        context.map(({ role, content }) => ({ role, content })),
        {
          onDelta: (delta) => {
            if (turn.cancelled) return
            turn.timeline.mark('first_token')
            turn.complete += delta

            if (turn.speculative) return
            if (phaseRef.current === 'thinking') setPhase('replying')
            if (turn.voice) turn.voice.feed(delta)
            else setAssistantCaption(turn.complete)
          },
          onAction: (action) => {
            // A speculative turn is invisible, and so are its actions: the guess
            // may yet be thrown away, and a ledger entry for work nobody asked
            // for would be a lie about what happened.
            if (turn.cancelled || turn.speculative) return
            note(action.summary, action.ok)
          },
          onDone: (finalText) => {
            if (turn.cancelled) return
            turn.complete = finalText || turn.complete
            turn.finished = true
            turn.timeline.mark('reply_done')
            turn.onFinish?.()
          },
          onError: (message, retryable) => {
            if (turn.cancelled) return
            turn.finished = true
            // A speculative failure is invisible on purpose. The real turn is
            // about to run anyway and will surface anything that is still wrong.
            if (turn.speculative) return

            turn.voice?.cancel()
            turn.voice = null
            turnRef.current = null
            captureRef.current?.setDucking(false)

            setNotice(message)
            if (retryable) setRetryText(turn.text)
            if (!turn.complete) {
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

      turn.timeline.mark('turn_sent')
      return turn
    },
    [note, scheduleListen, setPhase],
  )

  const sendMessage = useCallback(
    (rawText: string) => {
      const text = rawText.trim()
      if (!text) return
      if (!linkRef.current) return

      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
      abandon(turnRef.current)
      turnRef.current = null
      captureRef.current?.setDucking(false)

      const userMessage: Message = {
        id: makeId(),
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      }
      const context = [...messagesRef.current, userMessage]

      // Resolve any guesses made while this sentence was still being spoken.
      const resolved = speculationRef.current.resolve(text)
      for (const run of resolved.discard) abandon(run.handle)

      let turn = resolved.keep?.handle ?? null
      if (turn && !turn.cancelled) {
        turn.timeline.speculation = 'hit'
        // Marked now rather than at creation: when the guess was sent, this
        // utterance had not finished, and the only timestamp available then
        // belonged to the previous one.
        if (speechEndRef.current) turn.timeline.mark('speech_end', speechEndRef.current)
        turn.timeline.mark('endpoint')
        // The guess was sent this long before the endpoint, and the reply has
        // been streaming for exactly that long by the time it is needed.
        turn.timeline.saved = Math.max(
          0,
          (turn.timeline.get('endpoint') ?? 0) - (turn.timeline.get('turn_sent') ?? 0),
        )
      } else {
        turn = beginTurn(text, context, false)
        if (turn && speculationRef.current.attempts > 0) turn.timeline.speculation = 'miss'
      }
      speculationRef.current.clear()

      if (!turn) return

      messagesRef.current = context
      setMessages(context)
      setEmotion(deriveEmotion(text) === 'concerned' ? 'concerned' : 'focused')
      feel(text, SPEAKER_WEIGHT.user)

      promote(turn, text, context)
    },
    [abandon, beginTurn, feel, promote],
  )

  /**
   * Considers spending a turn on a sentence that has not finished yet.
   *
   * Cheap to be wrong, expensive to be slow: a miss costs a couple of hundred
   * tokens nobody reads, and a hit removes the entire model round trip from the
   * gap between you stopping and GIDEON starting.
   */
  const considerSpeculation = useCallback(
    (text: string, stableMs: number) => {
      if (voiceModeRef.current !== 'active') return
      if (turnRef.current && !turnRef.current.speculative) return
      if (!speculationRef.current.consider(text, stableMs)) return

      const context = [
        ...messagesRef.current,
        {
          id: 'speculative',
          role: 'user' as const,
          content: text,
          createdAt: new Date().toISOString(),
        },
      ]
      const turn = beginTurn(text, context, true)
      if (!turn) return
      turn.timeline.speculation = 'hit'
      speculationRef.current.start(text, turn, Date.now())
    },
    [beginTurn],
  )

  // -- Microphone ----------------------------------------------------------

  /**
   * The capture graph, opened once and left open.
   *
   * It runs for the whole session rather than per turn: the echo guard needs
   * the same frames the level meter sees, and barge-in is only possible if the
   * microphone is still listening while the speakers are busy.
   */
  const ensureCapture = useCallback(async () => {
    if (captureRef.current || !captureSupported()) return
    const capture = new MicCapture({
      onSpeechStart: () => {
        speechEndRef.current = 0
      },
      onSpeechEnd: () => {
        speechEndRef.current = performance.now()
        // The detector reached the end of the utterance from the waveform well
        // before the recogniser will admit to a final result, so it is the one
        // that decides the turn is over.
        listenerRef.current?.commitNow()
      },
      onBargeIn: () => interrupt(),
      onError: (code, message) => {
        // A refused microphone is worth saying; a missing one on a machine that
        // was going to type anyway is not.
        if (code === 'denied') setNotice(message)
      },
    })
    captureRef.current = capture
    await capture.start()
  }, [interrupt])

  const startListening = useCallback(
    (preserveDeadline = false) => {
      if (!speechRecognitionSupported()) {
        setSpeechSupported(false)
        setVoiceMode('muted')
        setPhase('idle')
        setNotice('Live voice needs Chrome or Edge. You can still type below.')
        return
      }
      if (listenerRef.current?.active) return

      void ensureCapture()

      const listener = new Listener({
        onInterim: (value) => {
          setLiveTranscript(value)
          setUserCaption(value)
          if (phaseRef.current === 'listening') {
            setEmotion(deriveEmotion(value) === 'happy' ? 'happy' : 'curious')
          }
        },
        onStable: (value, stableMs) => considerSpeculation(value, stableMs),
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
        // Mid-reply the microphone is open for interruption, not for a turn, so
        // the phase stays with whatever GIDEON is doing.
        if (phaseRef.current !== 'speaking' && phaseRef.current !== 'replying') {
          setPhase('listening')
        }
      } else {
        listenerRef.current = null
        setVoiceMode('paused')
        setPhase('paused')
      }
    },
    [considerSpeculation, ensureCapture, scheduleListen, sendMessage, setPhase, setVoiceMode],
  )

  startListeningRef.current = startListening

  const handleVoiceControl = useCallback(() => {
    if (voiceModeRef.current === 'active') {
      setVoiceMode('muted')
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
      listenerRef.current?.abort()
      listenerRef.current = null
      for (const run of speculationRef.current.clear()) abandon(run.handle)
      stopVoice()
      void captureRef.current?.stop()
      captureRef.current = null
      if (phaseRef.current !== 'thinking' && phaseRef.current !== 'replying') setPhase('idle')
      setLiveTranscript('')
      return
    }
    setNotice(null)
    startListening(false)
  }, [abandon, setPhase, setVoiceMode, startListening, stopVoice])

  const stopCurrentTurn = useCallback(() => {
    const turn = turnRef.current
    if (turn) {
      turn.timeline.interrupted = true
      logRef.current.push(turn.timeline.summary())
    }
    abandon(turn)
    turnRef.current = null
    captureRef.current?.setDucking(false)
    levelRef.current = 0
    setPhase('idle')
    setAssistantCaption((current) => current || 'Stopped.')
    if (voiceModeRef.current === 'active') scheduleListen(220)
  }, [abandon, scheduleListen, setPhase])

  const newConversation = useCallback(() => {
    abandon(turnRef.current)
    turnRef.current = null
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
    listenerRef.current?.abort()
    listenerRef.current = null
    for (const run of speculationRef.current.clear()) abandon(run.handle)
    captureRef.current?.resetUtterance()
    captureRef.current?.setDucking(false)
    levelRef.current = 0

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
    setLedger([])
    setLinks([])
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
  }, [abandon, scheduleListen, setPhase])

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
          speaking: 'Speaking · cut in any time',
          paused: 'Quiet pause',
        }[phase]

  const voiceControl =
    voiceMode === 'paused'
      ? { icon: <Play size={19} fill="currentColor" />, label: 'Resume voice', hint: 'Paused after 30s' }
      : voiceMode === 'muted'
        ? { icon: <MicOff size={19} />, label: 'Voice muted', hint: 'Tap to resume' }
        : phase === 'speaking'
          ? { icon: <AudioLines size={20} />, label: 'Speaking', hint: 'Talk to interrupt' }
          : phase === 'thinking' || phase === 'replying'
            ? { icon: <Sparkles size={19} />, label: 'Replying', hint: 'Talk to interrupt' }
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
        <img
          className="brand-logo"
          src="/gideon-72.png"
          alt=""
          width={36}
          height={36}
          draggable={false}
        />
        <span>GIDEON</span>
      </div>

      <div className="corner-actions">
        <button
          className="reset-button"
          type="button"
          onClick={() => setHudOpen((open) => !open)}
          aria-label="Toggle latency panel"
          aria-pressed={hudOpen}
          title="Latency panel (`)"
        >
          <Activity size={17} />
          <span>Latency</span>
        </button>
        <button
          className="reset-button"
          type="button"
          onClick={newConversation}
          aria-label="New conversation"
        >
          <RotateCcw size={17} />
          <span>New</span>
        </button>
      </div>

      {hudOpen ? <LatencyHud log={logRef.current} onClose={() => setHudOpen(false)} /> : null}

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

      {ledger.length || links.length ? (
        <section className="action-ledger" aria-label="What GIDEON did">
          {ledger.map((entry) => (
            <p className="ledger-entry" data-ok={entry.ok} key={entry.id}>
              <Check size={13} strokeWidth={2.5} />
              <span>{entry.summary}</span>
            </p>
          ))}
          {links.map((link) => (
            <a
              className="ledger-link"
              key={link.id}
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              <LinkIcon size={13} />
              <span>{link.title}</span>
              <small>{new URL(link.url).hostname}</small>
            </a>
          ))}
        </section>
      ) : null}

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
