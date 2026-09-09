/**
 * Serves GIDEON's realtime socket on any Node HTTP server.
 *
 * This is the piece that stops the socket from being a development-only
 * convenience. It knows nothing about Vite or Nitro: it takes an HTTP server,
 * claims exactly one upgrade path on it, and leaves every other upgrade — Vite's
 * own HMR socket included — untouched. The dev plugin and the production entry
 * both call this, so there is one implementation of the origin check and the
 * session wiring rather than two that can drift apart.
 */

import { REALTIME_PATH } from '../lib/protocol'
import { callerKey, limiter, originAllowed, rateLimited } from '../lib/guard'
import { createRealtimeSession } from '../lib/realtime-session'

/** Minimal structural view of `ws`, which ships without type declarations. */
interface NodeWebSocket {
  on: (event: string, listener: (...args: Array<never>) => void) => void
  send: (data: string | Uint8Array) => void
  close: () => void
  readyState: number
}

interface NodeWebSocketServer {
  handleUpgrade: (
    request: IncomingLike,
    socket: DuplexLike,
    head: Buffer,
    callback: (socket: NodeWebSocket) => void,
  ) => void
}

interface IncomingLike {
  url?: string
  headers: Record<string, string | string[] | undefined>
}

interface DuplexLike {
  write: (data: string) => void
  destroy: () => void
}

interface ServerLike {
  on: (
    event: 'upgrade',
    listener: (request: IncomingLike, socket: DuplexLike, head: Buffer) => void,
  ) => void
}

const OPEN = 1

function headerValue(request: IncomingLike, name: string): string | null {
  const value = request.headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

async function createWebSocketServer(): Promise<NodeWebSocketServer> {
  const ws = (await import('ws')) as unknown as {
    WebSocketServer?: new (options: { noServer: boolean }) => NodeWebSocketServer
    default?: { WebSocketServer: new (options: { noServer: boolean }) => NodeWebSocketServer }
  }
  const WebSocketServer = ws.WebSocketServer ?? ws.default?.WebSocketServer
  if (!WebSocketServer) throw new Error('The ws package did not expose WebSocketServer.')
  return new WebSocketServer({ noServer: true })
}

export interface AttachOptions {
  /** Reports a failed upgrade. Defaults to silence, so a host can stay quiet. */
  onError?: (message: string) => void
  /**
   * Close upgrades to any other path.
   *
   * Node leaves an unanswered upgrade open, so where this is the only handler
   * on the server — production — anything else would sit there holding a
   * socket. In development it must stay off: Vite's HMR socket is an upgrade
   * to a different path and is none of our business.
   */
  rejectOther?: boolean
}

/**
 * Claims `/api/realtime` on `server`.
 *
 * The `ws` server is created lazily on the first upgrade rather than at attach
 * time: a deployment where nobody ever opens a socket should not pay for the
 * import, and doing it here keeps the function synchronous for the caller.
 */
export function attachRealtime(server: ServerLike, options: AttachOptions = {}) {
  let wss: NodeWebSocketServer | null = null

  server.on('upgrade', (request, socket, head) => {
    const path = (request.url || '').split('?')[0]
    if (path !== REALTIME_PATH) {
      if (options.rejectOther) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
      }
      return
    }

    void (async () => {
      try {
        // A socket upgrade is not subject to CORS, so without this check any
        // page anywhere could open one and spend the OpenRouter key. The
        // header is required rather than merely checked: only a browser
        // legitimately opens this, and browsers always send one.
        if (
          !originAllowed(headerValue(request, 'origin'), headerValue(request, 'host'), true)
        ) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }

        // Opening sockets is itself cheap enough to abuse, so the handshake
        // spends from the same bucket a config read would — but only where
        // there is anybody to protect against.
        const host = headerValue(request, 'host')
        const caller = callerKey({ get: (name) => headerValue(request, name) })
        if (rateLimited(host) && !limiter.check(caller, 'config').allowed) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }

        wss ??= await createWebSocketServer()
        wss.handleUpgrade(request, socket, head, (client) => {
          const session = createRealtimeSession(
            {
              sendText: (data) => {
                if (client.readyState === OPEN) client.send(data)
              },
              sendBinary: (data) => {
                if (client.readyState === OPEN) client.send(data)
              },
            },
            { caller, host },
          )

          client.on('message', ((data: Buffer | ArrayBuffer, isBinary: boolean) => {
            if (isBinary) return
            session.handleMessage(data.toString())
          }) as never)
          client.on('close', (() => session.close()) as never)
          client.on('error', (() => session.close()) as never)
        })
      } catch (error) {
        options.onError?.(`realtime upgrade failed: ${(error as Error).message}`)
        socket.destroy()
      }
    })()
  })
}

export { REALTIME_PATH } from '../lib/protocol'
