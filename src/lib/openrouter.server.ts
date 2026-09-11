import '@tanstack/react-start/server-only'

/**
 * Server-only facade over `agent-core`.
 *
 * The core is deliberately framework-free so the WebSocket host can share it;
 * this module is what the TanStack route handlers import, and it is where the
 * transport-shaped concerns (Response objects, headers, status codes) live.
 */

import {
  fetchVoice,
  getPublicConfig,
  streamTurn,
  transcribeAudio,
  warmUpstream,
} from './agent-core'
import { gate, type GateResult, type LimitName } from './guard'
import { apiError, type ChatMessageInput } from './openrouter'
import { encodeFrame } from './protocol'

export { getPublicConfig, warmUpstream }

/**
 * Runs the shared gate and shapes a refusal as a Response.
 *
 * Returns `null` when the request may proceed, so a handler reads as
 * `const denied = guardRequest(...); if (denied) return denied`.
 */
export function guardRequest(request: Request, limit: LimitName): Response | null {
  const result: GateResult = gate(request, limit)
  if (result.ok) return null

  return Response.json(apiError(result.code, result.message, result.status === 429), {
    status: result.status,
    headers: result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : undefined,
  })
}

/**
 * Streams one turn as newline-delimited protocol frames — the same frames the
 * WebSocket link emits, so the browser parses exactly one format.
 */
export function streamChat(
  id: string,
  messages: ChatMessageInput[],
  signal: AbortSignal,
  /**
   * The browser's timezone. Without it the clock tool answers in UTC, which is
   * the wrong day for most of the world for part of every day.
   */
  timezone?: string,
  /** A guess at an unfinished sentence; the core refuses to act on one. */
  speculative?: boolean,
  /** What the page is showing, already read and bounded. */
  screen?: import('./stage-judge').ScreenState | null,
): Response {
  const encoder = new TextEncoder()

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // No bridge on this path: a single HTTP response cannot ask the
        // browser a question mid-turn, so browser-run tools are unavailable
        // and the agent loop is told so rather than discovering it late.
        for await (const frame of streamTurn(id, messages, signal, {
          timezone,
          speculative,
          screen,
        })) {
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

/**
 * One utterance transcribed.
 *
 * A refusal is shaped like every other API error so the browser has one way to
 * read a failure; an empty transcript is a success with no words in it, which
 * is what a cough or a closing door legitimately produces.
 */
export async function transcribe(
  audio: ArrayBuffer,
  signal: AbortSignal,
  language?: string,
): Promise<Response> {
  const result = await transcribeAudio(audio, signal, { language })

  if (!result.ok) {
    return Response.json(apiError(result.code, result.message, result.retryable), {
      status: result.retryable ? 502 : 503,
    })
  }

  return Response.json(
    { text: result.text, model: result.model },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
