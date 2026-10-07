import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { realtimePlugin } from './realtime-plugin'

/**
 * Keeps Node-only memory migrations and maintenance out of the Worker bundle.
 *
 * TanStack routes share Node adapters with the Worker build. Their framework
 * stand-ins remain isolated; the Worker API and Durable Object use the
 * Hyperdrive-backed canonical runtime in `backend/worker/src/worker-memory.ts`.
 */
function workerMemoryBoundary(): Plugin {
  // Each Node-only module and its Worker stand-in. The Worker API has its own
  // memory adapter and does not depend on these framework route adapters.
  const boundaries = ['node-memory-integration', 'memory-controls'].map((name) => ({
    name,
    nodeModule: new RegExp(`[\\\\/]src[\\\\/]server[\\\\/]${name}\\.ts$`),
    stub: fileURLToPath(new URL(`./src/server/${name}.worker.ts`, import.meta.url)),
  }))
  return {
    name: 'gideon-worker-memory-boundary',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const boundary = boundaries.find((item) => source.includes(item.name))
      if (!boundary || source.endsWith('.worker')) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      return resolved && boundary.nodeModule.test(resolved.id) ? boundary.stub : null
    },
  }
}

const config = defineConfig(({ command, mode }) => {
  const isCloudflare = mode === 'cloudflare'

  return {
  // Honour PORT so a second instance, or a host that assigns one, does not
  // collide with the default. The realtime socket is served from this same
  // server, so the port has to come from one place.
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT) || 3000,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    ...(isCloudflare ? [workerMemoryBoundary(), cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
    // The isolated gallery does not need the devtools console bridge. Browser
    // extension hydration warnings can otherwise echo between client/server.
    ...(mode === 'visualizations' ? [] : [devtools()]),
    ...(isCloudflare ? [] : [realtimePlugin()]),
    tailwindcss(),
    tanstackStart(),
    ...(command === 'build' && mode !== 'test' && !isCloudflare
      ? [
          // `node-middleware` rather than the default `node` preset: it exports
          // a plain Node request handler instead of starting its own listener,
          // which is the only way `server/serve.mjs` can own the HTTP server
          // and attach the realtime socket's upgrade handler to it. A Vercel
          // build gets Vercel's own output instead: it runs the app as
          // functions, which cannot hold the socket, so the browser falls
          // back to the HTTP path there.
          nitro({ preset: process.env.VERCEL ? 'vercel' : 'node-middleware' }),
        ]
      : []),
    viteReact(),
  ],
  }
})

export default config
