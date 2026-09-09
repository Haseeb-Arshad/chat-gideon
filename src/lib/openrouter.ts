export const CHAT_MODEL = 'openai/gpt-4.1-mini'
export const CHAT_FALLBACK_MODEL = 'minimax/minimax-m3:free'
export const VOICE_MODEL = 'fish-audio/s2.1-pro-free:free'
/**
 * Speech to text, chosen by measurement.
 *
 * Five interleaved reps of a short spoken sentence through OpenRouter's
 * transcription endpoint, median round trip:
 *
 *   nvidia/parakeet-tdt-0.6b-v3          367 ms   $0.000056
 *   deepgram/nova-3                      409 ms   $0.000161
 *   fish-audio/transcribe-1              445 ms   $0.000300
 *   mistralai/voxtral-mini-transcribe    535 ms   $0.000100
 *   microsoft/mai-transcribe-2           603 ms   $0.000083
 *   qwen/qwen3-asr-0.6b                  870 ms   $0.000007
 *   openai/whisper-large-v3-turbo      1 380 ms   $0.000007
 *
 * All seven transcribed it exactly. Parakeet wins on latency with the tightest
 * spread, which is what matters when the model sits in the gap between someone
 * stopping and GIDEON starting; Nova follows it as the fallback because it is
 * the most robust of the set on accented and noisy speech.
 */
export const TRANSCRIBE_MODEL = 'nvidia/parakeet-tdt-0.6b-v3'
export const TRANSCRIBE_FALLBACK_MODEL = 'deepgram/nova-3'
/** A spoken turn is seconds long; this only stops an absurd upload. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024
/**
 * Bounds, not budgets.
 *
 * These exist so a malformed or hostile request cannot post a novel, and they
 * are set far above anything a real conversation produces. Nothing here should
 * ever be what stops a reply: an earlier build capped the model's own output at
 * 220 tokens and the result was answers that stopped mid-sentence.
 */
export const MAX_MESSAGE_LENGTH = 32_000
export const MAX_VOICE_LENGTH = 8_000
/**
 * How much conversation is sent upstream.
 *
 * Long enough that GIDEON does not forget the start of a real conversation,
 * and the durable facts in `tools/memory.ts` carry what matters beyond it.
 */
export const MAX_HISTORY_MESSAGES = 80

export type ChatRole = 'user' | 'assistant'

export interface ChatMessageInput {
  role: ChatRole
  content: string
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    retryable: boolean
  }
}

export class RequestValidationError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RequestValidationError'
    this.code = code
  }
}

export function parseChatBody(value: unknown): ChatMessageInput[] {
  if (!value || typeof value !== 'object' || !('messages' in value)) {
    throw new RequestValidationError(
      'invalid_request',
      'A conversation is required.',
    )
  }

  const messages = (value as { messages?: unknown }).messages
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new RequestValidationError(
      'empty_conversation',
      'Write or say something to begin.',
    )
  }

  const normalized = messages.slice(-MAX_HISTORY_MESSAGES).map((message) => {
    if (!message || typeof message !== 'object') {
      throw new RequestValidationError(
        'invalid_message',
        'One of the conversation messages is invalid.',
      )
    }

    const { role, content } = message as {
      role?: unknown
      content?: unknown
    }

    if (role !== 'user' && role !== 'assistant') {
      throw new RequestValidationError(
        'invalid_role',
        'Conversation roles must be user or assistant.',
      )
    }
    const normalizedRole: ChatRole = role

    if (typeof content !== 'string' || !content.trim()) {
      throw new RequestValidationError(
        'empty_message',
        'Conversation messages cannot be empty.',
      )
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new RequestValidationError(
        'message_too_long',
        `Keep each message under ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`,
      )
    }

    return { role: normalizedRole, content: content.trim() }
  })

  if (normalized.at(-1)?.role !== 'user') {
    throw new RequestValidationError(
      'missing_user_message',
      'The latest conversation message must be from you.',
    )
  }

  return normalized
}

export function parseVoiceBody(value: unknown): string {
  const text =
    value && typeof value === 'object' && 'text' in value
      ? (value as { text?: unknown }).text
      : undefined

  if (typeof text !== 'string' || !text.trim()) {
    throw new RequestValidationError(
      'empty_voice_text',
      'There is no response to speak.',
    )
  }

  if (text.length > MAX_VOICE_LENGTH) {
    throw new RequestValidationError(
      'voice_text_too_long',
      `Spoken replies are limited to ${MAX_VOICE_LENGTH.toLocaleString()} characters.`,
    )
  }

  return text.trim()
}

export function apiError(
  code: string,
  message: string,
  retryable = false,
): ApiErrorBody {
  return { error: { code, message, retryable } }
}

export function statusForProviderError(status: number) {
  if (status === 401 || status === 403) return 503
  if (status === 429) return 429
  if (status >= 500) return 502
  return 400
}

export function providerErrorMessage(status: number) {
  if (status === 401 || status === 403) {
    return 'The OpenRouter key was rejected. Check your local server configuration.'
  }
  if (status === 402) {
    return 'OpenRouter could not route this request with the current account limits.'
  }
  if (status === 429) {
    return 'The free model is busy or rate-limited. Wait a moment and try again.'
  }
  if (status >= 500) {
    return 'The voice network is temporarily unavailable. Try again shortly.'
  }
  return 'OpenRouter could not complete that request.'
}
