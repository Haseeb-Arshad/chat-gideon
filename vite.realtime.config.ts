import { defineConfig } from 'vite'

/**
 * Bundles the realtime host for production.
 *
 * The socket needs the transport-free core at runtime, and Nitro's output does
 * not expose it: everything under `src/lib` is bundled into the SSR chunks with
 * no entry point of its own. Rather than reach into that, the host is built
 * separately here. It is a handful of framework-free modules, so the build is
 * fast and the result is one file the production entry can import.
 */
export default defineConfig({
  // Nothing static belongs in this output; the main build already emitted it.
  publicDir: false,
  build: {
    ssr: 'src/server/realtime-host.ts',
    outDir: '.output/realtime',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      // Left external so the installed copy is used rather than a bundled one.
      external: ['ws'],
      output: { entryFileNames: 'host.mjs', format: 'esm' },
    },
  },
})
