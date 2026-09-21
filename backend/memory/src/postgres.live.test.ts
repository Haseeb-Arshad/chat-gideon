import { Pool } from 'pg'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createServerMemorySession } from '../../../src/server/memory-session.ts'
import { EphemeralMemoryStore } from '../../../src/lib/tools/memory.ts'
import type { AssertionVersion, ConsentId, EventEnvelope, RevisionId } from '../../../src/lib/memory/contracts.ts'
import { captureCommittedEvent } from './capture.ts'
import { checkMemoryHealth, checkMemoryReadiness } from './health.ts'
import { applyMigrations } from './migrations.ts'
import { claimJobs, completeJob, failJob } from './jobs.ts'
import { PostgresMemoryStore } from './postgres.ts'

const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)

function session(owner: string) {
  return createServerMemorySession({
    owner,
    store: new EphemeralMemoryStore(),
    channel: 'test',
    authority: 'worker_auth_session',
  })
}

function eventFor(memorySession: ReturnType<typeof session>, run: string, index: number, receivedAt: string): EventEnvelope {
  return {
    schemaVersion: 1,
    id: `event/${run}/${index}` as EventEnvelope['id'],
    idempotencyKey: `idem/${run}/${index}`,
    conversationId: `conversation/${run}` as EventEnvelope['conversationId'],
    turnId: `turn/${run}/${index}` as EventEnvelope['turnId'],
    actor: { kind: 'principal', principalId: memorySession.principal.id },
    subject: memorySession.subject,
    sourceKind: 'user_statement',
    sourceAuthority: { kind: 'authenticated_user', revision: `revision/source/${run}/${index}` as EventEnvelope['sourceAuthority']['revision'] },
    committedPhase: 'committed',
    sequence: index,
    sourceTime: null,
    sourceTimePrecision: 'unknown',
    receivedAt,
    consent: { id: `consent/${run}/${index}` as ConsentId, policyVersion: `revision/policy/${run}` as RevisionId, purpose: 'memory_capture' },
    sourceSpans: [],
    payload: { text: `synthetic memory event ${run}/${index}` },
  }
}

function assertionFor(memorySession: ReturnType<typeof session>, event: EventEnvelope, assertionId: string, text: string): AssertionVersion {
  return {
    schemaVersion: 1,
    id: assertionId as AssertionVersion['id'],
    revision: 1,
    scopeId: memorySession.scope.id,
    subject: memorySession.subject,
    kind: 'preference',
    payload: { kind: 'preference', text, conditions: [], exceptions: [] },
    attribution: { actor: { kind: 'principal', principalId: memorySession.principal.id }, basis: 'explicit_user_statement' },
    polarity: 'positive',
    status: 'accepted',
    time: {
      validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null },
      receivedAt: event.receivedAt,
      interpretedAt: event.receivedAt,
      relation: 'ordinary',
    },
    evidence: [{ eventId: event.id, span: null, relation: 'supports' }],
    dependencies: [],
    producer: { name: 'stage-03-test-extractor', version: '1', model: null },
  }
}

async function resetSchema(pool: Pool): Promise<void> {
  if (process.env.MEMORY_TEST_DATABASE_OWNED !== '1') throw new Error('The live PostgreSQL test requires an owned disposable database.')
  await pool.query('DROP SCHEMA IF EXISTS gideon_memory CASCADE')
  await applyMigrations(pool)
}

