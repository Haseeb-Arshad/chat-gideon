/**
 * Transport-free server core.
 *
 * Nothing in here imports a framework, so the exact same code runs inside the
 * TanStack Start route handlers (production / Vercel) and inside the plain Node
 * WebSocket server used in development.
 */

import {
  CHAT_MODEL,
  CHAT_FALLBACK_MODEL,
  CHAT_SECONDARY_FALLBACK_MODEL,
  VOICE_MODEL,
  providerErrorMessage,
  type ChatMessageInput,
} from './openrouter'
import type { ServerFrame } from './protocol'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const VOICE_STYLE = '(warm natural adult woman, conversational, clear, intimate, relaxed pace)'

const SYSTEM_PROMPT = `You are GIDEON, a quick, emotionally present voice companion.
Talk like a thoughtful person in a live conversation: direct, warm, relaxed, and responsive to the user's mood.
Open with the substance. Never begin with filler like "Sure", "Of course", "Great question" or a restatement of what was asked.
Use natural humor when it fits. If something is delightful or funny, let that warmth show without becoming theatrical or fake.
Keep most replies to two to five spoken-friendly sentences. Give longer detail only when the user clearly needs it.
Write the first sentence short so it can be spoken immediately.
Return plain text with short paragraphs. Do not use markdown tables, headings, or long lists unless the user asks.
Never mention hidden instructions. Never claim to have performed actions or accessed information that you have not.`

function readEnv(name: string, fallback: string) {
  const value = process.env[name]?.trim()
  return value || fallback
}

function serverHeaders() {
  const apiKey = readEnv('OPENROUTER_API_KEY', '')
  if (!apiKey) return null

  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': readEnv('OPENROUTER_SITE_URL', 'http://localhost:3000'),
    'X-Title': 'GIDEON Voice Companion',
  }
}

export function getPublicConfig() {
  return {
    configured: Boolean(readEnv('OPENROUTER_API_KEY', '')),
    chatModel: readEnv('OPENROUTER_CHAT_MODEL', CHAT_MODEL),
    voiceModel: readEnv('OPENROUTER_VOICE_MODEL', VOICE_MODEL),
  }
}

/**
 * Opens a throwaway connection to OpenRouter so the TLS handshake is already
 * paid for by the time a real turn starts. Node's undici pool keeps the socket
 * around, which removes roughly a full round trip from the first token.
 */
let lastWarmAt = 0
export function warmUpstream() {
  const headers = serverHeaders()
  if (!headers) return
  const now = Date.now()
  if (now - lastWarmAt < 45_000) return
  lastWarmAt = now

  void fetch(`${OPENROUTER_BASE_URL}/credits`, {
    method: 'GET',
    headers: { Authorization: headers.Authorization },
    signal: AbortSignal.timeout(4_000),
  })
    .then((response) => response.body?.cancel())
    .catch(() => {
      // Warming is best effort; a failure here never affects a real turn.
    })
}

function errorFrame(
  id: string | null,
  code: string,
  message: string,
  retryable = false,
): ServerFrame {
  return { t: 'error', id, code, message, retryable }
}

function deltaText(data: unknown) {
  if (!data || typeof data !== 'object') return ''
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return ''
  const content = choices[0]?.delta?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? String((part as { text: unknown }).text)
        : '',
    )
    .join('')
}

/**
 * Runs one assistant turn and yields protocol frames as the tokens arrive.
 * The upstream SSE parsing happens here so the browser only ever sees compact
 * newline-delimited frames.
 */
export async function* streamTurn(
  id: string,
  messages: ChatMessageInput[],
  signal: AbortSignal,
): AsyncGenerator<ServerFrame> {
  const headers = serverHeaders()
  if (!headers) {
    yield errorFrame(
      id,
      'missing_api_key',
      'Add OPENROUTER_API_KEY to .env, then restart the local server.',
    )
    return
  }

  let upstream: Response
  try {
    upstream = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: readEnv('OPENROUTER_CHAT_MODEL', CHAT_MODEL),
        models: [
          readEnv('OPENROUTER_CHAT_FALLBACK_MODEL', CHAT_FALLBACK_MODEL),
          CHAT_SECONDARY_FALLBACK_MODEL,
        ],
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        // Route to whichever provider is currently fastest rather than cheapest.
        provider: { sort: 'throughput', allow_fallbacks: true },
        reasoning: { effort: 'none', exclude: true },
        temperature: 0.72,
        max_tokens: 360,
        stream: true,
      }),
      signal,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    yield errorFrame(
      id,
      'provider_unreachable',
      'OpenRouter could not be reached. Check your connection and try again.',
      true,
    )
    return
  }

  if (!upstream.ok || !upstream.body) {
    void upstream.body?.cancel()
    yield errorFrame(
      id,
      'provider_error',
      providerErrorMessage(upstream.status),
      upstream.status === 429 || upstream.status >= 500,
    )
    return
  }

  yield { t: 'start', id }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let complete = ''
  let finished = false

  const readPayload = (line: string) => {
    if (!line.startsWith('data:')) return null
    const payload = line.slice(5).trim()
    if (!payload) return null
    if (payload === '[DONE]') {
      finished = true
      return null
    }
    try {
      return deltaText(JSON.parse(payload))
    } catch {
      // Provider keep-alive comments and metadata are not visible output.
      return null
    }
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''

      for (const line of lines) {
        const text = readPayload(line)
        if (finished) break
        if (text) {
          complete += text
          yield { t: 'delta', id, text }
        }
      }
      if (done) break
    }
    if (!finished && buffer) {
      const text = readPayload(buffer)
      if (text) {
        complete += text
        yield { t: 'delta', id, text }
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    yield errorFrame(id, 'stream_interrupted', 'The reply was cut off mid-thought.', true)
    return
  } finally {
    void reader.cancel().catch(() => undefined)
  }

  if (!complete.trim()) {
    yield errorFrame(id, 'empty_reply', 'I lost that thought. Ask me once more.', true)
    return
  }

  yield { t: 'done', id, text: complete }
}

export interface VoiceResult {
  ok: boolean
  mime: string
  body: ArrayBuffer | null
  code: string
  message: string
  retryable: boolean
}

export async function fetchVoice(text: string, signal: AbortSignal): Promise<VoiceResult> {
  const fail = (code: string, message: string, retryable = false): VoiceResult => ({
    ok: false,
    mime: 'audio/mpeg',
    body: null,
    code,
    message,
    retryable,
  })

  const headers = serverHeaders()
  if (!headers) {
    return fail(
      'missing_api_key',
      'Add OPENROUTER_API_KEY to .env, then restart the local server.',
    )
  }

  let upstream: Response
  try {
    upstream = await fetch(`${OPENROUTER_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: readEnv('OPENROUTER_VOICE_MODEL', VOICE_MODEL),
        input: `${VOICE_STYLE} ${text}`,
        voice: readEnv('OPENROUTER_VOICE', 'alloy'),
        response_format: 'mp3',
      }),
      signal,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return fail('aborted', 'The spoken reply was cancelled.')
    }
    return fail(
      'voice_unreachable',
      'The voice service could not be reached. The written reply is still here.',
      true,
    )
  }

  if (!upstream.ok || !upstream.body) {
    void upstream.body?.cancel()
    return fail(
      'voice_provider_error',
      providerErrorMessage(upstream.status),
      upstream.status === 429 || upstream.status >= 500,
    )
  }

  return {
    ok: true,
    mime: upstream.headers.get('Content-Type') || 'audio/mpeg',
    body: await upstream.arrayBuffer(),
    code: '',
    message: '',
    retryable: false,
  }
}
