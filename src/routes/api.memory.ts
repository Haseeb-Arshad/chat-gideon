import { createFileRoute } from '@tanstack/react-router'
import { handleMemoryControls } from '../server/memory-controls'

/** Memory inspector and controls (Stage 12). See src/server/memory-controls.ts. */
export const Route = createFileRoute('/api/memory')({
  server: {
    handlers: {
      GET: ({ request }) => handleMemoryControls(request),
      POST: ({ request }) => handleMemoryControls(request),
    },
  },
})
