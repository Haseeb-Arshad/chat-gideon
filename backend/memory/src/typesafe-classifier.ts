import {
  NO_USAGE,
  parseClassifierAnswers,
  validateClassifierRequest,
  type ClassifierFailureCode,
  type ClassifierRequest,
  type ClassifierResult,
  type MemoryClassifier,
} from '../../../src/lib/memory/classification.ts'

/**
 * Server-only adapter for TypeSafe's System One API (Jev).
 *
 * Contract verified against the official reference on 2026-09-23:
 * `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer`,
 * body `{ state, model, questions }`, answers keyed by question id, usage in
 * input/output tokens; 401/422/429/529 errors; 64k tokens per request and
 * 32k for state plus the longest question; $0.042 per million input tokens,
 * output free. The model is pinned to a versioned id (not `jev-latest`)
 * because thresholds are tuned per version.
 *
 * Off by default. Built only when the classifier mode, provider and remote
 * spend switch are all set and a key exists. The key never reaches the
 * browser, logs or error values.
 */

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-1.13.0'
/** Micro-dollars per input token: $0.042 per million tokens. */
const INPUT_MICROS_PER_TOKEN = 0.042

export interface TypeSafeClassifierOptions {
  apiKey: string
  model?: string
  endpoint?: string
  fetch?: typeof globalThis.fetch
  /** One bounded retry on 429/529 by default; background work only. */
  maxRetries?: number
  retryDelayMs?: number
  now?: () => number
}

function failure(code: ClassifierFailureCode, retryable: boolean, latencyMs: number): ClassifierResult {
  return { ok: false, failure: { code, retryable }, usage: NO_USAGE, latencyMs }
}

function statusFailure(status: number): { code: ClassifierFailureCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'unauthorized', retryable: false }
  if (status === 400 || status === 404 || status === 422) return { code: 'invalid_request', retryable: false }
  if (status === 429) return { code: 'rate_limited', retryable: true }
  if (status === 529) return { code: 'overloaded', retryable: true }
  return { code: 'unavailable', retryable: status >= 500 }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

function abortCode(signal: AbortSignal): ClassifierFailureCode {
  const reason = signal.reason as { name?: string } | undefined
  return reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled'
}

export function createTypeSafeClassifier(options: TypeSafeClassifierOptions): MemoryClassifier {
  const model = options.model?.trim() || DEFAULT_JEV_MODEL
  const endpoint = options.endpoint ?? TYPESAFE_ENDPOINT
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const clock = options.now ?? (() => performance.now())
  const maxRetries = Math.min(Math.max(options.maxRetries ?? 1, 0), 3)
  return Object.freeze({
    id: 'typesafe-jev',
    version: '1.0.0',
    model,
    placement: 'remote' as const,
    provider: 'typesafe_jev' as const,
    async classify(request: ClassifierRequest, signal: AbortSignal): Promise<ClassifierResult> {
      const started = clock()
      const elapsed = () => Math.round(clock() - started)
      if (!validateClassifierRequest(request).ok) return failure('invalid_request', false, 0)
      if (!options.apiKey) return failure('not_configured', false, 0)
      const body = JSON.stringify({ state: request.state, model, questions: request.questions })
      for (let attempt = 0; ; attempt += 1) {
        if (signal.aborted) return failure(abortCode(signal), false, elapsed())
        let response: Response
        try {
          response = await fetcher(endpoint, {
            method: 'POST',
            signal,
            headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
            body,
          })
        } catch {
          if (signal.aborted) return failure(abortCode(signal), false, elapsed())
          return failure('unavailable', true, elapsed())
        }
        if (!response.ok) {
          const mapped = statusFailure(response.status)
          await response.body?.cancel().catch(() => undefined)
          if (mapped.retryable && attempt < maxRetries && (response.status === 429 || response.status === 529)) {
            const retryAfter = Number(response.headers.get('retry-after'))
            const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 5_000) : (options.retryDelayMs ?? 500) * 2 ** attempt
            try { await sleep(delay, signal) } catch { return failure(abortCode(signal), false, elapsed()) }
            continue
          }
          return failure(mapped.code, mapped.retryable, elapsed())
        }
        let parsed: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } }
        try {
          parsed = await response.json() as typeof parsed
        } catch {
          if (signal.aborted) return failure(abortCode(signal), false, elapsed())
          return failure('malformed', false, elapsed())
        }
        const answers = parseClassifierAnswers(request, parsed.answers)
        const inputTokens = Number(parsed.usage?.input_tokens)
        const outputTokens = Number(parsed.usage?.output_tokens)
        const usage = {
          inputTokens: Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0,
          outputTokens: Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0,
          costMicros: Number.isFinite(inputTokens) && inputTokens >= 0 ? Math.ceil(inputTokens * INPUT_MICROS_PER_TOKEN) : 0,
        }
        if (!answers) return { ok: false, failure: { code: 'malformed', retryable: false }, usage, latencyMs: elapsed() }
        // Log the version that answered, not the alias that was requested.
        const answeredBy = typeof parsed.model === 'string' && parsed.model.length <= 80 ? parsed.model : model
        return { ok: true, answers, model: answeredBy, usage, latencyMs: elapsed() }
      }
    },
  })
}
