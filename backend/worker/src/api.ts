import {
  availableTools,
  fetchVoice,
  getPublicConfig,
  streamTurn,
  transcribeAudio,
  warmUpstream,
} from '../../../src/lib/agent-core'
import { gate, originAllowed } from '../../../src/lib/guard'
import {
  MAX_AUDIO_BYTES,
  RequestValidationError,
  apiError,
  parseChatBody,
  parseVoiceBody,
} from '../../../src/lib/openrouter'
import { encodeFrame, type ServerFrame } from '../../../src/lib/protocol'
import { setRuntimeEnv } from '../../../src/lib/runtime-env'
import { sessionIdFromRequest } from './identity'
import { memoryStoreForHttp } from './memory'
import type { Env } from './types'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function corsHeaders(request: Request): Headers {
  const headers = new Headers()
  const origin = request.headers.get('origin')
  if (origin && originAllowed(origin, request.headers.get('host'))) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Credentials', 'false')
    headers.set('Vary', 'Origin')
  }
  return headers
}

function response(
  body: BodyInit | null,
  request: Request,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers)
  const cors = corsHeaders(request)
  cors.forEach((value, key) => headers.set(key, value))
  return new Response(body, { ...init, headers })
}

function json(value: unknown, request: Request, status = 200, headers?: HeadersInit) {
  const merged = new Headers(JSON_HEADERS)
  new Headers(headers).forEach((value, key) => merged.set(key, value))
  return response(JSON.stringify(value), request, { status, headers: merged })
}

function denied(request: Request, limit: 'config' | 'turn' | 'speak' | 'transcribe') {
  const result = gate(request, limit)
  if (result.ok) return null
  return json(
    apiError(result.code, result.message, result.status === 429),
    request,
    result.status,
    result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : undefined,
  )
}

function methodNotAllowed(request: Request, allow: string) {
  return json({ error: { code: 'method_not_allowed', message: 'That method is not available here.' } }, request, 405, {
    Allow: allow,
  })
}

function invalidJson(request: Request) {
  return json(apiError('invalid_json', 'The request is not valid JSON.'), request, 400)
}

function streamChat(
  request: Request,
  env: Env,
  id: string,
  messages: ReturnType<typeof parseChatBody>,
  timezone: string | undefined,
  speculative: boolean,
): Response {
  const encoder = new TextEncoder()
  const store = memoryStoreForHttp(env, sessionIdFromRequest(request))
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of streamTurn(id, messages, request.signal, {
          timezone,
          speculative,
          memoryStore: store,
        })) {
          if (request.signal.aborted) break
          controller.enqueue(encoder.encode(`${encodeFrame(frame)}\n`))
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          const frame: ServerFrame = {
            t: 'error',
            id,
            code: 'stream_failed',
            message: 'The reply was interrupted.',
            retryable: true,
          }
          controller.enqueue(encoder.encode(`${encodeFrame(frame)}\n`))
        }
      } finally {
        controller.close()
      }
    },
  })

  return response(body, request, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  })
}

async function chat(request: Request, env: Env) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidJson(request)
  }

  try {
    const parsed = parseChatBody(body)
    const value = body as { id?: unknown; timezone?: unknown; speculative?: unknown }
    const id = typeof value.id === 'string' ? value.id : 'turn'
    const timezone = typeof value.timezone === 'string' ? value.timezone.slice(0, 64) : undefined
    return streamChat(request, env, id, parsed, timezone, value.speculative === true)
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return json(apiError(error.code, error.message), request, 400)
    }
    return invalidJson(request)
  }
}

async function voice(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidJson(request)
  }

  try {
    const result = await fetchVoice(parseVoiceBody(body), request.signal)
    if (!result.ok || !result.body) {
      return json(apiError(result.code, result.message, result.retryable), request, result.retryable ? 502 : 503)
    }
    return response(result.body, request, {
      status: 200,
      headers: { 'Content-Type': result.mime, 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return json(apiError(error.code, error.message), request, 400)
    }
    return json(apiError('voice_failed', 'The spoken reply could not be completed.', true), request, 502)
  }
}

async function transcribe(request: Request) {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    return json(apiError('audio_too_large', 'That recording is too long.'), request, 413)
  }

  let audio: ArrayBuffer
  try {
    audio = await request.arrayBuffer()
  } catch {
    return json(apiError('audio_unreadable', 'That recording did not arrive.'), request, 400)
  }

  if (!audio.byteLength) return json(apiError('empty_audio', 'There was no audio to transcribe.'), request, 400)
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return json(apiError('audio_too_large', 'That recording is too long.'), request, 413)
  }

  // The body has been consumed before this gate so a throttled upload cannot
  // poison the next keep-alive request.
  const check = denied(request, 'transcribe')
  if (check) return check

  const result = await transcribeAudio(audio, request.signal, {
    language: request.headers.get('x-gideon-language') || undefined,
  })
  if (!result.ok) {
    return json(apiError(result.code, result.message, result.retryable), request, result.retryable ? 502 : 503)
  }
  return json({ text: result.text, model: result.model }, request, 200, { 'Cache-Control': 'no-store' })
}

/** Handles API routes; the caller sends non-API requests to TanStack Start. */
export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  setRuntimeEnv(env)
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    const check = denied(request, 'config')
    if (check) return check
    return response(null, request, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Gideon-Access, X-Gideon-Language, X-Gideon-Session',
        'Access-Control-Max-Age': '600',
      },
    })
  }

  if (url.pathname === '/api/healthz') {
    if (request.method !== 'GET') return methodNotAllowed(request, 'GET')
    const config = getPublicConfig()
    return json(
      { ok: true, configured: config.configured, uptime: 0 },
      request,
      200,
      { 'Cache-Control': 'no-store' },
    )
  }

  if (url.pathname === '/api/config') {
    if (request.method !== 'GET') return methodNotAllowed(request, 'GET')
    const check = denied(request, 'config')
    if (check) return check
    warmUpstream()
    return json(
      {
        ...getPublicConfig(),
        gated: Boolean(env.GIDEON_ACCESS_CODE?.trim()),
        tools: availableTools(false),
      },
      request,
      200,
      { 'Cache-Control': 'no-store' },
    )
  }

  if (url.pathname === '/api/chat') {
    if (request.method !== 'POST') return methodNotAllowed(request, 'POST')
    const check = denied(request, 'turn')
    if (check) return check
    return chat(request, env)
  }

  if (url.pathname === '/api/voice') {
    if (request.method !== 'POST') return methodNotAllowed(request, 'POST')
    const check = denied(request, 'speak')
    if (check) return check
    return voice(request)
  }

  if (url.pathname === '/api/transcribe') {
    if (request.method !== 'POST') return methodNotAllowed(request, 'POST')
    return transcribe(request)
  }

  if (url.pathname.startsWith('/api/')) {
    return json(apiError('not_found', 'That API route does not exist.'), request, 404)
  }

  return null
}

export function isApiPath(pathname: string) {
  return pathname.startsWith('/api/')
}
