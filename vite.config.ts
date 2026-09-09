import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { realtimePlugin } from './realtime-plugin'

const config = defineConfig(({ command, mode }) => ({
  // Honour PORT so a second instance, or a host that assigns one, does not
  // collide with the default. The realtime socket is served from this same
  // server, so the port has to come from one place.
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT) || 3000,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    realtimePlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === 'build' && mode !== 'test' ? [nitro()] : []),
    viteReact(),
  ],
}))

export default config
