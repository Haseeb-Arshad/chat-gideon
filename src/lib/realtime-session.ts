/**
 * One live GIDEON session over a persistent socket.
 *
 * This module knows nothing about the socket implementation. The dev-time Vite
 * plugin wires it to a `ws` connection; any other Node host can wire it the same
 * way. Frames are the ones defined in `protocol.ts`, identical to the HTTP
 * fallback, so the browser never branches on transport.
 *
 * The socket does buy one thing the fallback cannot: the server can ask the
 * browser to run a tool and wait for the answer. That is what `pendingTools`
 * below is for, and it is the reason the realtime path is not merely a faster
 * version of the HTTP one.
 */

import {
  availableTools,
  fetchVoice,
  getPublicConfig,
  streamTurn,
  transcribeAudio,
  warmUpstream,
  type ClientToolBridge,
} from './agent-core'
import { RequestValidationError, parseChatBody, parseVoiceBody } from './openrouter'
import { parseVoiceChoice, type VoiceChoice } from './voice-options'
import { limiter, rateLimited } from './guard'
import type { ToolOutcome } from './tools/registry'
import { readScreen } from './stage-judge'
import { readConversationState } from './conversation-state'
import type { CoarseLocation } from './location'
import type { MemoryStore } from './tools/memory'
import type { MemorySession } from './memory'
import type { MemoryTurnRuntime } from './memory/turn-runtime'
import { DeliveryObservationLedger } from './delivery-observations'
import { splitSpeakable } from './spoken-chunks'
import type { InteractionAudit, InteractionAuditFactory } from './interaction-audit'
import {
  REALTIME_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type ServerFrame,
} from './protocol'

export interface RealtimeSink {
  sendText: (data: string) => void
  sendBinary: (data: Uint8Array) => void
}

export interface RealtimeSession {
  /** Resolves when the frame's async work has finished. */
  handleMessage: (raw: string) => Promise<void>
  close: () => void
}

export interface SessionOptions {
  /**
   * Who opened this socket, for rate limiting.
   *
   * The HTTP routes meter per caller through `gate()`; without this the
   * socket — the primary transport — was the one path to the OpenRouter key
   * with no limit on it at all.
   */
  caller?: string
  /** The Host the socket was opened against, which decides whether to meter. */
  host?: string | null
  /** Durable store selected by the host for this browser session. */
  memoryStore?: MemoryStore
  /** Server-bound identity/grants for model-visible memory tools. */
  memorySession?: MemorySession<MemoryStore>
  /** Canonical server-selected memory adapter; never client-supplied. */
  memoryRuntime?: MemoryTurnRuntime
  /** Optional durable audit writer supplied by a Worker host. */
  auditFactory?: InteractionAuditFactory | null
  /** A host may resolve owner-scoped memory afresh for each turn. */
  resolveMemory?: () => Promise<{
    memoryStore: MemoryStore
    memorySession: MemorySession<MemoryStore>
    memoryRuntime?: MemoryTurnRuntime
    close(): Promise<void>
  }>
  /** Roughly where the user is, from the host's address lookup when the socket opened. */
  location?: CoarseLocation | null
  /** Called when the socket goes live and whenever speech arrives, so a host can ready what the next turn would otherwise wait for. */
  warm?: () => void
}

/**
 * How long the server waits for the browser to fulfil a tool.
 *
 * The user is sitting in silence for this whole window, so it is deliberately
 * short. A browser that has navigated away, or a tool the page refuses, must
 * not hold a turn open indefinitely.
 */
const CLIENT_TOOL_TIMEOUT_MS = 8_000
/** Finding the user can wait on them reading the browser's question and answering it. */
const LOCATE_TIMEOUT_MS = 30_000

