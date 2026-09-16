import { createFileRoute } from '@tanstack/react-router'
import { parseChatBody, RequestValidationError, apiError } from '../lib/openrouter'
import { guardRequest, streamChat } from '../lib/openrouter.server'
import { captureServerEvent } from '../lib/posthog-server'
import { readScreen } from '../lib/stage-judge'

/**
 * Streaming HTTP fallback for the realtime link. Emits the same protocol frames
 * the WebSocket does, so this is what runs on serverless hosts that cannot
 * accept socket upgrades.
 */
export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = guardRequest(request, 'turn')
        if (denied) return denied

        try {
          const body = (await request.json()) as {
            id?: unknown
            timezone?: unknown
            speculative?: unknown
            screen?: unknown
          }
          const id = typeof body?.id === 'string' ? body.id : 'turn'
          const timezone =
            typeof body?.timezone === 'string' ? body.timezone.slice(0, 64) : undefined
          const messages = parseChatBody(body)
          captureServerEvent(request, 'chat_requested', {
            message_count: messages.length,
            speculative: body?.speculative === true,
            has_screen_context: Boolean(body?.screen),
          })
          return streamChat(
            id,
            messages,
            request.signal,
            timezone,
            body?.speculative === true,
            readScreen(body?.screen),
            request,
          )
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
