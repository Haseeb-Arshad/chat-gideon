import { createFileRoute } from '@tanstack/react-router'
import { parseVoiceBody, RequestValidationError, apiError } from '../lib/openrouter'
import { guardRequest, synthesizeVoice } from '../lib/openrouter.server'
import { captureServerEvent } from '../lib/posthog-server'

export const Route = createFileRoute('/api/voice')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = guardRequest(request, 'speak')
        if (denied) return denied

        try {
          const body = await request.json()
          const text = parseVoiceBody(body)
          captureServerEvent(request, 'voice_synthesis_requested', {
            character_count: text.length,
          })
          return await synthesizeVoice(text, request.signal)
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
