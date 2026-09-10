import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { realtimePlugin } from './realtime-plugin'

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
    ...(isCloudflare ? [cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
    devtools(),
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