interface PendingTool {
  resolve: (outcome: ToolOutcome) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

/** A spoken segment the browser has been sent, so its playback reports can be timed. */
interface SpokenSegment {
  turnId: string
  endChar: number
  started: boolean
  ended: boolean
}

/** How far a browser's clock may sit from this one before its timestamps are not believed. */
const CLOCK_TOLERANCE_MS = 10 * 60_000

/** A browser-supplied epoch time, or this server's when it is missing or implausible. */
function clientTime(value: unknown, now = Date.now()): number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value - now) <= CLOCK_TOLERANCE_MS ? Math.round(value) : now
}

/** The browser's own marks for a turn, bounded before they are stored. */
function readMarks(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const marks: Record<string, number> = {}
  for (const [name, at] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
    if (/^[a-z_]{1,40}$/u.test(name) && typeof at === 'number' && Number.isFinite(at)) marks[name] = Math.round(at)
  }
  return marks
}

export function createRealtimeSession(
  sink: RealtimeSink,
  options: SessionOptions = {},
): RealtimeSession {
  const caller = options.caller || 'socket'
  const metered = rateLimited(options.host ?? null)
  /** Aborts keyed by turn id, so a cancel only kills the turn it names. */
  const turns = new Map<string, AbortController>()
  /** Bounded provenance for this socket only; reports never become memory. */
  const delivery = new DeliveryObservationLedger()
  /** Tool calls the browser has been asked to run and has not answered yet. */
  const pendingTools = new Map<string, PendingTool>()
  /** Spoken segments by the id the browser reports playback against. */
  const spoken = new Map<string, SpokenSegment>()
  let closed = false

  /**
   * Recording is never allowed to take a turn down with it, or to be waited on:
   * the record is a note for a background writer, and a host whose writer is
   * broken still has to answer.
   */
  const noted = <T>(work: (factory: InteractionAuditFactory) => T): T | null => {
    if (!options.auditFactory) return null
    try {
      return work(options.auditFactory)
    } catch {
      return null
    }
  }

  const send = (frame: ServerFrame) => {
    if (closed) return
    try {
      sink.sendText(encodeFrame(frame))
    } catch {
      closed = true
    }
  }

  const controllerFor = (id: string) => {
    const existing = turns.get(id)
    if (existing) return existing
    const controller = new AbortController()
    turns.set(id, controller)
    return controller
  }

  /**
   * One gate for every frame that costs money.
   *
   * Same buckets as the HTTP routes, so a caller cannot get a second budget
  * simply by preferring the socket.
  */
  const allowed = (id: string, limit: 'turn' | 'speak' | 'transcribe') => {
    if (!metered) return true

    const decision = limiter.check(caller, limit)
    if (!decision.allowed) {
      send({
        t: 'error',
        id,
        code: 'rate_limited',
        message: 'That is more than this GIDEON is configured to answer. Try again shortly.',
        retryable: true,
      })
      return false
    }
    return true
  }

  /**
   * The last line between one bad frame and the whole process.
   *
   * These handlers are dispatched without being awaited, so any rejection that
   * escapes them is unhandled — and an unhandled rejection ends the Node
   * process, taking every other connected session with it. That is exactly
   * what a cancelled voice chunk used to do. A failure here is reported to the
   * one client that caused it and goes no further.
   */
  const guarded = (id: string, work: Promise<void>) =>
    work.catch((error: unknown) => {
      if ((error as Error)?.name === 'AbortError') return
      send({
        t: 'error',
        id,
        code: 'session_failed',
        message: 'That turn could not be completed.',
        retryable: true,
      })
    })

  const settleTool = (call: string, outcome: ToolOutcome) => {
    const pending = pendingTools.get(call)
    if (!pending) return
    pendingTools.delete(call)
    clearTimeout(pending.timer)
    pending.cleanup()
    pending.resolve(outcome)
  }

  /**
   * The server's half of a browser-run tool.
   *
   * The `tool_request` frame has already gone out by the time this is awaited;
   * this only waits for the reply, and resolves rather than rejects on timeout
   * so the agent loop can tell the model what happened instead of the whole
   * turn collapsing over one unavailable tool.
   */
  /** Where the user's device placed them, once a tool had to ask. Kept for the socket's life, never stored. */
  let located: CoarseLocation | null = null

  const toolKey = (turnId: string, callId: string) => JSON.stringify([turnId, callId])
  const bridgeFor = (turnId: string): ClientToolBridge => ({
    call: (callId, name, _args, signal) =>
      new Promise<ToolOutcome>((resolve) => {
        if (closed || signal.aborted) {
          resolve({ ok: false, content: 'The connection closed before that could run.' })
          return
        }

        const key = toolKey(turnId, callId)
        const abort = () => settleTool(key, { ok: false, content: 'That turn was cancelled.' })
        const timer = setTimeout(() => settleTool(key, {
          ok: false,
          content: `The browser did not complete ${name} in time. Tell the user it did not go through.`,
        }), name === 'get_location' ? LOCATE_TIMEOUT_MS : CLIENT_TOOL_TIMEOUT_MS)
        pendingTools.set(key, {
          resolve, timer, cleanup: () => signal.removeEventListener('abort', abort),
        })
        signal.addEventListener('abort', abort, { once: true })
      }),
  })

  async function runTurn(frame: Extract<ClientFrame, { t: 'turn' }>) {
    let messages
    let voiceChoice: VoiceChoice | undefined
    try {
      messages = parseChatBody({ messages: frame.messages })
      voiceChoice = parseVoiceChoice(frame.voiceChoice)
    } catch (error) {
      const validation = error as RequestValidationError
      send({
        t: 'error',
        id: frame.id,
        code: validation.code || 'invalid_request',
        message: validation.message || 'That conversation could not be read.',
        retryable: false,
      })
      return
    }

    const controller = controllerFor(frame.id)
    // Before anything is awaited, so a report about this turn that arrives on
    // the very next frame already finds it.
    const audit: InteractionAudit | null = noted((factory) => factory.startTurn({
      clientTurnId: frame.id, messages, speculative: frame.speculative === true,
    }))
    let memoryContext: Awaited<ReturnType<NonNullable<SessionOptions['resolveMemory']>>> | null = null
    let status: 'completed' | 'failed' | 'cancelled' = 'failed'
    let deltas = 0
    let firstSpeech: Promise<void> | null = null
    let responseText = ''
    const turnStarted = Date.now()
    let firstToken = false
    const startFirstSpeech = (responseId: string | undefined, flush = false) => {
      if (frame.autoSpeech !== true || frame.speculative || firstSpeech || !responseId || controller.signal.aborted) return
      const chunk = splitSpeakable(responseText, { first: true, flush }).chunks[0]
      if (!chunk) return
      const id = `${frame.id}#0`
      if (!allowed(id, 'speak')) return
      firstSpeech = guarded(id, runSpeak({ t: 'speak', id, seq: 0, text: chunk.text, voiceChoice,
        turnId: frame.id, responseId, startChar: chunk.startChar, endChar: chunk.endChar }))
    }
    try {
      memoryContext = await options.resolveMemory?.() ?? null
      audit?.mark('setup')
      if (frame.timing === true) send({ t: 'timing', id: frame.id, stage: 'turn_setup', ms: Date.now() - turnStarted })
      for await (const event of streamTurn(frame.id, messages, controller.signal, {
        timezone: typeof frame.timezone === 'string' ? frame.timezone.slice(0, 64) : undefined,
        bridge: bridgeFor(frame.id),
        speculative: frame.speculative === true,
        memoryStore: memoryContext?.memoryStore ?? options.memoryStore,
        memorySession: memoryContext?.memorySession ?? options.memorySession,
        memoryRuntime: memoryContext?.memoryRuntime ?? options.memoryRuntime,
        audit: audit ?? undefined,
        screen: readScreen(frame.screen),
        conversationState: readConversationState(frame.conversationState),
        // The device's own answer, once a tool has had to ask, is surer than the address lookup.
        location: located ?? options.location ?? null,
        onLocation: (location) => {
          located = location
        },
      })) {
        const durableToolReceipt = event.t === 'action' && event.pending !== true
        if (closed || (controller.signal.aborted && !durableToolReceipt)) { status = 'cancelled'; return }
        if (event.t === 'done') {
          audit?.mark('done')
          audit?.record('released_frame', { type: event.t, turnId: event.id, responseId: event.responseId, deltas })
          status = 'completed'
        } else if (event.t === 'delta') {
          // The words are kept once, whole, when the reply is; a row per token
          // told a reader nothing the finished text and its timings do not.
          deltas += 1
        } else {
          audit?.record('released_frame', { type: event.t, frame: event })
        }
        if (event.t === 'start' && event.responseId) {
          delivery.beginResponse(event.id, event.responseId)
        } else if (event.t === 'delta' && event.responseId && event.segmentId
          && Number.isSafeInteger(event.startChar) && Number.isSafeInteger(event.endChar)) {
          delivery.appendTextSegment({
            turnId: event.id,
            responseId: event.responseId,
            segmentId: event.segmentId,
            startChar: event.startChar!,
            endChar: event.endChar!,
            text: event.text,
          })
        } else if (event.t === 'done' && event.responseId) {
          delivery.completeResponse(event.id, event.responseId, event.text)
        } else if (event.t === 'card' && event.artifactId && event.displayRevision) {
          delivery.issueArtifact(event.id, event.artifactId, event.displayRevision)
        } else if (event.t === 'card_patch' && event.artifactId && event.displayRevision) {
          delivery.issueArtifact(event.id, event.artifactId, event.displayRevision)
        }
        send(event)
        if (event.t === 'delta') {
          if (!firstToken) {
            audit?.mark('first_token')
            if (frame.timing === true) send({ t: 'timing', id: frame.id, stage: 'turn_first_token', ms: Date.now() - turnStarted })
          }
          firstToken = true; responseText += event.text; startFirstSpeech(event.responseId)
        }
        else if (event.t === 'done') { responseText = event.text; startFirstSpeech(event.responseId, true) }
        if (controller.signal.aborted && durableToolReceipt) return
      }
    } finally {
      if (controller.signal.aborted) turns.get(`${frame.id}#0`)?.abort()
      await firstSpeech
      try { audit?.finish(status) } catch { /* The record is lost; the turn is not. */ }
      await memoryContext?.close().catch(() => undefined)
      turns.delete(frame.id)
    }
  }

  async function runTranscription(frame: Extract<ClientFrame, { t: 'transcribe' }>) {
    if (typeof frame.id !== 'string' || !/^stt-[\w-]{1,100}$/.test(frame.id) ||
      typeof frame.audio !== 'string' || !frame.audio.length || frame.audio.length > 1_365_336 ||
      (frame.caption !== undefined && typeof frame.caption !== 'boolean')) {
      send({ t: 'error', id: typeof frame.id === 'string' ? frame.id.slice(0, 110) : null, code: 'invalid_audio', message: 'That recording could not be read.', retryable: false })
      return
    }
    let audio: Uint8Array
    try { audio = Uint8Array.from(atob(frame.audio), ch => ch.charCodeAt(0)) } catch {
      send({ t: 'error', id: frame.id, code: 'invalid_audio', message: 'That recording could not be read.', retryable: false }); return
    }
    if (!audio.length || audio.length > 1_024_000) return
    if (turns.has(frame.id)) {
      send({ t: 'error', id: frame.id, code: 'duplicate_transcription', message: 'That recording is already being recognized.', retryable: false }); return
    }
    const controller = controllerFor(frame.id)
    // Someone is speaking, so a turn is about to follow: have its memory ready.
    try { options.warm?.() } catch { /* Best effort. */ }
    try {
      const recognitionStarted = Date.now()
      const language = typeof frame.language === 'string' ? frame.language.slice(0, 35) : undefined
      const result = await transcribeAudio(audio.buffer as ArrayBuffer, controller.signal, { language, caption: frame.caption === true })
      if (closed || controller.signal.aborted) return
      const recognitionMs = Date.now() - recognitionStarted
      if (frame.timing === true) send({ t: 'timing', id: frame.id, stage: 'recognition', ms: recognitionMs })
      // The words go back the moment they are known. A caption is a throwaway
      // read of speech still being spoken; only the finished utterance is kept,
      // and keeping it is the background writer's work, not this reply's.
      if (result.ok) send({ t: 'transcript', id: frame.id, text: result.text, model: result.model })
      else send({ t: 'error', id: frame.id, code: result.code, message: result.message, retryable: result.retryable })
      if (!frame.caption) {
        noted((factory) => factory.recordSpeech({
          source: 'user', mime: 'audio/wav', audio, endedAt: clientTime(frame.at),
          ...(result.ok ? { text: result.text } : {}),
          metadata: {
            transcriptionId: frame.id, language: language ?? null, recognitionMs, receivedAt: recognitionStarted,
            ...(result.ok ? { transcriptionModel: result.model } : { transcriptionFailed: result.code }),
          },
        }))
      }
    } finally { if (turns.get(frame.id) === controller) turns.delete(frame.id) }
  }

  async function runSpeak(frame: Extract<ClientFrame, { t: 'speak' }>) {
    let text: string
    let voiceChoice: VoiceChoice | undefined
    try {
      text = parseVoiceBody({ text: frame.text })
      voiceChoice = parseVoiceChoice(frame.voiceChoice)
    } catch (error) {
      const validation = error as RequestValidationError
      send({
        t: 'error',
        id: frame.id,
        code: validation.code || 'invalid_voice_request',
        message: validation.message || 'That line could not be spoken.',
        retryable: false,
      })
      return
    }

    const provenanceSupplied = frame.turnId !== undefined || frame.responseId !== undefined
      || frame.startChar !== undefined || frame.endChar !== undefined
    if (provenanceSupplied) {
      const response = typeof frame.turnId === 'string' && typeof frame.responseId === 'string'
        ? delivery.response(frame.turnId, frame.responseId)
        : null
      if (!response || !Number.isSafeInteger(frame.startChar) || !Number.isSafeInteger(frame.endChar)
        || frame.startChar! < 0 || frame.endChar! <= frame.startChar!
        || response.text.slice(frame.startChar, frame.endChar) !== text) {
        send({
          t: 'error', id: frame.id, code: 'invalid_delivery_binding',
          message: 'That spoken segment did not match the generated reply.', retryable: false,
        })
        return
      }
    }

    const controller = controllerFor(frame.id)
    // A chunk is asked for as `<turn>#<seq>`; the turn is what it is filed under.
    const clientTurnId = typeof frame.turnId === 'string' ? frame.turnId : String(frame.id).replace(/#\d+$/u, '')
    const synthesisStarted = Date.now()
    try {
      const result = await fetchVoice(text, controller.signal, voiceChoice)
      if (closed || controller.signal.aborted) return

      if (!result.ok || !result.body) {
        if (result.code === 'aborted') return
        noted((factory) => factory.recordEvent({
          clientTurnId,
          type: 'voice_generation_failed',
          payload: { id: frame.id, seq: frame.seq, code: result.code, retryable: result.retryable, ms: Date.now() - synthesisStarted },
        }))
        send({
          t: 'error',
          id: frame.id,
          code: result.code,
          message: result.message,
          retryable: result.retryable,
        })
        return
      }

      const segmentId = crypto.randomUUID()
      let audioProvenance: { responseId: string; segmentId: string; startChar: number; endChar: number } | undefined
      if (provenanceSupplied) {
        const segment = {
          turnId: frame.turnId!,
          responseId: frame.responseId!,
          segmentId,
          startChar: frame.startChar!,
          endChar: frame.endChar!,
          text,
        }
        if (!delivery.issueAudioSegment(segment)) {
          send({
            t: 'error', id: frame.id, code: 'invalid_delivery_binding',
            message: 'That spoken segment could not be tied to the generated reply.', retryable: false,
          })
          return
        }
        audioProvenance = { responseId: segment.responseId, segmentId, startChar: segment.startChar, endChar: segment.endChar }
      }

      // Header first, binary immediately after. WebSocket preserves the order.
      send({
        t: 'audio',
        id: frame.id,
        seq: frame.seq,
        mime: result.mime,
        bytes: result.body.byteLength,
        ...audioProvenance,
      })
      try {
        sink.sendBinary(new Uint8Array(result.body))
      } catch {
        closed = true
      }

      // Kept after it has gone out, under the id the browser reports playback
      // against, so when it was actually heard can be filled in later.
      const body = result.body
      const mime = result.mime
      if (audioProvenance) {
        spoken.set(segmentId, { turnId: clientTurnId, endChar: audioProvenance.endChar, started: false, ended: false })
        if (spoken.size > 256) spoken.delete(spoken.keys().next().value!)
      }
      noted((factory) => factory.recordSpeech({
        source: 'assistant', clientTurnId, segmentId, audio: body, mime, text, seq: frame.seq,
        ...(audioProvenance ? { startChar: audioProvenance.startChar, endChar: audioProvenance.endChar } : {}),
        metadata: {
          requestId: frame.id, responseId: frame.responseId ?? null,
          voice: voiceChoice ?? null, synthesisMs: Date.now() - synthesisStarted, synthesisedAt: synthesisStarted,
        },
      }))
    } finally {
      // One controller per spoken chunk, and a reply is many chunks, so
      // forgetting this grew the map for the life of the connection.
      turns.delete(frame.id)
    }
  }

  /** When the browser showed a card, or reached and left each spoken segment. */
  function recordObservation(frame: Extract<ClientFrame, { t: 'observation' }>) {
    const at = clientTime(frame.at)
    if (frame.kind === 'displayed') {
      noted((factory) => {
        factory.recordEvent({ clientTurnId: frame.turnId, type: 'card_displayed', at, payload: { artifactId: frame.artifactId, displayRevision: frame.displayRevision } })
        // Counted once per card: later revisions are the same card growing.
        if (frame.displayRevision === 1) factory.amendTurn(frame.turnId, { cardsDisplayed: 1 })
      })
      return
    }
    if (frame.kind === 'playback_reported') {
      const segment = spoken.get(frame.segmentId)
      if (!segment) return
      const patch: { startedAt?: number; endedAt?: number } = {}
      if (!segment.started) { segment.started = true; patch.startedAt = at }
      if (!segment.ended && frame.endChar >= segment.endChar) { segment.ended = true; patch.endedAt = at }
      if (patch.startedAt !== undefined || patch.endedAt !== undefined) noted((factory) => factory.amendSpeech(frame.segmentId, patch))
      return
    }
    noted((factory) => {
      for (const [segmentId, segment] of spoken) {
        if (segment.turnId !== frame.turnId || segment.ended) continue
        segment.ended = true
        // Cut off while playing, or still queued when the user spoke over it.
        factory.amendSpeech(segmentId, segment.started ? { endedAt: at, interrupted: true } : { interrupted: true })
      }
      factory.recordEvent({ clientTurnId: frame.turnId, type: 'playback_interrupted', at, payload: { atChar: frame.startChar } })
      factory.amendTurn(frame.turnId, { interrupted: true, interruptedAtChar: frame.startChar, interruptedAt: at })
    })
  }

  /** What only the browser knows about a turn: whether it was used, and when it was heard. */
  function recordTelemetry(frame: Extract<ClientFrame, { t: 'telemetry' }>) {
    if (typeof frame.id !== 'string' || !frame.id || frame.id.length > 200) return
    const at = clientTime(frame.at)
    const source = frame.source === 'voice' || frame.source === 'typed' || frame.source === 'card' ? frame.source : undefined
    const speculation = frame.speculation === 'hit' || frame.speculation === 'miss' || frame.speculation === 'none' ? frame.speculation : undefined
    noted((factory) => {
      if (frame.kind === 'committed') {
        factory.amendTurn(frame.id, { committed: true, ...(source ? { source } : {}), ...(speculation ? { speculation } : {}), committedAt: at })
      } else if (frame.kind === 'finished') {
        const marks = readMarks(frame.marks)
        factory.amendTurn(frame.id, {
          finishedAt: at,
          interrupted: frame.interrupted === true,
          ...(speculation ? { speculation } : {}),
          ...(typeof frame.savedMs === 'number' && Number.isFinite(frame.savedMs) ? { savedMs: Math.round(frame.savedMs) } : {}),
          ...(marks ? { marks } : {}),
        })
      } else if (frame.kind === 'card' && typeof frame.action === 'string' && /^[a-z_]{1,40}$/u.test(frame.action)) {
        factory.recordEvent({
          clientTurnId: frame.id, type: `card_${frame.action}`, at,
          payload: { card: typeof frame.card === 'string' ? frame.card.slice(0, 200) : null, artifactId: typeof frame.artifactId === 'string' ? frame.artifactId.slice(0, 200) : null },
        })
      }
    })
  }

  return {
    async handleMessage(raw: string) {
      if (closed) return
      if (raw.length > 1_500_000) return
      const frame = decodeFrame<ClientFrame>(raw)
      if (!frame || typeof frame.t !== 'string') return

      switch (frame.t) {
        case 'hello': {
          warmUpstream()
          try { options.warm?.() } catch { /* Warming is best effort; the first turn does it itself otherwise. */ }
          const config = getPublicConfig()
          send({
            t: 'ready',
            version: REALTIME_PROTOCOL_VERSION,
            ...config,
            // Browser-run tools are reachable over this transport, so they are
            // included here and absent from the HTTP fallback's config.
            tools: availableTools(true),
            transcriptionSocket: true,
            autoSpeech: true,
          })
          return
        }
        case 'turn':
          if (!allowed(frame.id, 'turn')) return
          return guarded(frame.id, runTurn(frame))
        case 'speak':
          if (!allowed(frame.id, 'speak')) return
          return guarded(frame.id, runSpeak(frame))
        case 'transcribe':
          if (!allowed(frame.id, 'transcribe')) return
          return guarded(frame.id, runTranscription(frame))
        case 'observation':
          // Only a report this socket can tie to something it issued is kept.
          if (delivery.accept(frame)) recordObservation(frame)
          return
        case 'telemetry':
          recordTelemetry(frame)
          return
        case 'tool_reply': {
          settleTool(toolKey(frame.id, frame.call), {
            ok: Boolean(frame.ok),
            content:
              typeof frame.content === 'string' && frame.content.trim()
                ? frame.content.slice(0, 2_000)
                : frame.ok
                  ? 'Done.'
                  : 'That did not work.',
          })
          return
        }
        case 'cancel': {
          turns.get(frame.id)?.abort()
          turns.get(`${frame.id}#0`)?.abort()
          turns.delete(frame.id)
          return
        }
        case 'ping':
          send({ t: 'pong', at: frame.at })
          return
        default:
          return
      }
    },

    close() {
      closed = true
      for (const controller of turns.values()) controller.abort()
      turns.clear()
      for (const [call, pending] of pendingTools) {
        clearTimeout(pending.timer)
        pending.cleanup()
        pending.resolve({ ok: false, content: 'The connection closed.' })
        pendingTools.delete(call)
      }
    },
  }
}