describe.skipIf(!enabled)('Stage 03 PostgreSQL authority and fenced jobs', () => {
  const run = `stage03-${Date.now()}`
  const database = new Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL, max: 8, connectionTimeoutMillis: 3_000 })
  const store = new PostgresMemoryStore(database)

  beforeAll(async () => {
    await resetSchema(database)
    const readiness = await checkMemoryReadiness(database)
    expect(readiness).toMatchObject({ status: 'ok', pendingMigrations: 0, schema: 'gideon_memory' })
  })

  afterAll(async () => {
    await store.close()
  })

  it('captures event, receipt, and outbox job atomically and detects idempotency conflicts', async () => {
    const memorySession = session(`user/${run}-atomic`)
    await store.provisionTrustedContext(memorySession)
    const timestamp = '2026-09-21T00:00:00.000Z'
    const event = eventFor(memorySession, `${run}-atomic`, 1, timestamp)
    const captured = await captureCommittedEvent(store, memorySession, event, { now: timestamp })
    expect(captured).toMatchObject({ ok: true, state: 'captured', eventId: event.id })
    const duplicate = await captureCommittedEvent(store, memorySession, event, { now: timestamp })
    expect(duplicate).toEqual(captured)
    const conflict = await captureCommittedEvent(store, memorySession, { ...event, payload: { text: 'different content' } }, { now: timestamp })
    expect(conflict).toMatchObject({ ok: false, state: 'failed', failure: { code: 'conflict' } })

    const counts = await database.query<{ events: string; jobs: string; receipts: string }>(
      `SELECT
        (SELECT count(*) FROM gideon_memory.events WHERE scope_id = $1) AS events,
        (SELECT count(*) FROM gideon_memory.jobs WHERE scope_id = $1) AS jobs,
        (SELECT count(*) FROM gideon_memory.receipts WHERE event_id = $2) AS receipts`,
      [memorySession.scope.id, event.id],
    )
    expect(counts.rows[0]).toEqual({ events: '1', jobs: '1', receipts: '1' })

    const crashEvent = eventFor(memorySession, `${run}-atomic-crash`, 2, timestamp)
    await expect(captureCommittedEvent(store, memorySession, crashEvent, { now: timestamp, injectFailureAfterEventInsert: true })).rejects.toThrow('injected capture crash')
    const rolledBack = await database.query<{ count: string }>(
      `SELECT count(*) FROM gideon_memory.events WHERE event_id = $1`,
      [crashEvent.id],
    )
    expect(rolledBack.rows[0]?.count).toBe('0')
  })

  it('coordinates bounded claims, retries, scoped reads, and scalar first-insert contention', async () => {
    const memorySession = session(`user/${run}-contention`)
    await store.provisionTrustedContext(memorySession)
    const timestamp = '2026-09-21T00:01:00.000Z'
    const firstEvent = eventFor(memorySession, `${run}-contention`, 1, timestamp)
    const secondEvent = eventFor(memorySession, `${run}-contention`, 2, timestamp)
    await captureCommittedEvent(store, memorySession, firstEvent, { now: timestamp })
    await captureCommittedEvent(store, memorySession, secondEvent, { now: timestamp })
    const [workerOne, workerTwo] = await Promise.all([
      claimJobs(store, { workerId: `${run}-one`, scopeId: memorySession.scope.id, limit: 1, now: timestamp, leaseMs: 10_000 }),
      claimJobs(store, { workerId: `${run}-two`, scopeId: memorySession.scope.id, limit: 1, now: timestamp, leaseMs: 10_000 }),
    ])
    const jobs = [...workerOne, ...workerTwo]
    expect(jobs).toHaveLength(2)
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(2)

    const assertions = jobs.map((job) => {
      const sourceEvent = job.inputEventId === firstEvent.id ? firstEvent : secondEvent
      return { job, assertion: assertionFor(memorySession, sourceEvent, `assertion/${run}/${job.jobId}`, `name from ${job.jobId}`) }
    })
    const completions = await Promise.all(assertions.map(({ job, assertion }) => completeJob(store, job, { assertion: { assertion, expectedRevision: null, slot: { slotId: 'user.display_name', cardinality: 'scalar' } } }, { now: timestamp })))
    expect(completions.filter((completion) => completion.status === 'completed')).toHaveLength(1)
    expect(completions.filter((completion) => completion.status === 'dead')).toHaveLength(1)

    const visibleToOwner = await store.forSession(memorySession).transaction((transaction) => transaction.scopedCandidates({ scopeId: memorySession.scope.id, subject: memorySession.subject, query: 'name from', limit: 10, asOf: null }))
    expect(visibleToOwner).toHaveLength(1)

    const otherSession = session(`user/${run}-other`)
    await store.provisionTrustedContext(otherSession)
    const hiddenFromOther = await store.forSession(otherSession).transaction((transaction) => transaction.scopedCandidates({ scopeId: otherSession.scope.id, subject: otherSession.subject, query: 'name from', limit: 10, asOf: null }))
    expect(hiddenFromOther).toHaveLength(0)

    const retryEvent = eventFor(memorySession, `${run}-retry`, 3, timestamp)
    await captureCommittedEvent(store, memorySession, retryEvent, { now: timestamp })
    const [retryJob] = await claimJobs(store, { workerId: `${run}-retry-worker`, scopeId: memorySession.scope.id, limit: 1, now: timestamp, leaseMs: 10_000 })
    expect(retryJob).toBeDefined()
    const retry = await failJob(store, retryJob!, { code: 'transient_provider', retryable: true }, { now: timestamp })
    expect(retry.status).toBe('retry_scheduled')
    const reclaimed = await claimJobs(store, { workerId: `${run}-retry-worker-2`, scopeId: memorySession.scope.id, limit: 1, now: retry.status === 'retry_scheduled' ? retry.availableAt : timestamp, leaseMs: 10_000 })
    expect(reclaimed).toHaveLength(1)
    const dead = await failJob(store, reclaimed[0]!, { code: 'permanent_invalid', retryable: false }, { now: retry.status === 'retry_scheduled' ? retry.availableAt : timestamp })
    expect(dead.status).toBe('dead')
  })

  it('rejects stale-fence completion after lease expiry and accepts only the replacement fence', async () => {
    const memorySession = session(`user/${run}-fence`)
    await store.provisionTrustedContext(memorySession)
    const start = Date.parse('2026-09-21T00:02:00.000Z')
    const event = eventFor(memorySession, `${run}-fence`, 1, new Date(start).toISOString())
    await captureCommittedEvent(store, memorySession, event, { now: new Date(start).toISOString() })
    const [first] = await claimJobs(store, { workerId: `${run}-fence-one`, scopeId: memorySession.scope.id, limit: 1, now: new Date(start).toISOString(), leaseMs: 100 })
    expect(first).toBeDefined()
    const [replacement] = await claimJobs(store, { workerId: `${run}-fence-two`, scopeId: memorySession.scope.id, limit: 1, now: new Date(start + 200).toISOString(), leaseMs: 10_000 })
    expect(replacement).toBeDefined()
    expect(replacement!.fence).toBeGreaterThan(first!.fence)
    const assertion = assertionFor(memorySession, event, `assertion/${run}/fence`, 'fenced value')
    const stale = await completeJob(store, first!, { assertion: { assertion, expectedRevision: null, slot: null } }, { now: new Date(start + 250).toISOString() })
    expect(stale.status).toBe('lease_lost')
    const accepted = await completeJob(store, replacement!, { assertion: { assertion, expectedRevision: null, slot: null } }, { now: new Date(start + 300).toISOString() })
    expect(accepted).toEqual({ status: 'completed', revision: 1 })
    const receipt = await store.forSession(memorySession).transaction((transaction) => transaction.readReceiptByEvent(event.id))
    expect(receipt).toMatchObject({ ok: true, state: 'accepted', canonicalRevision: 'revision/assertion/' + run + '/fence/1' })
  })

  it('reports database outage as unavailable instead of an empty corpus', async () => {
    const unavailable = new Pool({ connectionString: 'postgresql://gideon_test@127.0.0.1:65431/postgres', connectionTimeoutMillis: 100 })
    const health = await checkMemoryHealth(unavailable)
    await unavailable.end()
    expect(health).toMatchObject({ service: 'memory-postgres', status: 'unavailable' })
  })
})
