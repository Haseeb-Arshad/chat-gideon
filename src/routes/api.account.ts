import { createFileRoute } from '@tanstack/react-router'
import { ensureNodeAccount } from '../server/identity'

export const Route = createFileRoute('/api/account')({
  server: {
    handlers: {
      POST: ({ request }) => ensureNodeAccount(request),
    },
  },
})
