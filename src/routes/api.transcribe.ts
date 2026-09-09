import { createFileRoute } from '@tanstack/react-router'
import { MAX_AUDIO_BYTES, apiError } from '../lib/openrouter'
import { guardRequest, transcribe } from '../lib/openrouter.server'

/**
 * Speech to text for one utterance.
 *
 * The body is raw WAV rather than JSON: the browser records the audio, and
 * base64 would inflate it by a third on the one hop that runs over the user's
 * uplink. The server does that encoding instead, where it is free.
 */
export const Route = createFileRoute('/api/transcribe')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = guardRequest(request, 'speak')
        if (denied) return denied

        const declared = Number(request.headers.get('content-length') ?? '0')
        if (declared > MAX_AUDIO_BYTES) {
          return Response.json(apiError('audio_too_large', 'That recording is too long.'), {
            status: 413,
          })
        }

        const audio = await request.arrayBuffer()
        if (!audio.byteLength) {
          return Response.json(apiError('empty_audio', 'There was no audio to transcribe.'), {
            status: 400,
          })
        }
        if (audio.byteLength > MAX_AUDIO_BYTES) {
          return Response.json(apiError('audio_too_large', 'That recording is too long.'), {
            status: 413,
          })
        }

        const language = request.headers.get('x-gideon-language') || undefined
        return transcribe(audio, request.signal, language)
      },
    },
  },
})
