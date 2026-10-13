import { Tiktoken } from 'js-tiktoken/lite'
import ranks from 'js-tiktoken/ranks/o200k_base'
import type { RetrievalEmbeddingProvider, RetrieveMemoryOptions } from './retrieval.ts'

export interface MemoryProviderEnvironment {
  OPENROUTER_API_KEY?: string
  OPENROUTER_SITE_URL?: string
  GIDEON_MEMORY_EMBEDDINGS_REMOTE_ALLOWED?: string
  GIDEON_MEMORY_EMBEDDING_MODEL?: string
  GIDEON_MEMORY_EMBEDDING_DIMENSIONS?: string
  GIDEON_MEMORY_REFINEMENT_ENABLED?: string
  GIDEON_MEMORY_SEMANTIC_GRACE_MS?: string
}

/**
 * How long the lookup in front of every reply goes on waiting for the query's
 * embedding once its other branches have answered. Measured on 13 October
 * 2026, the remote embedding took 1.5 to 1.8 seconds a call, which is the
 * whole recall deadline: every reply waited the deadline out and then got no
 * memory at all. The other branches finish in a fraction of that, so they wait
 * this much longer and no more. `-1` waits for it without limit.
 */
const DEFAULT_SEMANTIC_GRACE_MS = 80

function semanticGrace(value: string | undefined): number | undefined {
  const parsed = Number(value?.trim() || DEFAULT_SEMANTIC_GRACE_MS)
  if (parsed === -1) return undefined
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : DEFAULT_SEMANTIC_GRACE_MS
}
const tokenizer = new Tiktoken(ranks)
export const MEMORY_TOKENIZER = Object.freeze({
  id: 'o200k_base-v1',
  countTokens: (text: string) => tokenizer.encode(text, [], []).length,
})

/** Provider instances belong to a bound runtime; query text never crosses owner caches. */
export function embeddingProviderFromEnv(env: MemoryProviderEnvironment, fetcher = fetch): RetrievalEmbeddingProvider | undefined {
  const key = env.OPENROUTER_API_KEY?.trim()
  if (!key || env.GIDEON_MEMORY_EMBEDDINGS_REMOTE_ALLOWED !== '1') return undefined
  const modelId = env.GIDEON_MEMORY_EMBEDDING_MODEL?.trim() || 'openai/text-embedding-3-small'
  const dimensions = Number(env.GIDEON_MEMORY_EMBEDDING_DIMENSIONS || 512)
  const queryCache=new Map<string,{expires:number;vector:readonly number[]}>()
  let recentQueryMs: number | null = null
  if (!Number.isInteger(dimensions) || dimensions < 32 || dimensions > 4096) throw new Error('Invalid memory embedding dimension')
  return {
    modelId, modelVersion: `dimensions-${dimensions}-v1`, dimensions, placement: 'remote',
    recentQueryMs: () => recentQueryMs,
    async embed(texts, signal) {
      if(signal.aborted)throw new Error('Embedding cancelled')
      if (!texts.length || texts.length > 16 || texts.some(text => !text.trim() || text.length > 8192)) throw new Error('Embedding input exceeds bounded limits')
      const cached=texts.length===1?queryCache.get(texts[0]):undefined
      if(cached && cached.expires>Date.now())return [[...cached.vector]]
      const started = Date.now()
      const response = await fetcher('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(texts.length>1?12000:2500)]),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}) },
        body: JSON.stringify({ model: modelId, dimensions, encoding_format: 'float', input: texts, provider: { data_collection: 'deny' } }),
      })
      if (!response.ok) throw new Error(`Memory embedding provider HTTP ${response.status}`)
      const body = await response.json() as { data?: { index: number; embedding: number[] }[] }
      const values = body.data?.sort((a, b) => a.index - b.index)
      if (!values || values.length !== texts.length || values.some((row, i) => row.index !== i || !Array.isArray(row.embedding) || row.embedding.length !== dimensions || !row.embedding.every(Number.isFinite))) throw new Error('Invalid memory embeddings')
      if(texts.length===1){recentQueryMs=Date.now()-started;if(queryCache.size>=32)queryCache.delete(queryCache.keys().next().value!);queryCache.set(texts[0],{expires:Date.now()+60000,vector:values[0].embedding})}
      return values.map(row => row.embedding)
    },
  }
}

export function memoryRetrievalOptions(env: MemoryProviderEnvironment): RetrieveMemoryOptions {
  return {
    // Cross-language pairs with unfamiliar names can score below 0.25. This
    // floor admits them; current-version hydration and the attributed reader
    // still decide what can support an answer. Validate on a fresh holdout.
    tokenizer: MEMORY_TOKENIZER, compact: true, minimumSimilarity:0.15,
    recordTraces: env.GIDEON_MEMORY_REFINEMENT_ENABLED === '1',
    semanticGraceMs: semanticGrace(env.GIDEON_MEMORY_SEMANTIC_GRACE_MS),
    embeddingProvider: embeddingProviderFromEnv(env),
    authorizeRemoteEmbedding: session => session.trust === 'authenticated' && env.GIDEON_MEMORY_EMBEDDINGS_REMOTE_ALLOWED === '1',
  }
}
