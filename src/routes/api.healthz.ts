import { createFileRoute } from '@tanstack/react-router'
import { getPublicConfig } from '../lib/openrouter.server'

/**
 * Liveness for the host's health checker.
 *
 * Deliberately ungated: the checker has no origin header and no access code,
 * and refusing it would take the deployment down to fix nothing. It reports
 * whether a key is present, never any part of the key itself.
 */
export const Route = createFileRoute('/api/healthz')({
  server: {
    handlers: {
      GET: async () => {
        const config = getPublicConfig()
        return Response.json(
          {
            ok: true,
            configured: config.configured,
            uptime: Math.round(process.uptime?.() ?? 0),
          },
          { headers: { 'Cache-Control': 'no-store' } },
        )
      },
    },
  },
})
