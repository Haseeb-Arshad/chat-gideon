/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers'
import { accessCodeRequired, accessCodeValid, originAllowed } from '../../../src/lib/guard'
import { decodeFrame, type ClientFrame } from '../../../src/lib/protocol'
import { setRuntimeEnv } from '../../../src/lib/runtime-env'
import { createRealtimeSession, type RealtimeSession } from '../../../src/lib/realtime-session'
import { callerFromRequest, sessionIdFromRequest } from './identity'
import {
  DurableObjectMemoryStore,
  hasSupabaseMemory,
  SupabaseMemoryStore,
} from './memory'
import type { Env } from './types'

interface SessionAttachment {
  sessionId: string
  caller: string
  host: string | null
  authorised: boolean
}

function attachmentOf(socket: WebSocket): SessionAttachment | null {
  const value = socket.deserializeAttachment()
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<SessionAttachment>
  if (
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.caller !== 'string' ||
    typeof candidate.authorised !== 'boolean'
  ) {
    return null
  }
  return {
    sessionId: candidate.sessionId,
    caller: candidate.caller,
    host: typeof candidate.host === 'string' ? candidate.host : null,
    authorised: candidate.authorised,
  }
}

/**
 * One hibernatable WebSocket session per browser session.
 *
 * Cloudflare can evict this object between messages without closing the
 * socket. Attachments restore the small connection metadata; Durable Object
 * storage or Supabase restores memory. Active model/tool promises are kept
 * alive with `waitUntil`, so hibernation only occurs between real work.
 */
export class GideonSession extends DurableObject<Env> {
  private readonly sessions = new Map<WebSocket, RealtimeSession>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    setRuntimeEnv(env)

    // Rebuild the in-memory session facade for sockets that survived a period
    // of hibernation. No active turn can be hibernated because its promise is
    // registered through waitUntil in webSocketMessage.
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(socket)
      if (attachment) this.sessions.set(socket, this.createSession(socket, attachment))
    }
  }

  private createSession(socket: WebSocket, attachment: SessionAttachment) {
    const memoryStore = hasSupabaseMemory(this.env)
      ? new SupabaseMemoryStore(this.env, attachment.sessionId)
      : new DurableObjectMemoryStore(this.ctx.storage)

    return createRealtimeSession(
      {
        sendText: (data) => socket.send(data),
        sendBinary: (data) => socket.send(data),
      },
      {
        caller: attachment.caller,
        host: attachment.host,
        memoryStore,
        authorised: attachment.authorised,
      },
    )
  }

  fetch(request: Request): Response {
    setRuntimeEnv(this.env)

    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 })
    }

    const origin = request.headers.get('origin')
    if (!originAllowed(origin, request.headers.get('host'), true)) {
      return new Response('That WebSocket origin is not allowed.', { status: 403 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)

    const attachment: SessionAttachment = {
      sessionId: sessionIdFromRequest(request),
      caller: callerFromRequest(request),
      host: request.headers.get('host'),
      authorised: !accessCodeRequired(),
    }
    server.serializeAttachment(attachment)
    this.sessions.set(server, this.createSession(server, attachment))

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Hibernation callbacks are synchronous on purpose. `waitUntil` keeps an
   * active turn alive without blocking the delivery of a later tool_reply or
   * cancel frame on the same socket.
   */
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return

    const attachment = attachmentOf(socket)
    if (!attachment) {
      socket.close(1011, 'Session metadata is missing')
      return
    }

    const frame = decodeFrame<ClientFrame>(message)
    if (frame?.t === 'hello' && !attachment.authorised) {
      if (accessCodeValid(typeof frame.access === 'string' ? frame.access : null)) {
        const next = { ...attachment, authorised: true }
        socket.serializeAttachment(next)
        this.sessions.delete(socket)
        const restored = this.createSession(socket, next)
        this.sessions.set(socket, restored)
      }
    }

    const session = this.sessions.get(socket)
    if (!session) return
    this.ctx.waitUntil(
      session.handleMessage(message).catch(() => {
        try {
          socket.close(1011, 'Session failed')
        } catch {
          // The peer already closed the socket.
        }
      }),
    )
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    this.sessions.get(socket)?.close()
    this.sessions.delete(socket)
    try {
      socket.close(code, reason)
    } catch {
      // The close event can arrive after the runtime has already closed it.
    }
  }

  webSocketError(socket: WebSocket) {
    this.sessions.get(socket)?.close()
    this.sessions.delete(socket)
  }
}

