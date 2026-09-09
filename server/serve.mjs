/**
 * Production entry.
 *
 * Nitro's default `node` preset calls `serve({ fetch })` itself and never hands
 * back the HTTP server, which leaves nowhere to attach an upgrade handler — so
 * the realtime socket only ever existed in development. Building with the
 * `node-middleware` preset instead exports a plain Node request handler, which
 * means this file can own the listener: Nitro answers the requests, and the
 * socket gets the one path it needs.
 */

import { createServer } from 'node:http'
import { middleware } from '../.output/server/index.mjs'
import { attachRealtime } from '../.output/realtime/host.mjs'
import { REALTIME_PATH } from '../.output/realtime/host.mjs'

const port = Number.parseInt(process.env.PORT ?? '', 10) || 3000
const host = process.env.HOST || '0.0.0.0'

const server = createServer((request, response) => {
  void middleware(request, response)
})

attachRealtime(server, {
  onError: (message) => console.error(`[gideon] ${message}`),
  // The only upgrade handler on this server, so anything else is a client
  // holding a socket open for nothing.
  rejectOther: true,
})

// Long enough for a slow upstream turn, short enough that a dead client is not
// holding a socket open forever.
server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000

server.listen(port, host, () => {
  console.log(`[gideon] listening on http://${host}:${port}`)
  console.log(`[gideon] realtime socket on ws://${host}:${port}${REALTIME_PATH}`)
})

const shutdown = (signal) => {
  console.log(`[gideon] ${signal}, closing`)
  server.close(() => process.exit(0))
  // A client mid-turn must not be able to hold the process open indefinitely.
  setTimeout(() => process.exit(0), 8_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
