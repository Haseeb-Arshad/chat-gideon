import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { realtimePlugin } from './realtime-plugin'

const config = defineConfig(({ command, mode }) => ({
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
