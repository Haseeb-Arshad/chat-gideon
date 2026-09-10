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
import { MicCapture, captureSupported, type Utterance } from '../lib/audio/capture'
import { Transcriber } from '../lib/audio/transcriber'
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
import { RealtimeLink, type ActionEvent, type TurnHandle } from '../lib/realtime-client'
import { SpeculationTracker, looksUnfinished } from '../lib/speculation'
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
/**
 * Why listening stopped.
 *
 * The dock used to explain every pause as thirty seconds of quiet, which is
 * only ever true of the recogniser fallback's own timeout. A refused
 * microphone read as though the user had simply gone silent.
 */
type PauseReason = 'quiet' | 'blocked' | 'failed' | null

interface Message {
  id: string
  role: ChatRole
  content: string
  createdAt: string
}

/**
 * One line of the transcript.
 *
 * History and the turn currently in flight are the same thing on screen, so
 * they are flattened into one list before rendering. `live` marks the entry
 * that is still being written — the only one that reveals itself word by word.
 */
interface StreamEntry {
  id: string
  role: ChatRole
  content: string
  /** The reply was cut off by a barge-in rather than finished. */
  cut: boolean
  live: boolean
}

interface PublicConfig {
  configured: boolean
  chatModel: string
  voiceModel: string
  sttModel?: string
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
  /** Still happening. The entry is replaced in place when the result arrives. */
  pending?: boolean
}

const STORAGE_KEY = 'gideon-conversation-v2'

