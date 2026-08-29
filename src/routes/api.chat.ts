import { createFileRoute } from '@tanstack/react-router'
import { parseChatBody, RequestValidationError, apiError } from '../lib/openrouter'
import { streamChat } from '../lib/openrouter.server'

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json()
          return streamChat(parseChatBody(body))
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
