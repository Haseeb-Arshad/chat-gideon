import '@tanstack/react-start/server-only'

/**
 * Server-only facade over `agent-core`.
 *
 * The core is deliberately framework-free so the WebSocket host can share it;
 * this module is what the TanStack route handlers import, and it is where the
 * transport-shaped concerns (Response objects, headers, status codes) live.
 */

import { fetchVoice, getPublicConfig, streamTurn, warmUpstream } from './agent-core'
import { apiError, type ChatMessageInput } from './openrouter'
import { encodeFrame } from './protocol'

export { getPublicConfig, warmUpstream }

/**
 * Streams one turn as newline-delimited protocol frames — the same frames the
 * WebSocket link emits, so the browser parses exactly one format.
 */
export function streamChat(
  id: string,
  messages: ChatMessageInput[],
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder()

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of streamTurn(id, messages, signal)) {
          if (signal.aborted) break
          controller.enqueue(encoder.encode(`${encodeFrame(frame)}\n`))
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          controller.enqueue(
            encoder.encode(
              `${encodeFrame({
                t: 'error',
                id,
                code: 'stream_failed',
                message: 'The reply was interrupted.',
                retryable: true,
              })}\n`,
            ),
          )
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

export async function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  const result = await fetchVoice(text, signal)

  if (!result.ok || !result.body) {
    return Response.json(apiError(result.code, result.message, result.retryable), {
      status: result.retryable ? 502 : 503,
    })
  }

  return new Response(result.body, {
    status: 200,
    headers: {
      'Content-Type': result.mime,
      'Cache-Control': 'no-store',
    },
  })
}
