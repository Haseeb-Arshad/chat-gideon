/**
 * Development-time WebSocket host for GIDEON's realtime link.
 *
 * Vite owns the dev HTTP server, so the only way to serve a second WebSocket
 * endpoint alongside HMR is to claim the `upgrade` event for one path and leave
 * every other upgrade untouched. The socket runs the same `createRealtimeSession`
 * used by any Node host, so dev and a self-hosted production server behave
 * identically. Serverless targets (Vercel) cannot accept upgrades at all — the
 * browser client detects that and falls back to streaming HTTP on its own.
 */

import { loadEnv, type Plugin, type ViteDevServer } from 'vite'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { REALTIME_PATH } from './src/lib/protocol'
import type { RealtimeSession } from './src/lib/realtime-session'

/** Minimal structural view of `ws`, which ships without type declarations. */
interface NodeWebSocket {
  on: (event: string, listener: (...args: Array<never>) => void) => void
  send: (data: string | Uint8Array) => void
  close: () => void
  readyState: number
}

interface NodeWebSocketServer {
  handleUpgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: NodeWebSocket) => void,
  ) => void
}

type SessionFactory = (sink: {
  sendText: (data: string) => void
  sendBinary: (data: Uint8Array) => void
}) => RealtimeSession

const OPEN = 1

async function createServer(): Promise<NodeWebSocketServer> {
  const ws = (await import('ws')) as unknown as {
    WebSocketServer: new (options: { noServer: boolean }) => NodeWebSocketServer
    default?: { WebSocketServer: new (options: { noServer: boolean }) => NodeWebSocketServer }
  }
  const WebSocketServer = ws.WebSocketServer ?? ws.default?.WebSocketServer
  if (!WebSocketServer) throw new Error('The ws package did not expose WebSocketServer.')
  return new WebSocketServer({ noServer: true })
}

export function realtimePlugin(): Plugin {
  let wss: NodeWebSocketServer | null = null

  const attach = (server: ViteDevServer) => {
    // `.env` is read into process.env here because the plugin runs outside the
    // request pipeline that normally populates it.
    const env = loadEnv(server.config.mode, server.config.root, '')
    for (const [key, value] of Object.entries(env)) {
      if (process.env[key] === undefined) process.env[key] = value
    }

    server.httpServer?.on(
      'upgrade',
      (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = (request.url || '').split('?')[0]
        // Anything else — Vite's own HMR socket included — is left alone.
        if (path !== REALTIME_PATH) return

        void (async () => {
          try {
            const guard = (await server.ssrLoadModule('/src/lib/guard.ts')) as {
              originAllowed: (origin: string | null, host: string | null) => boolean
            }
            // A socket upgrade is not covered by CORS, so the origin has to be
            // checked here or a page anywhere could open one and spend the key.
            if (
              !guard.originAllowed(
                request.headers.origin ?? null,
                request.headers.host ?? null,
              )
            ) {
              socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
              socket.destroy()
              return
            }

            wss ??= await createServer()
            const module = (await server.ssrLoadModule('/src/lib/realtime-session.ts')) as {
              createRealtimeSession: SessionFactory
            }

            wss.handleUpgrade(request, socket, head, (client) => {
              const session = module.createRealtimeSession({
                sendText: (data) => {
                  if (client.readyState === OPEN) client.send(data)
                },
                sendBinary: (data) => {
                  if (client.readyState === OPEN) client.send(data)
                },
              })

              client.on('message', ((data: Buffer | ArrayBuffer, isBinary: boolean) => {
                if (isBinary) return
                session.handleMessage(data.toString())
              }) as never)
              client.on('close', (() => session.close()) as never)
              client.on('error', (() => session.close()) as never)
            })
          } catch (error) {
            server.config.logger.error(
              `[gideon] realtime upgrade failed: ${(error as Error).message}`,
            )
            socket.destroy()
          }
        })()
      },
    )

    server.config.logger.info(`  ➜  GIDEON realtime:  ws${REALTIME_PATH}`)
  }

  return {
    name: 'gideon-realtime',
    apply: 'serve',
    configureServer: attach,
  }
}
