import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EphemeralMemoryStore } from '../../../src/lib/tools/memory.ts'
import { createServerMemorySession } from '../../../src/server/memory-session.ts'
import { createRecallInput, createRuntime } from '../../../src/server/memory-turn-runtime.ts'
import { memoryFeatureFlags } from '../../../src/lib/memory/rollout.ts'
import { executeExplicitCommand } from './commands.ts'
import { updateMemorySettings } from './controls.ts'
import { applyMigrations } from './migrations.ts'
import { PostgresMemoryStore } from './postgres.ts'
import { retrieveMemory, type RetrievalEmbeddingProvider } from './retrieval.ts'

/**
 * The lookup in front of every reply, on real PostgreSQL: what it waits for
 * and how many statements it spends. On 13 October 2026 it was waiting out its
 * whole deadline for a remote embedding on every turn and then returning
 * nothing; these hold the fixes in place.
 * Run with `node scripts/memory-postgres-harness.mjs backend/memory/src/recall-latency.live.test.ts`.
 */

const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)
const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL ?? ''
const run = `recall-${Date.now()}`
const FLAGS = memoryFeatureFlags({ GIDEON_MEMORY_ROLLOUT_PERCENT: '100', GIDEON_MEMORY_CAPTURE_ENABLED: '1', GIDEON_MEMORY_COMMAND_WRITES_ENABLED: '1', GIDEON_MEMORY_RECALL_ENABLED: '1' }, 'user/x', true)

/** An embedding provider that answers after `ms`, with nothing indexed to match. */
function embedding(ms: number, known: number | null = null): RetrievalEmbeddingProvider & { calls: number } {
  const provider = {
    modelId: 'test/slow-embedding', modelVersion: 'v1', dimensions: 32, placement: 'remote' as const, calls: 0,
    recentQueryMs: () => known,
    async embed(texts: readonly string[], signal: AbortSignal) {
      provider.calls += 1
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
      })
      return texts.map(() => Array.from({ length: 32 }, (_, index) => (index === 0 ? 1 : 0)))
    },
  }
  return provider
}

function input(query: string, deadlineMs = 10_000) {
  return { ...createRecallInput(query, 'UTC', null, query, undefined, deadlineMs), consistency: 'authoritative' }
}

