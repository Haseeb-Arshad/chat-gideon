export const CHAT_MODEL = 'nvidia/nemotron-3.5-lightning:free'
export const CHAT_FALLBACK_MODEL = 'minimax/minimax-m3:free'
export const CHAT_SECONDARY_FALLBACK_MODEL = 'inception/mercury-2.5-preview'
export const VOICE_MODEL = 'fish-audio/s2.1-pro-free:free'
export const MAX_MESSAGE_LENGTH = 8_000
export const MAX_VOICE_LENGTH = 1_800
export const MAX_HISTORY_MESSAGES = 24

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
