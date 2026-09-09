import { createFileRoute } from '@tanstack/react-router'
import { getPublicConfig, guardRequest, warmUpstream } from '../lib/openrouter.server'
import { accessCodeRequired } from '../lib/guard'

export const Route = createFileRoute('/api/config')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = guardRequest(request, 'config')
        if (denied) return denied

        // The page asks for config on load; use that moment to open the upstream
        // TLS connection so the first real turn skips the handshake.
        warmUpstream()
        return Response.json({ ...getPublicConfig(), gated: accessCodeRequired() })
      },
    },
  },
})
