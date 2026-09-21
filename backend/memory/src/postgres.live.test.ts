import { Pool } from 'pg'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createServerMemorySession } from '../../../src/server/memory-session.ts'
import { EphemeralMemoryStore } from '../../../src/lib/tools/memory.ts'
import type { AssertionVersion, ConsentId, EventEnvelope, RevisionId } from '../../../src/lib/memory/contracts.ts'
import { captureCommittedEvent } from './capture.ts'
import { executeExplicitCommand, executeScopedException, readAcceptedChangeOverlay, readAssertionAsOf, readCurrentAssertion, resolveExplicitTarget } from './commands.ts'
import { checkMemoryHealth, checkMemoryReadiness } from './health.ts'
import { applyMigrations } from './migrations.ts'
import { claimJobs, completeJob, failJob } from './jobs.ts'
import { PostgresMemoryStore } from './postgres.ts'
import { sha256 } from './serialization.ts'

const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)

function session(owner: string) {
  return createServerMemorySession({
    owner,
    store: new EphemeralMemoryStore(),
    channel: 'test',
    authority: 'worker_auth_session',
  })
}

function postgresSession(memorySession: ReturnType<typeof session>, store: PostgresMemoryStore) {
  return { ...memorySession, store } as typeof memorySession & { store: PostgresMemoryStore }
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

  it('commits explicit remember once, preserves canonical slots, and publishes an accepted overlay', async () => {
    const memorySession = session(`user/${run}-commands-remember`)
    await store.provisionTrustedContext(memorySession)
    const durable = postgresSession(memorySession, store)
    const command = {
      schemaVersion: 1 as const,
      commandId: `command/${run}/remember-provider-a`,
      kind: 'remember' as const,
      text: 'Provider A',
      assertionKind: 'fact' as const,
      conditions: [],
    }
    const first = await executeExplicitCommand(durable, command, {
      now: '2026-09-21T01:00:00.000Z',
      slot: { slotId: 'project.database_provider', cardinality: 'scalar' },
    })
    expect(first).toMatchObject({ ok: true, outcome: 'accepted', receipt: { state: 'accepted' } })
    if (!first.ok) return
    expect(first.assertion.payload).toMatchObject({ kind: 'fact', proposition: { type: 'slot', slot: { slotId: 'project.database_provider', cardinality: 'scalar' }, value: 'Provider A' } })
    expect(first.changeWatermark).toBe(`watermark/${memorySession.scope.id}/1`)

    const duplicate = await executeExplicitCommand(durable, {
      ...command,
      commandId: `command/${run}/remember-provider-a-formatting-duplicate`,
      text: '  provider   a  ',
    }, {
      now: '2026-09-21T01:01:00.000Z',
      slot: { slotId: 'project.database_provider', cardinality: 'scalar' },
    })
    expect(duplicate).toMatchObject({ ok: true, outcome: 'duplicate', canonicalRevision: first.canonicalRevision, changeWatermark: null })

    const counts = await database.query<{ events: string; accepted: string; projectionJobs: string; changes: string }>(
      `SELECT
        (SELECT count(*) FROM gideon_memory.events WHERE scope_id = $1) AS events,
        (SELECT count(*) FROM gideon_memory.command_receipts WHERE scope_id = $1 AND outcome = 'accepted') AS accepted,
        (SELECT count(*) FROM gideon_memory.jobs WHERE scope_id = $1 AND kind = 'rebuild_projection') AS "projectionJobs",
        (SELECT count(*) FROM gideon_memory.change_feed WHERE scope_id = $1) AS changes`,
      [memorySession.scope.id],
    )
    expect(counts.rows[0]).toEqual({ events: '2', accepted: '1', projectionJobs: '1', changes: '1' })

    const current = await readCurrentAssertion(durable, first.assertion.id)
    expect(current.version).toMatchObject({ id: first.assertion.id, revision: 1 })
    const overlays = await readAcceptedChangeOverlay(durable)
    expect(overlays).toHaveLength(1)
    expect(overlays[0]).toMatchObject({ changeWatermark: first.changeWatermark, assertion: { assertionId: first.assertion.id, revision: 1 }, version: { status: 'accepted' } })
  })

  it('keeps correction, real-world transition, and source-time reads distinct', async () => {
    const memorySession = session(`user/${run}-commands-temporal`)
    await store.provisionTrustedContext(memorySession)
    const durable = postgresSession(memorySession, store)
    const initial = await executeExplicitCommand(durable, {
      schemaVersion: 1,
      commandId: `command/${run}/provider-a`,
      kind: 'remember',
      text: 'Provider A',
      assertionKind: 'fact',
      conditions: [],
    }, { now: '2026-09-01T00:00:00.000Z' })
    expect(initial.ok).toBe(true)
    if (!initial.ok) return

    const transition = await executeExplicitCommand(durable, {
      schemaVersion: 1,
      commandId: `command/${run}/provider-b-transition`,
      kind: 'correct',
      targetAssertionId: initial.assertion.id,
      targetRevision: 1,
      sourceRevision: 'policy/1',
      text: 'Provider B',
      assertionKind: 'fact',
      conditions: [],
      relation: 'transition',
      validTime: { from: '2026-09-10T00:00:00.000Z', until: null, precision: 'day', sourceTimeZone: 'UTC' },
    }, { now: '2026-09-21T00:00:00.000Z' })
    expect(transition).toMatchObject({ ok: true, outcome: 'accepted', receipt: { canonicalRevision: `revision/${initial.assertion.id}/2` } })
    if (!transition.ok) return
    expect(transition.assertion.supersedes).toEqual({ assertionId: initial.assertion.id, revision: 1 })

    const beforeTransition = await readAssertionAsOf(durable, { assertionId: initial.assertion.id, mode: 'valid_at', asOf: '2026-09-05T12:00:00.000Z' })
    const afterTransition = await readAssertionAsOf(durable, { assertionId: initial.assertion.id, mode: 'valid_at', asOf: '2026-09-12T12:00:00.000Z' })
    const beforeKnown = await readAssertionAsOf(durable, { assertionId: initial.assertion.id, mode: 'known_at', asOf: '2026-09-12T12:00:00.000Z' })
    const afterKnown = await readAssertionAsOf(durable, { assertionId: initial.assertion.id, mode: 'known_at', asOf: '2026-09-22T12:00:00.000Z' })
    expect(beforeTransition.version?.revision).toBe(1)
    expect(afterTransition.version?.revision).toBe(2)
    expect(beforeKnown.version?.revision).toBe(1)
    expect(afterKnown.version?.revision).toBe(2)
    expect(afterTransition.version?.time.receivedAt).toBe('2026-09-21T00:00:00.000Z')
    expect(afterTransition.version?.time.validTime.from).toBe('2026-09-10T00:00:00.000Z')

    const wrongSource = await executeExplicitCommand(durable, {
      schemaVersion: 1,
      commandId: `command/${run}/stale-source`,
      kind: 'correct',
      targetAssertionId: initial.assertion.id,
      targetRevision: 2,
      sourceRevision: 'source/changed',
      text: 'Provider C',
      assertionKind: 'fact',
      conditions: [],
    }, { now: '2026-09-22T00:00:00.000Z' })
    expect(wrongSource).toMatchObject({ ok: false, failure: { code: 'conflict', details: { reason: 'source_revision_changed' } } })

    const name = await executeExplicitCommand(durable, {
      schemaVersion: 1,
      commandId: `command/${run}/name-ali`,
      kind: 'remember',
      text: 'Ali',
      assertionKind: 'fact',
      conditions: [],
    }, { now: '2026-09-01T00:00:00.000Z' })
    expect(name.ok).toBe(true)
    if (!name.ok) return
    const nameCorrection = await executeExplicitCommand(durable, {
      schemaVersion: 1,
      commandId: `command/${run}/name-aly-correction`,
      kind: 'correct',
      targetAssertionId: name.assertion.id,
      targetRevision: 1,
      text: 'Aly',
      assertionKind: 'fact',
      conditions: [],
    }, { now: '2026-09-02T00:00:00.000Z' })
    expect(nameCorrection).toMatchObject({ ok: true, assertion: { revision: 2 } })
    if (!nameCorrection.ok) return
    const knownBeforeCorrection = await readAssertionAsOf(durable, { assertionId: name.assertion.id, mode: 'known_at', asOf: '2026-09-01T12:00:00.000Z' })
    const validAfterCorrection = await readAssertionAsOf(durable, { assertionId: name.assertion.id, mode: 'valid_at', asOf: '2026-09-01T12:00:00.000Z' })
    expect(knownBeforeCorrection.version?.payload).toMatchObject({ proposition: { text: 'Ali' } })
    expect(validAfterCorrection.version?.payload).toMatchObject({ proposition: { text: 'Aly' } })
    expect(nameCorrection.assertion.supersedes).toEqual({ assertionId: name.assertion.id, revision: 1 })
  })

  it('stores scoped exceptions with expiry without rewriting the global preference', async () => {
    const memorySession = session(`user/${run}-commands-exception`)
    await store.provisionTrustedContext(memorySession)
    const durable = postgresSession(memorySession, store)
    const globalPreference = await executeExplicitCommand(durable, {
      schemaVersion: 1,
      commandId: `command/${run}/global-style`,
      kind: 'remember',
      text: 'Prefer concise informal replies',
      assertionKind: 'preference',
      conditions: [],
    }, { now: '2026-09-20T00:00:00.000Z' })
    expect(globalPreference.ok).toBe(true)
    if (!globalPreference.ok) return
    const exception = await executeScopedException(durable, {
      schemaVersion: 1,
      commandId: `command/${run}/presentation-style`,
      text: 'Use a formal tone',
      assertionKind: 'preference',
      conditions: [{ key: 'activity', operator: 'equals', value: 'investor_presentation' }],
      validTime: { from: '2026-09-21T00:00:00.000Z', until: '2026-09-22T00:00:00.000Z', precision: 'day', sourceTimeZone: 'UTC' },
    }, { now: '2026-09-21T01:00:00.000Z' })
    expect(exception).toMatchObject({ ok: true, assertion: { time: { relation: 'temporary_exception' } } })
    if (!exception.ok) return
    expect(exception.assertion.id).not.toBe(globalPreference.assertion.id)
    const global = await readCurrentAssertion(durable, globalPreference.assertion.id, { now: '2026-09-23T00:00:00.000Z' })
    const expired = await readAssertionAsOf(durable, { assertionId: exception.assertion.id, mode: 'valid_at', asOf: '2026-09-23T00:00:00.000Z' })
    expect(global.version?.payload).toMatchObject({ text: 'Prefer concise informal replies' })
    expect(expired.version).toBeNull()
  })

  it('is idempotent across an ambiguous response, rolls back injected failures, and rejects stale revisions', async () => {
    const memorySession = session(`user/${run}-commands-retry`)
    await store.provisionTrustedContext(memorySession)
    const durable = postgresSession(memorySession, store)
    const lostResponseCommand = {
      schemaVersion: 1 as const,
      commandId: `command/${run}/lost-response`,
      kind: 'remember' as const,
      text: 'Retry-safe preference',
      assertionKind: 'preference' as const,
      conditions: [],
    }
    await expect(executeExplicitCommand(durable, lostResponseCommand, { now: '2026-09-21T02:00:00.000Z', injectResponseFailureAfterCommit: true })).rejects.toThrow('injected ambiguous command response')
    const retried = await executeExplicitCommand(durable, lostResponseCommand, { now: '2026-09-21T02:01:00.000Z' })
    expect(retried).toMatchObject({ ok: true, outcome: 'accepted' })
    const rolledBackCommand = {
      schemaVersion: 1 as const,
      commandId: `command/${run}/rollback`,
      kind: 'remember' as const,
      text: 'Rolled back preference',
      assertionKind: 'preference' as const,
      conditions: [],
    }
    await expect(executeExplicitCommand(durable, rolledBackCommand, { now: '2026-09-21T02:02:00.000Z', injectFailureAfterAssertion: true })).rejects.toThrow('injected command crash after assertion commit')
    const rolledBackCounts = await database.query<{ events: string; assertions: string; receipts: string }>(
      `SELECT
        (SELECT count(*) FROM gideon_memory.events WHERE scope_id = $1 AND idempotency_key = $2) AS events,
        (SELECT count(*) FROM gideon_memory.assertions WHERE scope_id = $1 AND canonical_key = $3) AS assertions,
        (SELECT count(*) FROM gideon_memory.command_receipts WHERE scope_id = $1 AND command_id = $4) AS receipts`,
      [memorySession.scope.id, `command/${run}/rollback`, sha256({ scopeId: memorySession.scope.id, subject: memorySession.subject, kind: 'preference', text: 'rolled back preference', conditions: [], relation: 'ordinary', validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null }, polarity: 'positive', slot: null }), `command/${run}/rollback`],
    )
    expect(rolledBackCounts.rows[0]).toEqual({ events: '0', assertions: '0', receipts: '0' })

    const retryAssertionId = (retried as { ok: true; assertion: AssertionVersion }).assertion.id
    const [editOne, editTwo] = await Promise.all([
      executeExplicitCommand(durable, {
        schemaVersion: 1,
        commandId: `command/${run}/edit-one`,
        kind: 'correct',
        targetAssertionId: retryAssertionId,
        targetRevision: 1,
        text: 'Edit one',
        assertionKind: 'preference',
        conditions: [],
      }, { now: '2026-09-21T02:03:00.000Z' }),
      executeExplicitCommand(durable, {
        schemaVersion: 1,
        commandId: `command/${run}/edit-two`,
        kind: 'correct',
        targetAssertionId: retryAssertionId,
        targetRevision: 1,
        text: 'Edit two',
        assertionKind: 'preference',
        conditions: [],
      }, { now: '2026-09-21T02:03:00.000Z' }),
    ])
    expect([editOne, editTwo].filter((item) => item.ok)).toHaveLength(1)
    expect([editOne, editTwo].filter((item) => !item.ok)).toHaveLength(1)
    expect([editOne, editTwo].find((item) => !item.ok)).toMatchObject({ failure: { code: 'conflict' } })
  })

  it('returns explicit quota errors and ambiguity instead of evicting or guessing', async () => {
    const memorySession = session(`user/${run}-commands-quota`)
    await store.provisionTrustedContext(memorySession)
    const durable = postgresSession(memorySession, store)
    await database.query(`UPDATE gideon_memory.quota_limits SET max_accepted_assertions = 1 WHERE scope_id = $1`, [memorySession.scope.id])
    const first = await executeExplicitCommand(durable, {
      schemaVersion: 1,
      commandId: `command/${run}/quota-first`,
      kind: 'remember',
      text: 'First durable preference',
      assertionKind: 'preference',
      conditions: [],
    }, { now: '2026-09-21T03:00:00.000Z' })
    expect(first).toMatchObject({ ok: true })
    const second = await executeExplicitCommand(durable, {
      schemaVersion: 1,
      commandId: `command/${run}/quota-second`,
      kind: 'remember',
      text: 'Second durable preference',
      assertionKind: 'preference',
      conditions: [],
    }, { now: '2026-09-21T03:01:00.000Z' })
    expect(second).toMatchObject({ ok: false, failure: { code: 'budget_exhausted' } })
    const retained = await database.query<{ count: string }>(`SELECT count(*) FROM gideon_memory.assertions WHERE scope_id = $1 AND current_status = 'accepted'`, [memorySession.scope.id])
    expect(retained.rows[0]?.count).toBe('1')

    const legacySession = session(`user/${run}-commands-legacy-capacity`)
    await store.provisionTrustedContext(legacySession)
    const legacyDurable = postgresSession(legacySession, store)
    await database.query(`UPDATE gideon_memory.quota_limits SET max_accepted_assertions = 401 WHERE scope_id = $1`, [legacySession.scope.id])
    for (let index = 0; index < 400; index += 1) {
      const legacy = await executeExplicitCommand(legacyDurable, {
        schemaVersion: 1,
        commandId: `command/${run}/legacy-${index}`,
        kind: 'remember',
        text: `Legacy accepted fact ${index}`,
        assertionKind: 'fact',
        conditions: [],
      }, { now: '2026-09-21T03:00:00.000Z' })
      expect(legacy.ok).toBe(true)
    }
    const newAfterLegacy = await executeExplicitCommand(legacyDurable, {
      schemaVersion: 1,
      commandId: `command/${run}/legacy-capacity-new`,
      kind: 'remember',
      text: 'New explicit preference after legacy capacity',
      assertionKind: 'preference',
      conditions: [],
    }, { now: '2026-09-21T03:01:00.000Z' })
    expect(newAfterLegacy).toMatchObject({ ok: true, receipt: { state: 'accepted' } })
    const durableCount = await database.query<{ count: string }>(`SELECT count(*) FROM gideon_memory.assertions WHERE scope_id = $1 AND current_status = 'accepted'`, [legacySession.scope.id])
    expect(durableCount.rows[0]?.count).toBe('401')

    const other = session(`user/${run}-commands-ambiguous`)
    await store.provisionTrustedContext(other)
    const otherDurable = postgresSession(other, store)
    for (const [index, text] of ['Laptop A is noisy', 'Laptop B is noisy'].entries()) {
      const remembered = await executeExplicitCommand(otherDurable, {
        schemaVersion: 1,
        commandId: `command/${run}/laptop-${index}`,
        kind: 'remember',
        text,
        assertionKind: 'fact',
        conditions: [],
      }, { now: `2026-09-21T03:0${index}:00.000Z` })
      expect(remembered).toMatchObject({ ok: true })
    }
    const resolved = await resolveExplicitTarget(otherDurable, 'noisy')
    expect(resolved).toMatchObject({ ok: false, failure: { code: 'ambiguous' } })
    if (!resolved.ok) expect(resolved.candidates).toHaveLength(2)
  })
})
