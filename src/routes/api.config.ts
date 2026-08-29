import { createFileRoute } from '@tanstack/react-router'
import { getPublicConfig } from '../lib/openrouter.server'

export const Route = createFileRoute('/api/config')({
  server: {
    handlers: {
      GET: async () => Response.json(getPublicConfig()),
    },
  },
})
