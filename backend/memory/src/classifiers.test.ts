import { describe, expect, it, vi } from 'vitest'
import { candidateQuestions, type ClassifierRequest } from '../../../src/lib/memory/classification.ts'
import { learningExtractorsFromEnv } from '../../../src/server/node-memory-integration.ts'
import { DEFAULT_SUBSTITUTE_CLASSIFIER_MODEL, createSubstituteClassifier } from './llm-classifier.ts'
import { DEFAULT_JEV_MODEL, TYPESAFE_ENDPOINT, createTypeSafeClassifier } from './typesafe-classifier.ts'

const request: ClassifierRequest = { state: { user_turn: 'I prefer aisle seats.', c0_clause: 'I prefer aisle seats' }, questions: candidateQuestions('c0') }

const answers = {
  c0_act: { type: 'choice', choice: 'self_statement', probabilities: { self_statement: 0.94, quoted: 0.01, hypothetical: 0.01, joke: 0.01, question: 0.01, assistant_echo: 0.01, task_instruction: 0.01 }, confidence: 0.88 },
  c0_durability: { type: 'choice', choice: 'durable', probabilities: { durable: 0.9, temporary: 0.08, not_memory: 0.02 }, confidence: 0.8 },
  c0_claim: { type: 'noul', noul: 0.93 },
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const signal = () => new AbortController().signal

describe('Stage 11 TypeSafe (Jev) adapter against the documented contract (fixture HTTP, no network)', () => {
  it('posts state, a pinned model and typed questions with a bearer key, and parses answers and usage', async () => {
    const fetch = vi.fn(async () => json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1_000, output_tokens: 40 } }))
    const classifier = createTypeSafeClassifier({ apiKey: 'fixture-key', fetch })
    const result = await classifier.classify(request, signal())
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(TYPESAFE_ENDPOINT)
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fixture-key')
    expect(JSON.parse(String(init.body))).toEqual({ state: request.state, model: DEFAULT_JEV_MODEL, questions: request.questions })
    expect(DEFAULT_JEV_MODEL).toBe('jev-1.13.0')
    expect(result).toMatchObject({ ok: true, model: 'jev-1.13.0', usage: { inputTokens: 1_000, outputTokens: 40, costMicros: 42 } })
    expect(classifier).toMatchObject({ provider: 'typesafe_jev', placement: 'remote' })
  })

  it('maps documented errors to typed failures and retries 429/529 once', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [422, 'invalid_request'], [500, 'unavailable']] as const) {
      const result = await createTypeSafeClassifier({ apiKey: 'k', fetch: vi.fn(async () => json({ detail: 'x' }, status)) }).classify(request, signal())
      expect(result).toMatchObject({ ok: false, failure: { code } })
    }
    const rateLimited = vi.fn(async () => json({}, 429))
    expect(await createTypeSafeClassifier({ apiKey: 'k', fetch: rateLimited, retryDelayMs: 1 }).classify(request, signal())).toMatchObject({ ok: false, failure: { code: 'rate_limited', retryable: true } })
    expect(rateLimited).toHaveBeenCalledTimes(2)
    const recovers = vi.fn()
      .mockResolvedValueOnce(json({}, 529, { 'retry-after': '0' }))
      .mockResolvedValueOnce(json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 1 } }))
    expect(await createTypeSafeClassifier({ apiKey: 'k', fetch: recovers, retryDelayMs: 1 }).classify(request, signal())).toMatchObject({ ok: true })
  })

  it('treats malformed, contradictory or partial answers as malformed, not as partial truth', async () => {
    const bad = [
      { answers: { ...answers, c0_claim: undefined } },
      { answers: { ...answers, c0_act: { ...answers.c0_act, choice: 'grant_admin' } } },
      { answers: { ...answers, c0_durability: { ...answers.c0_durability, probabilities: { durable: 0.9, temporary: 0.9, not_memory: 0 } } } },
      'not an object',
    ]
    for (const body of bad) {
      const result = await createTypeSafeClassifier({ apiKey: 'k', fetch: vi.fn(async () => json(body)) }).classify(request, signal())
      expect(result).toMatchObject({ ok: false, failure: { code: 'malformed' } })
    }
    const invalidJson = await createTypeSafeClassifier({ apiKey: 'k', fetch: vi.fn(async () => new Response('<html>')) }).classify(request, signal())
    expect(invalidJson).toMatchObject({ ok: false, failure: { code: 'malformed' } })
  })

  it('distinguishes timeout from cancellation, refuses oversized requests locally, and never leaks the key', async () => {
    const hang = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))))
    const classifier = createTypeSafeClassifier({ apiKey: 'secret-key-value', fetch: hang as unknown as typeof fetch })
    expect(await classifier.classify(request, AbortSignal.timeout(20))).toMatchObject({ ok: false, failure: { code: 'timeout' } })
    const controller = new AbortController()
    const pending = classifier.classify(request, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, failure: { code: 'cancelled' } })
    const offline = vi.fn(async () => { throw new TypeError('fetch failed') })
    const down = await createTypeSafeClassifier({ apiKey: 'secret-key-value', fetch: offline }).classify(request, signal())
    expect(down).toMatchObject({ ok: false, failure: { code: 'unavailable', retryable: true } })
    expect(JSON.stringify(down)).not.toContain('secret-key-value')
    const huge = await classifier.classify({ state: { text: 'x'.repeat(40_000) }, questions: request.questions }, signal())
    expect(huge).toMatchObject({ ok: false, failure: { code: 'invalid_request' } })
    expect(await createTypeSafeClassifier({ apiKey: '' }).classify(request, signal())).toMatchObject({ ok: false, failure: { code: 'not_configured' } })
  })
})

