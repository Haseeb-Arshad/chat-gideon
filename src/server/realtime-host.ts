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
import { callerKey, isLocalRequest, isTrustedAddress, limiter, originAllowed, rateLimited } from '../lib/guard'
import { createRealtimeSession } from '../lib/realtime-session'
import { nodeMemoryStore } from './identity'

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
  remoteAddress?: string
  encrypted?: boolean
}

interface ServerLike {
  on: (
    event: 'upgrade',
    listener: (request: IncomingLike, socket: DuplexLike, head: Buffer) => void,
  ) => void
}

const OPEN = 1

/** Marks an HTTP server that already has the realtime socket on it. */
const ATTACHED = Symbol.for('gideon.realtime.attached')

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
  /**
   * Where each connection gets its session from. Defaults to the one imported
   * here. Development passes a loader that asks Vite for the module again, so a
   * change to the session or the agent core reaches the next connection: the
   * import above is taken once, when the server starts, and would otherwise
   * keep answering with the code that was there then.
   */
  loadSession?: () => Promise<typeof createRealtimeSession>
}

/**
 * Claims `/api/realtime` on `server`.
 *
 * The `ws` server is created lazily on the first upgrade rather than at attach
 * time: a deployment where nobody ever opens a socket should not pay for the
 * import, and doing it here keeps the function synchronous for the caller.
 */
export function attachRealtime(server: ServerLike, options: AttachOptions = {}) {
  // Once per HTTP server. Vite restarts itself on the same server when its
  // config changes, and a second listener would claim every upgrade again: two
  // handlers on one socket fail it, and the page falls back to HTTP, where no
  // tool can ask the browser anything. A second attach takes the new options.
  const attached = server as ServerLike & { [ATTACHED]?: { options: AttachOptions } }
  if (attached[ATTACHED]) {
    attached[ATTACHED].options = options
    return
  }
  const current = { options }
  attached[ATTACHED] = current
  let wss: NodeWebSocketServer | null = null

  server.on('upgrade', (request, socket, head) => {
    const options = current.options
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
        const forwardedProtocol = isTrustedAddress(socket.remoteAddress)
          ? headerValue(request, 'x-forwarded-proto')?.split(',').at(-1)?.trim() : null
        const protocol = socket.encrypted || forwardedProtocol === 'https' ? 'https' : 'http'
        const requestHost = headerValue(request, 'host')
        if (!requestHost ||
          !originAllowed(headerValue(request, 'origin'), `${protocol}://${requestHost}`, true)
        ) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }

        // Opening sockets is itself cheap enough to abuse, so the handshake
        // spends from the same bucket a config read would — but only where
        // there is anybody to protect against. The socket's own peer address
        // decides trust: a spoofed forwarded chain cannot rotate identities.
        const host = isLocalRequest(socket.remoteAddress) ? headerValue(request, 'host') : null
        const caller = callerKey({ get: (name) => headerValue(request, name) }, 'unknown', 'none', socket.remoteAddress)
        if (rateLimited(host) && !limiter.check(caller, 'config').allowed) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }

        wss ??= await createWebSocketServer()
        wss.handleUpgrade(request, socket, head, (client) => {
          // The socket opens at once; the session may take a moment to load in
          // development, and whatever the browser says meanwhile waits for it.
          // A browser gives up on a socket that is slow to open, and falls back.
          let session: ReturnType<typeof createRealtimeSession> | null = null
          let closed = false
          const waiting: string[] = []
          const create = options.loadSession ? options.loadSession() : Promise.resolve(createRealtimeSession)
          void create
            .then((factory) => {
              // Only a valid server-issued cookie reaches the durable store; an
              // unverified socket gets memory that lives and dies with itself.
              // The same rule the HTTP fallback applies to its own request.
              session = factory(
                {
                  sendText: (data) => {
                    if (client.readyState === OPEN) client.send(data)
                  },
                  sendBinary: (data) => {
                    if (client.readyState === OPEN) client.send(data)
                  },
                },
                {
                  caller,
                  host,
                  memoryStore: nodeMemoryStore({
                    get: (name) => headerValue(request, name),
                  }),
                },
              )
              if (closed) return session.close()
              for (const message of waiting.splice(0)) session.handleMessage(message)
            })
            .catch((error: Error) => {
              options.onError?.(`realtime session failed to load: ${error.message}`)
              client.close()
            })

          client.on('message', ((data: Buffer | ArrayBuffer, isBinary: boolean) => {
            if (isBinary) return
            if (session) session.handleMessage(data.toString())
            else waiting.push(data.toString())
          }) as never)
          const end = () => {
            closed = true
            session?.close()
          }
          client.on('close', end as never)
          client.on('error', end as never)
        })
      } catch (error) {
        options.onError?.(`realtime upgrade failed: ${(error as Error).message}`)
        socket.destroy()
      }
    })()
  })
}

export { REALTIME_PATH } from '../lib/protocol'
