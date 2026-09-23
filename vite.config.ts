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
 * Keeps the Node PostgreSQL memory adapter out of the Worker bundle.
 *
 * The TanStack routes share `openrouter.server.ts` with the Node host, and that
 * imports the adapter. The Worker has its own memory authority, so in
 * Cloudflare mode the adapter resolves to a stub that never enables memory.
 */
function workerMemoryBoundary(): Plugin {
  const nodeAdapter = /[\\/]src[\\/]server[\\/]node-memory-integration\.ts$/
  const stub = fileURLToPath(new URL('./src/server/node-memory-integration.worker.ts', import.meta.url))
  return {
    name: 'gideon-worker-memory-boundary',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!source.includes('node-memory-integration') || source.endsWith('.worker')) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      return resolved && nodeAdapter.test(resolved.id) ? stub : null
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
