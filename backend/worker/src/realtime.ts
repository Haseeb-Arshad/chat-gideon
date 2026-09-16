/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers'
import { originAllowed } from '../../../src/lib/guard'
import { LOCATION_HEADER, decodeLocation, readLocation, type CoarseLocation } from '../../../src/lib/location'
import { setRuntimeEnv } from '../../../src/lib/runtime-env'
import { createRealtimeSession, type RealtimeSession } from '../../../src/lib/realtime-session'
import type { Memory, MemoryStore } from '../../../src/lib/tools/memory'
import { OWNER_HEADER } from './accounts'
import { callerFromRequest, sessionIdFromRequest } from './identity'
import {
  DurableObjectMemoryStore,
  adoption,
  hasSupabaseMemory,
  SupabaseMemoryStore,
} from './memory'
import type { Env } from './types'

interface SessionAttachment {
  /** Whose memory this is: `user/<id>` for an account, otherwise the browser's id. */
  owner: string
  caller: string
  host: string | null
  /** Roughly where the socket was opened from, as the Worker found it. */
  location: CoarseLocation | null
}

function attachmentOf(socket: WebSocket): SessionAttachment | null {
  const value = socket.deserializeAttachment()
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<SessionAttachment>
  if (
    typeof candidate.owner !== 'string' ||
    typeof candidate.caller !== 'string'
  ) {
    return null
  }
  return {
    owner: candidate.owner,
    caller: candidate.caller,
    host: typeof candidate.host === 'string' ? candidate.host : null,
    location: readLocation(candidate.location),
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

  /**
   * One store for every socket on this object.
   *
   * Each socket used to build its own, and a store caches what it read, so two
   * tabs each wrote back their own copy and the later write erased what the
   * other had just learned. An object named by an account is shared by every
   * tab and device that account opens, which makes that the normal case.
   */
  private localMemory: DurableObjectMemoryStore | null = null
  private remoteMemory: SupabaseMemoryStore | null = null

  private local() {
    this.localMemory ??= new DurableObjectMemoryStore(this.ctx.storage)
    return this.localMemory
  }

  private memoryFor(owner: string): MemoryStore {
    if (!hasSupabaseMemory(this.env)) return this.local()
    this.remoteMemory ??= new SupabaseMemoryStore(this.env, owner)
    return this.remoteMemory
  }

  /** What this object remembers, read by an account taking over from a browser's id. */
  async memories(): Promise<Memory[]> {
    return this.local().all()
  }

  /** Takes on a browser's memories, unless this object already remembers something. */
  async adopt(memories: Memory[]): Promise<number> {
    return this.local().mutate((current) => adoption(current, memories))
  }

  private createSession(socket: WebSocket, attachment: SessionAttachment) {
    const memoryStore = this.memoryFor(attachment.owner)

    return createRealtimeSession(
      {
        sendText: (data) => socket.send(data),
        sendBinary: (data) => socket.send(data),
      },
      {
        caller: attachment.caller,
        host: attachment.host,
        memoryStore,
        location: attachment.location,
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
      // Set by the Worker once it has checked the account cookie.
      owner: request.headers.get(OWNER_HEADER) || sessionIdFromRequest(request),
      caller: callerFromRequest(request),
      host: request.headers.get('host'),
      // Set by the Worker in front of this object, which removes any a client sent.
      location: decodeLocation(request.headers.get(LOCATION_HEADER)),
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