describe('Stage 11 substitute classifier (OpenRouter, fixture HTTP, no network)', () => {
  it('asks the pinned substitute model with minimal reasoning and completes distributions locally', async () => {
    const content = { answers: {
      c0_act: { probabilities: { self_statement: 8, quoted: 1, hypothetical: 0, joke: 1, question: 0, assistant_echo: 0, task_instruction: 0 } },
      c0_durability: { probabilities: { durable: 0.7, temporary: 0.2, not_memory: 0.1 } },
      c0_claim: { noul: 0.9 },
    } }
    const fetch = vi.fn(async () => json({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 400, completion_tokens: 60, cost: 0.00007 } }))
    const classifier = createSubstituteClassifier({ apiKey: 'fixture', fetch })
    const result = await classifier.classify(request, signal())
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).toMatchObject({ model: DEFAULT_SUBSTITUTE_CLASSIFIER_MODEL, reasoning: { effort: 'minimal' }, response_format: { type: 'json_object' } })
    expect(DEFAULT_SUBSTITUTE_CLASSIFIER_MODEL).toBe('openai/gpt-6-luna')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answers.c0_act).toMatchObject({ type: 'choice', choice: 'self_statement' })
    expect((result.answers.c0_act as { probabilities: Record<string, number> }).probabilities.self_statement).toBeCloseTo(0.8)
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 60, costMicros: 70 })
    expect(classifier.provider).toBe('llm_substitute')
  })

  it('reports missing answers as malformed and keeps the spent usage', async () => {
    const fetch = vi.fn(async () => json({ choices: [{ message: { content: JSON.stringify({ answers: { c0_claim: { noul: 0.9 } } }) } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 } }))
    expect(await createSubstituteClassifier({ apiKey: 'k', fetch }).classify(request, signal())).toMatchObject({ ok: false, failure: { code: 'malformed' }, usage: { costMicros: 10 } })
  })
})

describe('Stage 11 wiring', () => {
  const base = { GIDEON_MEMORY_CLASSIFIER_REMOTE_ALLOWED: '1', OPENROUTER_API_KEY: 'k', TYPESAFE_API_KEY: 't' } as NodeJS.ProcessEnv
  it('keeps the rule extractor alone unless the classifier is fully configured', () => {
    expect(learningExtractorsFromEnv({} as NodeJS.ProcessEnv)).toMatchObject({ extractor: { id: 'gideon-rules' }, includeKnownMemories: false })
    expect(learningExtractorsFromEnv({ ...base, TYPESAFE_API_KEY: '', GIDEON_MEMORY_CLASSIFIER_MODE: 'shadow' })).toMatchObject({ extractor: { id: 'gideon-rules' } })
  })
  it('shadow leaves the writing extractor unchanged; enforce wraps it', () => {
    const shadow = learningExtractorsFromEnv({ ...base, GIDEON_MEMORY_CLASSIFIER_MODE: 'shadow' })
    expect(shadow.extractor.id).toBe('gideon-rules')
    expect(shadow.shadowExtractor?.id).toBe('gideon-rules+typesafe-jev+verify')
    expect(shadow.includeKnownMemories).toBe(true)
    const enforce = learningExtractorsFromEnv({ ...base, GIDEON_MEMORY_CLASSIFIER_MODE: 'enforce', GIDEON_MEMORY_CLASSIFIER_PROVIDER: 'substitute', GIDEON_MEMORY_CLASSIFIER_WORKFLOW: 'gate' })
    expect(enforce.extractor.id).toBe('gideon-rules+llm-substitute-classifier+gate')
    expect(enforce.shadowExtractor).toBeUndefined()
    expect(enforce.includeKnownMemories).toBe(false)
  })
})
