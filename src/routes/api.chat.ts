import { createFileRoute } from '@tanstack/react-router'
import { parseChatBody, RequestValidationError, apiError } from '../lib/openrouter'
import { streamChat } from '../lib/openrouter.server'

/**
 * Streaming HTTP fallback for the realtime link. Emits the same protocol frames
 * the WebSocket does, so this is what runs on serverless hosts that cannot
 * accept socket upgrades.
 */
export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { id?: unknown }
          const id = typeof body?.id === 'string' ? body.id : 'turn'
          return streamChat(id, parseChatBody(body), request.signal)
        } catch (error) {
          if (error instanceof RequestValidationError) {
            return Response.json(apiError(error.code, error.message), { status: 400 })
          }

          return Response.json(
            apiError('invalid_json', 'The conversation request is not valid JSON.'),
            { status: 400 },
          )
        }
      },
    },
  },
})
