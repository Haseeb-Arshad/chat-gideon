import { createFileRoute } from '@tanstack/react-router'
import { getPublicConfig, guardRequest, warmUpstream } from '../lib/openrouter.server'
import { availableTools } from '../lib/agent-core'
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
        return Response.json({
          ...getPublicConfig(),
          gated: accessCodeRequired(),
          // `false`: this endpoint is only consulted on the HTTP fallback, and
          // that transport cannot reach a browser-run tool.
          tools: availableTools(false),
        })
      },
    },
  },
})
