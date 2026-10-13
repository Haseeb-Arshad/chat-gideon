import { createFileRoute } from '@tanstack/react-router'
import { guardRequest } from '../lib/openrouter.server'
import { handleIllustrationRepair } from '../lib/tools/illustration-repair'
import { runtimeEnv } from '../lib/runtime-env'

export const Route = createFileRoute('/api/illustration-repair')({ server: { handlers: { POST: async ({ request }) => {
  const denied = guardRequest(request, 'turn')
  if (denied) return denied
  return handleIllustrationRepair(request, name => runtimeEnv(name) ?? (typeof process === 'undefined' ? undefined : process.env[name]))
} } } })
