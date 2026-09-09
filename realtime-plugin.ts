/**
 * Development-time host for GIDEON's realtime socket.
 *
 * Vite owns the dev HTTP server, so this plugin's only job is to hand that
 * server to `attachRealtime` — the same function `server/serve.mjs` calls in
 * production. Dev and a built server therefore run one implementation of the
 * origin check and the session wiring rather than two that can drift.
 *
 * The one thing that has to stay dev-specific is *how* the module is loaded:
 * going through `ssrLoadModule` means editing the session or the agent core
 * takes effect on the next connection instead of needing a restart.
 */

import { loadEnv, type Plugin, type ViteDevServer } from 'vite'

import type { attachRealtime } from './src/server/realtime-host'

export function realtimePlugin(): Plugin {
  const attach = async (server: ViteDevServer) => {
    // `.env` is read into process.env here because the plugin runs outside the
    // request pipeline that normally populates it.
    const env = loadEnv(server.config.mode, server.config.root, '')
    for (const [key, value] of Object.entries(env)) {
      if (process.env[key] === undefined) process.env[key] = value
    }

    const httpServer = server.httpServer
    if (!httpServer) return

    const host = (await server.ssrLoadModule('/src/server/realtime-host.ts')) as {
      attachRealtime: typeof attachRealtime
      REALTIME_PATH: string
    }

    host.attachRealtime(httpServer as never, {
      onError: (message) => server.config.logger.error(`[gideon] ${message}`),
    })

    server.config.logger.info(`  ➜  GIDEON realtime:  ws${host.REALTIME_PATH}`)
  }

  return {
    name: 'gideon-realtime',
    apply: 'serve',
    configureServer(server) {
      // Returned rather than awaited so a failure here cannot stop the dev
      // server from starting; the browser falls back to HTTP frames on its own.
      void attach(server).catch((error: Error) => {
        server.config.logger.error(`[gideon] realtime host failed: ${error.message}`)
      })
    },
  }
}
