import { createFileRoute } from '@tanstack/react-router'
import { getPublicConfig, warmUpstream } from '../lib/openrouter.server'

export const Route = createFileRoute('/api/config')({
  server: {
    handlers: {
      GET: async () => {
        // The page asks for config on load; use that moment to open the upstream
        // TLS connection so the first real turn skips the handshake.
        warmUpstream()
        return Response.json(getPublicConfig())
      },
    },
  },
})
