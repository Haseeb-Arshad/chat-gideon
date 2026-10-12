import {
  availableTools,
  fetchVoice,
  getPublicConfig,
  streamTurn,
  transcribeAudio,
  warmUpstream,
} from '../../../src/lib/agent-core'
import { gate, originAllowed, type LimitName } from '../../../src/lib/guard'
import { locationFromCf } from '../../../src/lib/location'
import {
  MAX_AUDIO_BYTES,
  RequestValidationError,
  apiError,
  parseChatBody,
  parseVoiceBody,
} from '../../../src/lib/openrouter'
import { encodeFrame, type ServerFrame } from '../../../src/lib/protocol'
import { readScreen, type ScreenState } from '../../../src/lib/stage-judge'
import { readConversationState, type ConversationState } from '../../../src/lib/conversation-state'
import { setRuntimeEnv } from '../../../src/lib/runtime-env'
import { ensureAccount, ownerOf, OwnerUnavailable } from './accounts'
import { memoryStoreForHttp } from './memory'
import type { InteractionAudit } from '../../../src/lib/interaction-audit'
import { createWorkerInteractionAudit } from './audit'
import { resolveWorkerMemoryForTurn, type WorkerMemoryContext } from './worker-memory'
import { handleWorkerMemoryControls } from './worker-memory-controls'
import type { Env } from './types'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function corsHeaders(request: Request): Headers {
  const headers = new Headers()
  const origin = request.headers.get('origin')
  if (origin && originAllowed(origin, request.url)) {
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

function denied(request: Request, limit: LimitName) {
  const result = gate(request, limit, Date.now(), 'cloudflare')
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
  id: string,
  messages: ReturnType<typeof parseChatBody>,
  timezone: string | undefined,
  speculative: boolean,
  screen: ScreenState | null,
  conversationState: ConversationState | null,
  audit: InteractionAudit | null,
  memory: WorkerMemoryContext,
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let status: 'completed' | 'failed' | 'cancelled' = 'failed'
      try {
        for await (const frame of streamTurn(id, messages, request.signal, {
          timezone,
          speculative,
          memorySession: memory.memorySession,
          memoryStore: memory.memoryStore,
          memoryRuntime: memory.memoryRuntime,
          audit: audit ?? undefined,
          screen,
          conversationState,
          location: locationFromCf((request as { cf?: unknown }).cf),
        })) {
          if (request.signal.aborted) { status = 'cancelled'; break }
          if (frame.t === 'done') {
            audit?.record('released_frame', { type: frame.t, turnId: frame.id, responseId: frame.responseId })
            // Do not release a successful answer until its final text and token/tool evidence are durable.
            await audit?.flush()
            status = 'completed'
          } else {
            audit?.record('released_frame', { type: frame.t, frame })
            // Releasing text, cards or actions before their audit write commits
            // would make a required audit incomplete if storage went away.
            await audit?.flush()
          }
          controller.enqueue(encoder.encode(`${encodeFrame(frame)}\n`))
        }
      } catch (error) {
        status = request.signal.aborted ? 'cancelled' : 'failed'
        if ((error as Error).name !== 'AbortError') {
          audit?.record('worker_failure', { message: String((error as Error).message || 'stream_failed').slice(0, 500) })
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
        try {
          await audit?.finish(status)
        } catch {
          // No content, user ID or database detail enters platform logs.
          console.warn('[audit] turn persistence failed')
        }
        await memory.close().catch(() => undefined)
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
    const value = body as { id?: unknown; timezone?: unknown; speculative?: unknown; screen?: unknown; conversationState?: unknown }
    const id = typeof value.id === 'string' ? value.id : 'turn'
    const timezone = typeof value.timezone === 'string' ? value.timezone.slice(0, 64) : undefined
    const owner = await ownerOf(request, env)
    const auditFactory = createWorkerInteractionAudit({
      env,
      owner,
      sessionKey: request.headers.get('x-gideon-session'),
      channel: 'http',
    })
    const audit = auditFactory
      ? await auditFactory.startTurn({ clientTurnId: id, messages: parsed })
      : null
    const legacyStore = memoryStoreForHttp(env, owner, env.GIDEON_SESSION)
    let memory: WorkerMemoryContext
    try {
      memory = await resolveWorkerMemoryForTurn({ env, owner, channel: 'worker_http', legacyStore })
    } catch (error) {
      await audit?.record('worker_failure', { message: String((error as Error).message || 'memory_unavailable').slice(0, 500) })
      await audit?.finish('failed').catch(() => undefined)
      throw error
    }
    return streamChat(
      request,
      id,
      parsed,
      timezone,
      value.speculative === true,
      readScreen(value.screen),
      readConversationState(value.conversationState),
      audit,
      memory,
    )
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return json(apiError(error.code, error.message), request, 400)
    }
    if (error instanceof OwnerUnavailable) {
      return json(apiError('account_unavailable', 'Account verification is temporarily unavailable.', true), request, 503)
    }
    if (env.GIDEON_AUDIT_REQUIRED === '1') {
      return json(apiError('audit_unavailable', 'The conversation could not be saved, so no reply was started.', true), request, 503)
    }
    return json(apiError('memory_unavailable', 'Memory is temporarily unavailable.', true), request, 503)
  }
}

async function voice(request: Request, env: Env) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidJson(request)
  }

  try {
    const text = parseVoiceBody(body)
    const value = body as { id?: unknown; turnId?: unknown; responseId?: unknown; segmentId?: unknown; seq?: unknown; startChar?: unknown; endChar?: unknown }
    const owner = await ownerOf(request, env)
    const auditFactory = createWorkerInteractionAudit({ env, owner, sessionKey: request.headers.get('x-gideon-session'), channel: 'http' })
    const clientTurnId = typeof value.turnId === 'string' ? value.turnId : typeof value.id === 'string' ? value.id : crypto.randomUUID()
    const audit = auditFactory ? await auditFactory.startTurn({ clientTurnId, messages: [] }) : null
    audit?.record('voice_generation_request', {
      text,
      responseId: typeof value.responseId === 'string' ? value.responseId.slice(0, 200) : null,
      segmentId: typeof value.segmentId === 'string' ? value.segmentId.slice(0, 200) : null,
      seq: Number.isSafeInteger(value.seq) ? value.seq : null,
      startChar: Number.isSafeInteger(value.startChar) ? value.startChar : null,
      endChar: Number.isSafeInteger(value.endChar) ? value.endChar : null,
    })
    await audit?.flush()
    const result = await fetchVoice(text, request.signal)
    if (!result.ok || !result.body) {
      audit?.record('voice_generation_failed', { code: result.code, retryable: result.retryable })
      await audit?.finish('failed')
      return json(apiError(result.code, result.message, result.retryable), request, result.retryable ? 502 : 503)
    }
    if (audit) {
      await audit.saveAudio({
        audio: result.body,
        mime: result.mime,
        source: 'assistant',
        text,
        metadata: {
          responseId: typeof value.responseId === 'string' ? value.responseId.slice(0, 200) : null,
          segmentId: typeof value.segmentId === 'string' ? value.segmentId.slice(0, 200) : null,
          seq: Number.isSafeInteger(value.seq) ? value.seq : null,
          startChar: Number.isSafeInteger(value.startChar) ? value.startChar : null,
          endChar: Number.isSafeInteger(value.endChar) ? value.endChar : null,
        },
      })
    }
    await audit?.finish('completed')
    return response(result.body, request, {
      status: 200,
      headers: { 'Content-Type': result.mime, 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return json(apiError(error.code, error.message), request, 400)
    }
    if (env.GIDEON_AUDIT_REQUIRED === '1') {
      return json(apiError('audit_unavailable', 'The spoken reply could not be saved.', true), request, 503)
    }
    return json(apiError('voice_failed', 'The spoken reply could not be completed.', true), request, 502)
  }
}

async function transcribe(request: Request, env: Env) {
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

  const language = request.headers.get('x-gideon-language') || undefined
  const result = await transcribeAudio(audio, request.signal, { language })

  // A caption is a read of speech that is still being spoken, asked for about
  // every second. The utterance it belongs to is recorded when it finishes;
  // recording each caption as well put several database round trips in front of
  // every one of them, which made the transcript slow enough to lose a sentence.
  if (request.headers.get('x-gideon-purpose') === 'caption') {
    return result.ok
      ? json({ text: result.text, model: result.model }, request, 200, { 'Cache-Control': 'no-store' })
      : json(apiError(result.code, result.message, result.retryable), request, result.retryable ? 502 : 503)
  }

  // The recording and its transcript are saved together, after transcribing and
  // before the result is returned, so nothing is released without its evidence.
  try {
    const owner = await ownerOf(request, env)
    await createWorkerInteractionAudit({ env, owner, sessionKey: request.headers.get('x-gideon-session'), channel: 'http' })
      ?.recordVoice({
        clientTurnId: crypto.randomUUID(),
        audio,
        mime: request.headers.get('content-type') || 'audio/wav',
        source: 'user',
        ...(result.ok ? { text: result.text } : {}),
        metadata: {
          language: language ?? null,
          ...(result.ok
            ? { transcriptionModel: result.model }
            : { transcriptionFailed: result.code, retryable: result.retryable }),
        },
      })
  } catch {
    if (env.GIDEON_AUDIT_REQUIRED === '1') {
      return json(apiError('audit_unavailable', 'The recording could not be saved.', true), request, 503)
    }
  }

  if (!result.ok) return json(apiError(result.code, result.message, result.retryable), request, result.retryable ? 502 : 503)
  return json({ text: result.text, model: result.model }, request, 200, { 'Cache-Control': 'no-store' })
}

async function account(request: Request, env: Env) {
  try {
    const result = await ensureAccount(request, env)
    if (!result) {
      return json(apiError('accounts_off', 'Accounts are not set up on this deployment.'), request, 404)
    }
    const reply = json({ anonymous: result.anonymous }, request, 200, { 'Cache-Control': 'no-store' })
    // Appended one by one: Better Auth sends more than one cookie, and
    // setting the header would keep only the last.
    for (const cookie of result.headers.getSetCookie()) reply.headers.append('Set-Cookie', cookie)
    return reply
  } catch {
    return json(apiError('account_failed', 'The account could not be set up.', true), request, 503)
  }
}

/** Handles API routes; the caller sends non-API requests to TanStack Start. */
export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  setRuntimeEnv(env)
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    // Preflight only validates the browser origin. It does not consume a
    // provider-backed rate-limit token.
    if (!originAllowed(request.headers.get('origin'), request.url)) {
      return json(
        apiError('origin_rejected', 'That request came from an origin GIDEON does not answer.'),
        request,
        403,
      )
    }
    return response(null, request, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Gideon-Language, X-Gideon-Purpose, X-Gideon-Session',
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
        tools: availableTools(false),
      },
      request,
      200,
      { 'Cache-Control': 'no-store' },
    )
  }

  if (url.pathname === '/api/account') {
    if (request.method !== 'POST') return methodNotAllowed(request, 'POST')
    // Only a page makes an account, and a page always says where it is from,
    // so a request without an Origin is a script filling the database.
    if (!originAllowed(request.headers.get('origin'), request.url, true)) {
      return json(
        apiError('origin_rejected', 'That request came from an origin GIDEON does not answer.'),
        request,
        403,
      )
    }
    const check = denied(request, 'account')
    if (check) return check
    return account(request, env)
  }

  if (url.pathname === '/api/memory') {
    return handleWorkerMemoryControls(request, env)
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
    return voice(request, env)
  }

  if (url.pathname === '/api/transcribe') {
    if (request.method !== 'POST') return methodNotAllowed(request, 'POST')
    return transcribe(request, env)
  }

  if (url.pathname.startsWith('/api/')) {
    return json(apiError('not_found', 'That API route does not exist.'), request, 404)
  }

  return null
}

export function isApiPath(pathname: string) {
  return pathname.startsWith('/api/')
}
