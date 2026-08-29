import { createFileRoute } from '@tanstack/react-router'
import { parseVoiceBody, RequestValidationError, apiError } from '../lib/openrouter'
import { synthesizeVoice } from '../lib/openrouter.server'

export const Route = createFileRoute('/api/voice')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json()
          return synthesizeVoice(parseVoiceBody(body))
        } catch (error) {
          if (error instanceof RequestValidationError) {
            return Response.json(apiError(error.code, error.message), { status: 400 })
          }

          return Response.json(
            apiError('invalid_json', 'The voice request is not valid JSON.'),
            { status: 400 },
          )
        }
      },
    },
  },
})
