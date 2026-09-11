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
  warmUpstream,
  type ClientToolBridge,
} from './agent-core'
import { RequestValidationError, parseChatBody, parseVoiceBody } from './openrouter'
import { accessCodeRequired, accessCodeValid, limiter, rateLimited } from './guard'
import type { ToolOutcome } from './tools/registry'
import { readScreen } from './stage-judge'
import type { MemoryStore } from './tools/memory'
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
  /** Restored authorization state for a hibernated Worker socket. */
  authorised?: boolean
}

/**
 * How long the server waits for the browser to fulfil a tool.
 *
 * The user is sitting in silence for this whole window, so it is deliberately
 * short. A browser that has navigated away, or a tool the page refuses, must
 * not hold a turn open indefinitely.
 */
const CLIENT_TOOL_TIMEOUT_MS = 8_000

interface PendingTool {
  resolve: (outcome: ToolOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

export function createRealtimeSession(
  sink: RealtimeSink,
  options: SessionOptions = {},
): RealtimeSession {
  const caller = options.caller || 'socket'
  const metered = rateLimited(options.host ?? null)
  /**
   * Whether this socket has presented the access code.
   *
   * Checked per frame rather than at the upgrade, because the browser cannot
   * attach a header to the handshake. Until it is satisfied the socket can do
   * nothing but say hello.
   */
  let authorised = options.authorised ?? !accessCodeRequired()
  /** Aborts keyed by turn id, so a cancel only kills the turn it names. */
  const turns = new Map<string, AbortController>()
  /** Tool calls the browser has been asked to run and has not answered yet. */
  const pendingTools = new Map<string, PendingTool>()
  let closed = false

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
  const allowed = (id: string, limit: 'turn' | 'speak') => {
    if (!authorised) {
      send({
        t: 'error',
        id,
        code: 'access_code_required',
        message: 'This GIDEON is behind an access code.',
        retryable: false,
      })
      return false
    }

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
  const bridge: ClientToolBridge = {
    call: (callId, name, _args, signal) =>
      new Promise<ToolOutcome>((resolve) => {
        if (closed || signal.aborted) {
          resolve({ ok: false, content: 'The connection closed before that could run.' })
          return
        }

        const timer = setTimeout(() => {
          pendingTools.delete(callId)
          resolve({
            ok: false,
            content: `The browser did not complete ${name} in time. Tell the user it did not go through.`,
          })
        }, CLIENT_TOOL_TIMEOUT_MS)

        pendingTools.set(callId, { resolve, timer })

        signal.addEventListener(
          'abort',
          () => settleTool(callId, { ok: false, content: 'That turn was cancelled.' }),
          { once: true },
        )
      }),
  }

  async function runTurn(frame: Extract<ClientFrame, { t: 'turn' }>) {
    let messages
    try {
      messages = parseChatBody({ messages: frame.messages })
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
    try {
      for await (const event of streamTurn(frame.id, messages, controller.signal, {
        timezone: typeof frame.timezone === 'string' ? frame.timezone.slice(0, 64) : undefined,
        bridge,
        speculative: frame.speculative === true,
        memoryStore: options.memoryStore,
        screen: readScreen(frame.screen),
      })) {
        if (closed || controller.signal.aborted) return
        send(event)
      }
    } finally {
      turns.delete(frame.id)
    }
  }

  async function runSpeak(frame: Extract<ClientFrame, { t: 'speak' }>) {
    let text: string
    try {
      text = parseVoiceBody({ text: frame.text })
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

    const controller = controllerFor(frame.id)
    try {
      const result = await fetchVoice(text, controller.signal)
      if (closed || controller.signal.aborted) return

      if (!result.ok || !result.body) {
        if (result.code === 'aborted') return
        send({
          t: 'error',
          id: frame.id,
          code: result.code,
          message: result.message,
          retryable: result.retryable,
        })
        return
      }

      // Header first, binary immediately after. WebSocket preserves the order.
      send({
        t: 'audio',
        id: frame.id,
        seq: frame.seq,
        mime: result.mime,
        bytes: result.body.byteLength,
      })
      try {
        sink.sendBinary(new Uint8Array(result.body))
      } catch {
        closed = true
      }
    } finally {
      // One controller per spoken chunk, and a reply is many chunks, so
      // forgetting this grew the map for the life of the connection.
      turns.delete(frame.id)
    }
  }

  return {
    async handleMessage(raw: string) {
      if (closed) return
      const frame = decodeFrame<ClientFrame>(raw)
      if (!frame || typeof frame.t !== 'string') return

      switch (frame.t) {
        case 'hello': {
          if (!authorised) {
            authorised = accessCodeValid(
              typeof frame.access === 'string' ? frame.access : null,
            )
            if (!authorised) {
              send({
                t: 'error',
                id: null,
                code: 'access_code_required',
                message: 'This GIDEON is behind an access code.',
                retryable: false,
              })
              return
            }
          }
          warmUpstream()
          const config = getPublicConfig()
          send({
            t: 'ready',
            version: REALTIME_PROTOCOL_VERSION,
            ...config,
            // Browser-run tools are reachable over this transport, so they are
            // included here and absent from the HTTP fallback's config.
            tools: availableTools(true),
          })
          return
        }
        case 'turn':
          if (!allowed(frame.id, 'turn')) return
          return guarded(frame.id, runTurn(frame))
        case 'speak':
          if (!allowed(frame.id, 'speak')) return
          return guarded(frame.id, runSpeak(frame))
        case 'tool_reply': {
          settleTool(frame.call, {
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
        pending.resolve({ ok: false, content: 'The connection closed.' })
        pendingTools.delete(call)
      }
    },
  }
}
