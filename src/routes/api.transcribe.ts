import { createFileRoute } from '@tanstack/react-router'
import { MAX_AUDIO_BYTES, apiError } from '../lib/openrouter'
import { guardRequest, transcribe } from '../lib/openrouter.server'

/**
 * Speech to text for one utterance.
 *
 * The body is raw WAV rather than JSON: the browser records the audio, and
 * base64 would inflate it by a third on the one hop that runs over the user's
 * uplink. The server does that encoding instead, where it is free.
 *
 * The ordering below matters. The declared length is checked first, because
 * that is the only way to refuse an absurd upload without reading it; then the
 * body is read; and only then is the request gated. Reading before gating looks
 * wasteful and is not: returning a refusal while leaving the request stream
 * unread leaves it half-consumed on a keep-alive connection, and the next
 * request on that socket then fails to construct at all. One rate-limited
 * transcription would take the requests behind it down with it.
 */
export const Route = createFileRoute('/api/transcribe')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const declared = Number(request.headers.get('content-length') ?? '0')
        if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
          return Response.json(apiError('audio_too_large', 'That recording is too long.'), {
            status: 413,
          })
        }

        let audio: ArrayBuffer
        try {
          audio = await request.arrayBuffer()
        } catch {
          // A client that vanished mid-upload, or a stream that cannot be read.
          // Either way it is the request's problem, not the server's, and it
          // must not surface as an unhandled 500.
          return Response.json(apiError('audio_unreadable', 'That recording did not arrive.'), {
            status: 400,
          })
        }

        const denied = guardRequest(request, 'transcribe')
        if (denied) return denied

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