/** How an interrupted reply is marked in history, for the model's benefit. */
const INTERRUPTED = /s*[interrupted]$/

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
  /**
   * The stream ended in an error. Tracked separately from `cancelled` because
   * the tracker matches on text alone: a guess that failed upstream can still
   * be the one whose text the final transcript vindicates, and promoting it
   * would settle an empty reply into history as though it had been spoken.
   */
  failed: boolean
  voice: VoiceQueue | null
  /**
   * What a speculative turn did while nobody could see it. Held back so a
   * guess that is thrown away leaves no trace, and replayed if it is kept.
   */
  actions: ActionEvent[]
  /** The history entry this reply settled into, once it has. */
  messageId?: string
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
  /**
   * The history entry whose words are still being spoken. A reply joins the
   * history the moment its text has all arrived, usually a second or more
   * before its voice has finished, so until then it is drawn from the caption
   * the audio reveals rather than printed whole ahead of the voice.
   */
  const [voicingId, setVoicingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [retryText, setRetryText] = useState<string | null>(null)
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [speechSupported, setSpeechSupported] = useState(true)
  const [hydrated, setHydrated] = useState(false)
  const [hudOpen, setHudOpen] = useState(false)
  /** The composer is a resting pill until it is asked for, then it is a field. */
  const [composerOpen, setComposerOpen] = useState(false)
  const [pauseReason, setPauseReason] = useState<PauseReason>(null)
  const [ledger, setLedger] = useState<LedgerEntry[]>([])
  const [links, setLinks] = useState<OfferedLink[]>([])

  const stageRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  /** Whether the transcript is resting on its floor, rather than held open. */
  const followRef = useRef(true)
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
  const transcriberRef = useRef<Transcriber | null>(null)
  /** Repeating partial transcription while someone is mid-sentence. */
  const partialTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** The partial transcript, and when it last actually changed. */
  const partialRef = useRef({ text: '', changedAt: 0 })
  /**
   * A transcription started the instant silence began, before the hangover has
   * expired.
   *
   * This is what keeps the recogniser off the critical path. The detector waits
   * a third of a second to be sure a sentence is over; transcription takes
   * about the same. Running them concurrently rather than in sequence means the
   * transcript is usually already in hand the moment the utterance is declared
   * finished, so the whole speech-to-text step costs almost nothing.
   */
  const eagerRef = useRef<{
    frames: number
    controller: AbortController
    promise: Promise<{ text: string } | null>
  } | null>(null)
  const vadStateRef = useRef<string>('silence')
  /** Set once `runPartial` exists; called from the interrupt handler above it. */
  const runPartialRef = useRef<() => void>(() => undefined)
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

  /** Read through a call so narrowing cannot outlive an await. */
  const midTurn = useCallback(
    () => phaseRef.current === 'thinking' || phaseRef.current === 'replying',
    [],
  )

  const stopPartials = useCallback(() => {
    if (partialTimerRef.current) clearInterval(partialTimerRef.current)
    partialTimerRef.current = null
  }, [])

  const dropEager = useCallback(() => {
    eagerRef.current?.controller.abort()
    eagerRef.current = null
  }, [])

  const stopVoice = useCallback(() => {
    turnRef.current?.voice?.cancel()
    if (turnRef.current) turnRef.current.voice = null
    levelRef.current = 0
    captureRef.current?.setDucking(false)
  }, [])

  const note = useCallback((summary: string, ok = true, key?: string, pending = false) => {
    setLedger((current) => {
      const id = key ?? `${Date.now().toString(36)}-${current.length}`
      const entry: LedgerEntry = { id, summary, ok, at: Date.now(), pending }
      // A keyed entry updates itself: "Looking that up…" becomes the result
      // rather than sitting above it as a second line.
      if (key && current.some((existing) => existing.id === key)) {
        return current.map((existing) => (existing.id === key ? entry : existing))
      }
      return [...current.slice(-5), entry]
    })
  }, [])

  /** What GIDEON is busy with while the turn is silent, for the status line. */
  const [working, setWorking] = useState<string | null>(null)

  /** Puts one of a live turn's actions in front of the user. */
  const showAction = useCallback(
    (turn: RunningTurn, action: ActionEvent) => {
      note(action.summary, action.ok, `${turn.id}:${action.call}`, action.pending)
      setWorking(action.pending ? 'Looking that up…' : null)
      if (!action.links.length) return
      setLinks((current) =>
        [
          ...current,
          ...action.links.map((link) => ({
            id: `${turn.id}:${action.call}:${link.url}`,
            url: link.url,
            title: link.title,
          })),
        ].slice(-4),
      )
    },
    [note],
  )

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
    const supported = captureSupported() || speechRecognitionSupported()
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
          if (lastAssistant) {
            setAssistantCaption(lastAssistant.content)
            setSpokenChars(lastAssistant.content.length)
            setEmotion(deriveEmotion(lastAssistant.content))
          }
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
      if (partialTimerRef.current) clearInterval(partialTimerRef.current)
      eagerRef.current?.controller.abort()
      listenerRef.current?.abort()
      turnRef.current?.handle?.cancel()
      turnRef.current?.voice?.cancel()
      // An unpromoted guess is not in `turnRef`, so cancelling that alone left
      // it streaming into a component that no longer exists.
      for (const run of speculationRef.current.clear()) {
        run.handle.handle?.cancel()
        run.handle.voice?.cancel()
      }
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

  /**
   * The newest line stays on the floor of the transcript and everything older
   * rises out from under the veil. Smoothing lives in CSS rather than here, so
   * the reduced-motion rule that already governs the page governs this too.
   *
   * Someone who has scrolled back to re-read something is not dragged down
   * again by the next token — `followRef` is only true while the transcript is
   * already resting on its floor, which is where it spends nearly all its time.
   */
  useEffect(() => {
    const node = transcriptRef.current
    if (node && followRef.current) node.scrollTop = node.scrollHeight
  }, [messages, assistantCaption, liveTranscript])

  /**
   * The same pin again, driven by height rather than by state.
   *
   * A reply can change height without changing: the display face swapping in
   * after its first paint reflows the newest line, and settling on it after the
   * fact would otherwise leave the last line of an answer below the floor with
   * nothing left to scroll it back into view.
   */
  useEffect(() => {
    const node = transcriptRef.current
    const flow = node?.firstElementChild
    if (!node || !flow) return

    const pin = () => {
      if (followRef.current) node.scrollTop = node.scrollHeight
    }
    const observer = new ResizeObserver(pin)
    observer.observe(flow)
    return () => observer.disconnect()
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

    // A reply that had finished arriving is already in the history, in full.
    // It is replaced by what was heard rather than joined by it, and dropped
    // outright if not a word of it was.
    const history = messagesRef.current
    const settledAt = turn.messageId
      ? history.findIndex((message) => message.id === turn.messageId)
      : -1
    setVoicingId(null)

    if (spoken) {
      const assistantMessage: Message = {
        id: turn.messageId ?? makeId(),
        role: 'assistant',
        content: `${spoken} [interrupted]`,
        createdAt: new Date().toISOString(),
      }
      const next =
        settledAt >= 0
          ? history.map((message, index) => (index === settledAt ? assistantMessage : message))
          : [...history, assistantMessage]
      messagesRef.current = next
      setMessages(next)
      setAssistantCaption(spoken)
      setSpokenChars(spoken.length)
    } else if (settledAt >= 0) {
      const next = history.filter((_, index) => index !== settledAt)
      messagesRef.current = next
      setMessages(next)
    }

    // No `scheduleListen` here: the microphone never closed, and the person is
    // already mid-sentence. Anything else would drop the word they cut in on.
    setPhase('listening')

    // The capture graph withholds its speech-start callback while GIDEON is
    // audible, so the live transcript is started from here instead, now that
    // the interruption has been confirmed to be a person and not an echo.
    partialRef.current = { text: '', changedAt: Date.now() }
    if (!partialTimerRef.current) {
      partialTimerRef.current = setInterval(() => runPartialRef.current(), 850)
    }
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
      // Whatever the guess did while it was invisible, it did for real.
      for (const action of turn.actions.splice(0)) showAction(turn, action)

      setNotice(null)
      setRetryText(null)
      setDraft('')
      setLiveTranscript('')
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
        turn.messageId = assistantMessage.id
        if (voice) setVoicingId(assistantMessage.id)
        messagesRef.current = next
        setMessages(next)
        setEmotion(emotionForTurn(finalText, turn.complete))
        feel(turn.complete, SPEAKER_WEIGHT.assistant)

        if (voice) {
          voice.finish()
          await voice.idle()
          setVoicingId((current) => (current === assistantMessage.id ? null : current))
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
    [feel, scheduleListen, setPhase, showAction],
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
        failed: false,
        voice: null,
        actions: [],
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
            if (turn.cancelled) return
            // A speculative turn is invisible, and so are its actions: the guess
            // may yet be thrown away, and a ledger entry for work nobody asked
            // for would be a lie about what happened. They are held instead,
            // and `promote` replays them if the guess turns out to be the answer.
            if (turn.speculative) {
              turn.actions.push(action)
              return
            }
            showAction(turn, action)
          },
          onDone: (finalText) => {
            if (turn.cancelled) return
            setWorking(null)
            turn.complete = finalText || turn.complete
            turn.finished = true
            turn.timeline.mark('reply_done')
            turn.onFinish?.()
          },
          onError: (message, retryable) => {
            if (turn.cancelled) return
            setWorking(null)
            turn.finished = true
            turn.failed = true
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
        { speculative },
      )

      turn.timeline.mark('turn_sent')
      return turn
    },
    [showAction, scheduleListen, setPhase],
  )

  const sendMessage = useCallback(
    (rawText: string) => {
      const text = rawText.trim()
      if (!text) return
      if (!linkRef.current) return

      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
      stopPartials()
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
      if (turn && (turn.cancelled || turn.failed)) {
        // The text matched, but there is no usable reply behind it.
        abandon(turn)
        turn = null
      }
      if (turn) {
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
    [abandon, beginTurn, feel, promote, stopPartials],
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
   * Transcribes the sentence so far, for the caption and for the guess.
   *
   * Partials exist because the authoritative transcript only arrives once the
   * sentence is over, and a screen that shows nothing until then feels dead.
   * They are also what speculation reads: a guess needs to know roughly what
   * is being said before it has been finished.
   */
  const runPartial = useCallback(async () => {
    const capture = captureRef.current
    const transcriber = transcriberRef.current
    if (!capture || !transcriber || transcriber.busy) return
    if (midTurn()) return

    const snapshot = capture.snapshot()
    // Below about a second there is not enough audio to transcribe usefully,
    // and a one-word guess is not worth a request. Above fifteen seconds the
    // partial is re-uploading a buffer that grows every time, for a caption
    // nobody is reading during a monologue; the final transcript still covers
    // the whole thing.
    if (!snapshot || snapshot.ms < 900 || snapshot.ms > 15_000) return

    const result = await transcriber.run(snapshot.frames, snapshot.sampleRate)
    if (!result || !result.text) return
    // The turn may have started while this was in flight, in which case the
    // partial is about a sentence that has already been sent.
    if (midTurn()) return

    if (result.text !== partialRef.current.text) {
      partialRef.current = { text: result.text, changedAt: Date.now() }
    }
    setLiveTranscript(result.text)
    if (deriveEmotion(result.text) === 'happy') setEmotion('happy')

    // Patience where it is needed. Someone whose last word was "and" has not
    // finished, so the detector is told to wait considerably longer before
    // calling the sentence over; someone who landed on a complete clause gets
    // the quick path. This is the difference between being listened to and
    // being cut off, and it costs nothing on the turns that do not need it.
    capture.setHangover(looksUnfinished(result.text) ? 1_400 : null)

    considerSpeculation(result.text, Date.now() - partialRef.current.changedAt)
  }, [considerSpeculation, midTurn, setEmotion])

  runPartialRef.current = () => void runPartial()

  /**
   * Turns a finished utterance into a turn.
   *
   * Prefers the eager transcription started when silence began, which by now
   * has usually already returned; falls back to transcribing the utterance from
   * scratch when speech resumed after that attempt or it failed.
   */
  const handleUtterance = useCallback(
    async (utterance: Utterance) => {
      stopPartials()
      const transcriber = transcriberRef.current
      if (!transcriber) return

      const eager = eagerRef.current
      eagerRef.current = null

      let text = ''
      // The eager attempt is only valid if nothing was still being said when
      // it was taken; `dropEager` clears it the moment speech resumes.
      if (eager) text = (await eager.promise)?.text?.trim() ?? ''
      if (!text) {
        text = (await transcriber.run(utterance.frames, utterance.sampleRate))?.text?.trim() ?? ''
      }

      partialRef.current = { text: '', changedAt: 0 }
      transcriber.reset()

      if (!text) {
        // A cough, a door, a chair. Nothing was said, so nothing is sent and
        // the microphone simply carries on listening.
        setLiveTranscript('')
        if (voiceModeRef.current === 'active' && phaseRef.current === 'listening') {
          setPhase('listening')
        }
        return
      }

      sendMessage(text)
    },
    [sendMessage, setPhase, stopPartials],
  )

  /**
   * The capture graph, opened once and left open.
   *
   * It runs for the whole session rather than per turn: the echo guard needs
   * the same frames the level meter sees, and barge-in is only possible if the
   * microphone is still listening while the speakers are busy.
   */
  const ensureCapture = useCallback(async () => {
    if (captureRef.current || !captureSupported()) return

    transcriberRef.current ??= new Transcriber({
      language: (navigator.language || 'en').slice(0, 5),
      onError: (message) => setNotice(message),
    })

    const capture = new MicCapture({
      onSpeechStart: () => {
        speechEndRef.current = 0
        partialRef.current = { text: '', changedAt: Date.now() }
        // Each utterance starts from the configured default; the partials
        // below lengthen it only while the words are still trailing off.
        captureRef.current?.setHangover(null)
        dropEager()
        if (phaseRef.current === 'idle') setPhase('listening')
        stopPartials()
        partialTimerRef.current = setInterval(() => void runPartial(), 850)
      },

      onFrame: (result) => {
        const previous = vadStateRef.current
        vadStateRef.current = result.state
        if (previous === result.state) return

        if (result.state === 'trailing') {
          // Not while GIDEON is audible: the detector is running against a
          // raised threshold on a signal that may be his own echo, and
          // transcribing that would spend a request on nothing.
          if (phaseRef.current === 'speaking') return
          // Silence has begun but the hangover has not expired. Transcribing
          // now runs the round trip concurrently with the wait instead of
          // after it, which is most of what makes a turn feel immediate.
          const capture = captureRef.current
          const transcriber = transcriberRef.current
          const snapshot = capture?.snapshot()
          if (!capture || !transcriber || !snapshot) return
          dropEager()
          const controller = new AbortController()
          eagerRef.current = {
            frames: snapshot.frames.length,
            controller,
            promise: transcriber.run(snapshot.frames, snapshot.sampleRate, controller.signal),
          }
        } else if (result.state === 'speech' && previous === 'trailing') {
          // It was a pause, not the end. Whatever was transcribed is now short
          // of the sentence and has to be thrown away.
          dropEager()
        }
      },

      onUtterance: (utterance) => void handleUtterance(utterance),

      onSpeechEnd: () => {
        speechEndRef.current = performance.now()
        stopPartials()
      },

      onBargeIn: () => interrupt(),

      onLevel: (level) => {
        // Only meaningful while listening; during playback the meter belongs
        // to the voice, not the microphone.
        if (phaseRef.current === 'listening') levelRef.current = level
      },

      onError: (code, message) => {
        // A refused microphone is worth saying; a missing one on a machine that
        // was going to type anyway is not.
        if (code === 'denied' || code === 'no-device') setNotice(message)
      },
    })

    captureRef.current = capture
    const started = await capture.start()
    if (started) {
      setSpeechSupported(true)
      setPauseReason(null)
      setVoiceMode('active')
      setPhase('listening')
      return
    }

    // Nothing is listening. Saying "voice live" at this point would be the
    // interface lying about the one thing the user can check for themselves.
    captureRef.current = null
    stopPartials()
    // No re-dispatch to the recogniser from here: `startListening` chooses the
    // path by capability, so calling back into it while capture still reports
    // itself supported would loop. The next listen attempt picks the
    // recogniser on its own once the graph is known to be unavailable.
    setPauseReason(capture.status === 'denied' ? 'blocked' : 'failed')
    setVoiceMode(capture.status === 'denied' ? 'paused' : 'muted')
    setPhase('paused')
    setSpeechSupported(capture.status !== 'unsupported' || speechRecognitionSupported())
  }, [dropEager, handleUtterance, interrupt, runPartial, setPhase, setVoiceMode, stopPartials])

  const startListening = useCallback(
    (preserveDeadline = false) => {
      /*
       * The capture graph is the listener now.
       *
       * It used to be the browser's SpeechRecognition, with capture running
       * alongside it purely for barge-in. That was two microphone consumers on
       * one device, and the recogniser was the slower and less accurate of the
       * two. Where the graph is available it does the whole job, and the
       * recogniser below is only for a browser without AudioWorklet.
       */
      if (captureSupported()) {
        setNotice(null)
        setLiveTranscript('')
        const capture = captureRef.current
        if (capture?.running) {
          // Already open; it never stopped listening. Only the phase needs to
          // catch up, and the detector needs to forget the last utterance.
          capture.resetUtterance()
          setVoiceMode('active')
          setPhase('listening')
          return
        }
        void ensureCapture()
        return
      }

      if (!speechRecognitionSupported()) {
        setSpeechSupported(false)
        setVoiceMode('muted')
        setPhase('idle')
        setNotice('This browser cannot open a microphone. You can still type below.')
        return
      }
      if (listenerRef.current?.active) return

      const listener = new Listener({
        onInterim: (value) => {
          setLiveTranscript(value)
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
          setPauseReason('quiet')
          // The sentence was never finished, so no guess about it can ever be
          // vindicated; keeping them alive would only spend tokens.
          for (const run of speculationRef.current.clear()) abandon(run.handle)
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
            for (const run of speculationRef.current.clear()) abandon(run.handle)
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
    [
      abandon,
      considerSpeculation,
      ensureCapture,
      scheduleListen,
      sendMessage,
      setPhase,
      setVoiceMode,
    ],
  )

  startListeningRef.current = startListening

  const handleVoiceControl = useCallback(() => {
    if (voiceModeRef.current === 'active') {
      setVoiceMode('muted')
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
      listenerRef.current?.abort()
      listenerRef.current = null
      stopPartials()
      dropEager()
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
  }, [abandon, dropEager, setPhase, setVoiceMode, startListening, stopPartials, stopVoice])

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
          thinking: working ?? 'Thinking with you…',
          replying: working ?? 'Replying',
          speaking: 'Speaking · cut in any time',
          paused: 'Quiet pause',
        }[phase]

  const voiceControl =
    voiceMode === 'paused'
      ? {
          icon: <Play size={19} fill="currentColor" />,
          label: 'Resume voice',
          hint: pauseReason === 'blocked' ? 'Microphone blocked' : 'Tap to listen again',
        }
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

  /**
   * History, plus whichever turn has not settled into it yet.
   *
   * Nothing appears twice: a user line joins `messages` the moment its turn is
   * promoted, and the reply joins on settle, so the live entry below is only
   * ever the one that genuinely has nowhere else to live. A reply that has
   * settled but is still being spoken keeps the live entry's key and caption,
   * so its words keep arriving with the voice instead of all at once.
   */
  const stream: StreamEntry[] = messages.map((message) => {
    if (message.id === voicingId) {
      return {
        id: `live-${captionTurn}`,
        role: 'assistant',
        content: assistantCaption,
        cut: false,
        live: true,
      }
    }
    const cut = INTERRUPTED.test(message.content)
    return {
      id: message.id,
      role: message.role,
      content: cut ? message.content.replace(INTERRUPTED, '') : message.content,
      cut,
      live: false,
    }
  })

  if (stream[stream.length - 1]?.role === 'user') {
    stream.push({
      id: `live-${captionTurn}`,
      role: 'assistant',
      content: assistantCaption,
      cut: false,
      live: true,
    })
  } else if (liveTranscript.trim()) {
    stream.push({ id: 'live-user', role: 'user', content: liveTranscript, cut: false, live: true })
  }

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

        <div className="transcript-frame">
          <div className="transcript-veil" aria-hidden="true" />
          <div
            className="transcript"
            ref={transcriptRef}
            onScroll={(event) => {
              const node = event.currentTarget
              followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72
            }}
            aria-live="polite"
            aria-atomic="false"
          >
            <div className="transcript-flow">
              {stream.map((entry, index) => {
                const current = index === stream.length - 1

                if (entry.role === 'user') {
                  return (
                    <p className="turn-said" data-role="user" data-current={current} key={entry.id}>
                      <span className="turn-who">You</span>
                      {entry.content}
                    </p>
                  )
                }

                return (
                  <p
                    className="turn-said"
                    data-role="gideon"
                    data-current={current}
                    key={entry.id}
                  >
                    <span className="turn-who">Gideon</span>
                    {entry.live && !entry.content ? (
                      <span className="thought-pulse">•••</span>
                    ) : entry.live ? (
                      words.map((word, wordIndex) => (
                        <span
                          className={`caption-word${spokenIndex[wordIndex] ? ' is-spoken' : ''}`}
                          key={`${captionTurn}-${wordIndex}`}
                        >
                          {word}
                        </span>
                      ))
                    ) : (
                      entry.content
                    )}
                    {entry.cut ? <em className="turn-cut">cut short</em> : null}
                  </p>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      {ledger.length || links.length ? (
        <section className="action-ledger" aria-label="What GIDEON did">
          {ledger.map((entry) => (
            <p
              className="ledger-entry"
              data-ok={entry.ok}
              data-pending={entry.pending ? 'true' : undefined}
              key={entry.id}
            >
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
          {voiceMode === 'paused' && pauseReason === 'quiet' ? (
            <small>30 seconds of quiet · tap Resume below</small>
          ) : null}
          {voiceMode === 'paused' && pauseReason === 'blocked' ? (
            <small>Microphone blocked · allow it, then tap Resume</small>
          ) : null}
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

        <div className="dock-row" data-open={composerOpen}>
          <button
            type="button"
            className="voice-orb"
            data-mode={voiceMode}
            data-phase={phase}
            onClick={handleVoiceControl}
            aria-label={
              speechSupported
                ? `${voiceControl.label} · ${voiceControl.hint}`
                : 'Voice unavailable — type instead'
            }
            aria-pressed={voiceMode === 'active'}
            title={
              speechSupported
                ? `${voiceControl.label} · ${voiceControl.hint}`
                : 'Voice unavailable'
            }
          >
            {speechSupported ? voiceControl.icon : <MicOff size={19} />}
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

          <div className="text-composer" data-open={composerOpen}>
            <label className="sr-only" htmlFor="message-input">
              Type to GIDEON
            </label>
            <textarea
              id="message-input"
              ref={textareaRef}
              value={draft}
              rows={1}
              maxLength={8000}
              placeholder={composerOpen ? 'Say it in writing…' : 'Type…'}
              onFocus={() => setComposerOpen(true)}
              // A half-written thought keeps the field open; an empty one lets
              // it fall back to a pill so the eyes have the room again.
              onBlur={() => setComposerOpen(Boolean(draft.trim()))}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.currentTarget.blur()
                  return
                }
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
        </div>
      </section>
    </main>
  )
}