describe.skipIf(!enabled)('recall in front of a reply', () => {
  let statements = 0
  const database = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3_000 })
  database.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown
    client.query = ((...args: unknown[]) => { statements += 1; return query(...args) }) as typeof client.query
  })
  const store = new PostgresMemoryStore(database)
  let counter = 0

  beforeAll(async () => {
    if (process.env.MEMORY_TEST_DATABASE_OWNED !== '1') throw new Error('These tests require an owned disposable database.')
    await database.query('DROP SCHEMA IF EXISTS gideon_memory CASCADE')
    await applyMigrations(database)
  })

  afterAll(async () => {
    await store.close()
  })

  async function owner(tag: string) {
    const session = createServerMemorySession({ owner: `user/${run}-${tag}`, store: new EphemeralMemoryStore(), channel: 'test', authority: 'worker_auth_session' })
    await store.provisionTrustedContext(session)
    const bound = { ...session, store }
    const saved = await executeExplicitCommand(bound, { schemaVersion: 1, commandId: `command/${run}/${tag}/${(counter += 1)}`, kind: 'remember', text: 'The dog is called Bruno', assertionKind: 'fact', conditions: [] })
    expect(saved).toMatchObject({ ok: true })
    return bound
  }

  it('answers from its other branches rather than wait for a slow embedding', async () => {
    const bound = await owner('slow')
    const provider = embedding(2_000)
    const started = Date.now()
    const result = await retrieveMemory(bound, input('what is the dog called'), { embeddingProvider: provider, authorizeRemoteEmbedding: () => true, semanticGraceMs: 50 })
    const took = Date.now() - started

    expect(took).toBeLessThan(1_500)
    expect(provider.calls).toBe(1)
    if (!result.ok) throw new Error(result.failure.message)
    expect(result.pack.text).toContain('Bruno')
    // Coverage says what was not searched, so a miss is not read as absence.
    expect(result.pack.coverage.branches.semantic).toMatchObject({ status: 'timed_out', reason: 'semantic_left_behind' })
    expect(result.pack.coverage.outcome).toBe('partial')
  })

  it('does not wait at all for an embedding that has already shown itself slow', async () => {
    const bound = await owner('known-slow')
    const started = Date.now()
    // The grace alone would hold this for five seconds.
    const result = await retrieveMemory(bound, input('what is the dog called'), { embeddingProvider: embedding(8_000, 1_600), authorizeRemoteEmbedding: () => true, semanticGraceMs: 5_000 })
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(result.ok && result.pack.text).toContain('Bruno')
  })

  it('waits for the embedding when the lookup was asked for', async () => {
    const bound = await owner('asked')
    const started = Date.now()
    const result = await retrieveMemory(bound, input('what is the dog called'), { embeddingProvider: embedding(400), authorizeRemoteEmbedding: () => true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(380)
    if (!result.ok) throw new Error(result.failure.message)
    expect(result.pack.coverage.branches.semantic.status).toBe('complete')
  })

  it('still includes a quick embedding, which costs the lookup nothing', async () => {
    const bound = await owner('quick')
    // Once to plan the statements, so the second measures the race rather than a cold start.
    await retrieveMemory(bound, input('what is the dog called'))
    const result = await retrieveMemory(bound, input('what is the dog called'), { embeddingProvider: embedding(1), authorizeRemoteEmbedding: () => true, semanticGraceMs: 500 })
    if (!result.ok) throw new Error(result.failure.message)
    expect(result.pack.coverage.branches.semantic.status).toBe('complete')
  })

  it('spends a bounded number of statements, and hands every connection back', async () => {
    const bound = await owner('budget')
    await retrieveMemory(bound, input('what is the dog called'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    statements = 0
    const result = await retrieveMemory(bound, input('what is the dog called'))
    expect(result.ok && result.pack.text).toContain('Bruno')
    // Each read used to open with BEGIN, a statement timeout and an
    // authorization check of its own, and close by waiting on COMMIT: about
    // sixty statements a lookup. A regression back towards that shows here.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(statements).toBeLessThanOrEqual(40)

    // Reads return before their commit lands; the connection must still come
    // back, or a pool this small would stop after a couple of lookups.
    const small = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 2_000 })
    try {
      const tight = { ...bound, store: new PostgresMemoryStore(small) }
      for (let index = 0; index < 12; index += 1) {
        const again = await retrieveMemory(tight, input('what is the dog called'))
        expect(again.ok && again.pack.text).toContain('Bruno')
      }
    } finally {
      await small.end()
    }
  })

  it('reads the temporary setting beside the lookup, and neither returns nor embeds anything while it is on', async () => {
    const bound = await owner('temporary')
    const provider = embedding(1)
    const runtime = createRuntime(bound, FLAGS, { embeddingProvider: provider, authorizeRemoteEmbedding: () => true, semanticGraceMs: 50 })
    const context = {
      turnId: 'turn-1', responseId: 'response-1', principalId: bound.principal.id, scopeId: bound.scope.id, policyEpoch: bound.policyEpoch,
      timezone: 'UTC', latestUserText: 'what is the dog called', transcriptHash: 'hash', speculative: false, conversationState: null,
    }
    const open = await runtime.retrieve('what is the dog called', context, new AbortController().signal)
    expect(open.status).toBe('ready')
    expect(provider.calls).toBe(1)

    expect(await updateMemorySettings(bound, { expectedRevision: 0, temporary: { on: true } })).toMatchObject({ ok: true })
    // A runtime outlives the turn it was made for, so the next turn must see the change.
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    const closed = await runtime.retrieve('what is the dog called', { ...context, turnId: 'turn-2' }, new AbortController().signal)
    expect(closed).toEqual({ status: 'unavailable', reason: 'temporary' })
    // The query never left for the embedding provider.
    expect(provider.calls).toBe(1)
  }, 15_000)
})
