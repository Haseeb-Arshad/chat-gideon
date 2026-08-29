import { describe, expect, it } from 'vitest'
import {
  MAX_HISTORY_MESSAGES,
  RequestValidationError,
  parseChatBody,
  parseVoiceBody,
  providerErrorMessage,
  statusForProviderError,
} from './openrouter'

describe('OpenRouter request validation', () => {
  it('normalizes and trims a valid conversation', () => {
    expect(
      parseChatBody({
        messages: [
          { role: 'assistant', content: ' Hello ' },
          { role: 'user', content: ' Tell me something. ' },
        ],
      }),
    ).toEqual([
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Tell me something.' },
    ])
  })

  it('keeps only the bounded recent context', () => {
    const messages = Array.from({ length: MAX_HISTORY_MESSAGES + 8 }, (_, index) => ({
      role: index === MAX_HISTORY_MESSAGES + 7 ? 'user' : index % 2 ? 'user' : 'assistant',
      content: `Message ${index}`,
    }))

    expect(parseChatBody({ messages })).toHaveLength(MAX_HISTORY_MESSAGES)
  })

  it.each([
    [undefined, 'invalid_request'],
    [{ messages: [] }, 'empty_conversation'],
    [{ messages: [{ role: 'system', content: 'No' }] }, 'invalid_role'],
    [{ messages: [{ role: 'user', content: '  ' }] }, 'empty_message'],
    [{ messages: [{ role: 'assistant', content: 'Hi' }] }, 'missing_user_message'],
  ])('rejects malformed chat input', (body, code) => {
    try {
      parseChatBody(body)
      throw new Error('Expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError)
      expect((error as RequestValidationError).code).toBe(code)
    }
  })

  it('validates and trims voice text', () => {
    expect(parseVoiceBody({ text: '  Speak this.  ' })).toBe('Speak this.')
    expect(() => parseVoiceBody({ text: '' })).toThrow(RequestValidationError)
  })
})

describe('provider error normalization', () => {
  it('hides authentication details behind a local configuration message', () => {
    expect(statusForProviderError(401)).toBe(503)
    expect(providerErrorMessage(401)).toContain('key was rejected')
  })

  it('marks provider and rate limit errors with useful statuses', () => {
    expect(statusForProviderError(429)).toBe(429)
    expect(statusForProviderError(503)).toBe(502)
    expect(providerErrorMessage(429)).toContain('rate-limited')
  })
})

