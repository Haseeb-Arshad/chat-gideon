/**
 * One live GIDEON session over a persistent socket.
 *
 * This module knows nothing about the socket implementation. The dev-time Vite
 * plugin wires it to a `ws` connection; any other Node host can wire it the same
 * way. Frames are the ones defined in `protocol.ts`, identical to the HTTP
 * fallback, so the browser never branches on transport.
 */

import {
  fetchVoice,
  getPublicConfig,
  streamTurn,
  warmUpstream,
} from './agent-core'
import { RequestValidationError, parseChatBody, parseVoiceBody } from './openrouter'
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
  handleMessage: (raw: string) => void
  close: () => void
}

export function createRealtimeSession(sink: RealtimeSink): RealtimeSession {
  /** Aborts keyed by turn id, so a cancel only kills the turn it names. */
  const turns = new Map<string, AbortController>()
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
      for await (const event of streamTurn(frame.id, messages, controller.signal)) {
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
  }

  return {
    handleMessage(raw: string) {
      if (closed) return
      const frame = decodeFrame<ClientFrame>(raw)
      if (!frame || typeof frame.t !== 'string') return

      switch (frame.t) {
        case 'hello': {
          warmUpstream()
          const config = getPublicConfig()
          send({ t: 'ready', version: REALTIME_PROTOCOL_VERSION, ...config })
          return
        }
        case 'turn':
          void runTurn(frame)
          return
        case 'speak':
          void runSpeak(frame)
          return
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
    },
  }
}
