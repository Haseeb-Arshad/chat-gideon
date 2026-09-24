import { cpus, platform, release, totalmem } from 'node:os'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runMemoryMaintenance } from '../backend/memory/src/background'
import { DEFAULT_MEMORY_POOL_MAX } from '../backend/memory/src/config'
import { applyMigrations } from '../backend/memory/src/migrations'
import { collectMemoryMetrics } from '../backend/memory/src/operations'
import { PostgresMemoryStore } from '../backend/memory/src/postgres'
import { retrieveMemory } from '../backend/memory/src/retrieval'
import { composeContextPack, createRetrievalRequest, type RetrievalCoverage, type RetrievalDocument } from '../src/lib/memory/retrieval'
import { RULE_EXTRACTOR } from '../src/lib/memory/rule-extractor'
import { EphemeralMemoryStore } from '../src/lib/tools/memory'
import { createServerMemorySession } from '../src/server/memory-session'
import { createRecallInput, createRuntime } from '../src/server/node-memory-integration'

/**
 * Stage 14 bounded synthetic workload. Run through the disposable harness:
 *   npm run memory:postgres:load
 * Writes docs/memory/reports/stage-14-slo.json. Synthetic data only; the
 * numbers describe this machine and this workload, nothing more.
 */

const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)
const root = resolve(import.meta.dirname, '..')
const WORKLOAD = Object.freeze({
  concurrency: DEFAULT_MEMORY_POOL_MAX,
  poolMax: DEFAULT_MEMORY_POOL_MAX,
  corpora: { small: 20, medium: 150, large: 400 },
  usersPerCorpus: 6,
  capturesPerUser: 10,
  correctionsPerUser: 5,
  lookupsPerUser: 12,
  eventToReadySamples: 30,
  backlogUsers: 12,
  backlogTurnsPerUser: 150,
  packCompositionIterations: 400,
})

const TOPICS = ['gardening', 'cycling', 'jazz', 'pottery', 'chess', 'baking', 'hiking', 'astronomy', 'sailing', 'origami', 'climbing', 'violin']
const PEOPLE = ['My sister', 'My manager', 'My neighbour', 'My son', 'My doctor', 'My landlord', 'My cousin', 'My coach', 'My dentist', 'My teacher', 'My friend', 'My uncle']
const THINGS = ['birthday', 'favourite restaurant', 'car', 'phone number area', 'allergy', 'hometown', 'office floor', 'gym', 'bank branch', 'school', 'bakery', 'football club', 'laptop', 'dog', 'flat', 'airline']
const VALUES = ['Riverside', 'Lisbon', 'Pinewood', 'Aurora', 'Meridian', 'Solace', 'Canal Road', 'Faisalabad', 'Nimbus', 'Harbour', 'Juniper', 'Quartz', 'Saffron', 'Tamarind', 'Velvet', 'Willow', 'Zephyr']

/** Varied synthetic facts, so a lookup matches a few memories rather than every one. */
function syntheticFact(item: number): { text: string; query: string } {
  const person = PEOPLE[item % PEOPLE.length]!
  const thing = THINGS[Math.floor(item / PEOPLE.length) % THINGS.length]!
  const value = `${VALUES[item % VALUES.length]}${item}`
  return { text: `${person}'s ${thing} is ${value}`, query: `What is ${person.toLowerCase()}'s ${thing}?` }
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! * 10) / 10 : null)
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted.length ? Math.round(sorted.at(-1)! * 10) / 10 : null }
}

async function inParallel<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      await work(items[index]!, index)
    }
  }))
}

const describeLoad = enabled ? it : it.skip

let database: Pool
let store: PostgresMemoryStore

beforeAll(async () => {
  if (!enabled) return
  if (process.env.MEMORY_TEST_DATABASE_OWNED !== '1') throw new Error('The load workload requires an owned disposable database.')
  database = new Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL, max: WORKLOAD.poolMax, connectionTimeoutMillis: 5_000 })
  store = new PostgresMemoryStore(database)
  await database.query('DROP SCHEMA IF EXISTS gideon_memory CASCADE')
  await applyMigrations(database)
})

afterAll(async () => {
  if (enabled) await store.close()
})

describeLoad('bounded synthetic workload: latency percentiles, backlog behavior and extra prefill', async () => {
  const run = `load-${Date.now()}`
  const flags = { capture: true, commandWrites: true, recall: true }
  const samples: Record<string, number[]> = {}
  const record = (name: string, ms: number) => { (samples[name] ??= []).push(ms) }
  const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const started = performance.now()
    const result = await work()
    record(name, performance.now() - started)
    return result
  }
  const failures: string[] = []
  const packBytes: number[] = []
  const rebuildFailures: Record<string, number> = {}
  const deadlineMisses: string[] = []
  const tick = async (options: Parameters<typeof runMemoryMaintenance>[1]) => {
    const report = await runMemoryMaintenance(store, options)
    for (const [reason, count] of Object.entries(report.projections.failureReasons)) rebuildFailures[reason] = (rebuildFailures[reason] ?? 0) + count
    return report
  }

  type User = { owner: ReturnType<typeof createServerMemorySession> & { store: PostgresMemoryStore }; corpus: keyof typeof WORKLOAD.corpora; runtime: ReturnType<typeof createRuntime>; index: number }
  const users: User[] = []
  for (const corpus of Object.keys(WORKLOAD.corpora) as (keyof typeof WORKLOAD.corpora)[]) {
    for (let index = 0; index < WORKLOAD.usersPerCorpus; index += 1) {
      const memorySession = createServerMemorySession({ owner: `user/${run}-${corpus}-${index}`, store: new EphemeralMemoryStore(), channel: 'test', authority: 'worker_auth_session' })
      await store.provisionTrustedContext(memorySession)
      const owner = { ...memorySession, store }
      users.push({ owner, corpus, runtime: createRuntime(owner, flags), index: users.length })
    }
  }
  const signal = new AbortController().signal
  const toolContext = (user: User, id: string, text: string) => ({
    turnId: `turn-${run}-${id}`, callId: 'call-1', responseId: `response-${id}`, principalId: user.owner.principal.id, scopeId: user.owner.scope.id,
    policyEpoch: user.owner.policyEpoch, latestUserText: text, transcriptHash: 'x'.repeat(64), timezone: 'UTC', conversationState: null, speculative: false, signal,
  })

  // 1. Corpus construction through the explicit command path (remember under load).
  const seeds = users.flatMap((user) => Array.from({ length: WORKLOAD.corpora[user.corpus] }, (_, item) => ({ user, item })))
  await inParallel(seeds, WORKLOAD.concurrency, async ({ user, item }) => {
    const { text } = syntheticFact(item)
    const outcome = await timed(`remember_${user.corpus}`, () => user.runtime.execute('remember', { text, kind: item % 5 === 0 ? 'preference' : 'fact' }, toolContext(user, `seed-${user.index}-${item}`, text)))
    if (!outcome.ok) failures.push(`remember ${outcome.summary}`)
  })

  // What autovacuum does after a bulk load; without it the planner costs a fresh
  // corpus as empty and the first lookups time out (see the runbook).
  await database.query('ANALYZE')

  // 2. Capture of ordinary turns.
  const captures = users.flatMap((user) => Array.from({ length: WORKLOAD.capturesPerUser }, (_, turn) => ({ user, turn })))
  await inParallel(captures, WORKLOAD.concurrency, async ({ user, turn }) => {
    const text = `Today I mostly talked about ${TOPICS[turn % TOPICS.length]} and a trip plan number ${turn}.`
    const outcome = await timed('capture', () => user.runtime.captureUserTurn!({ ...toolContext(user, `capture-${user.index}-${turn}`, text), conversationId: `conversation/${run}/${user.index}` }, signal))
    if (outcome.status !== 'captured') failures.push(`capture ${outcome.status}`)
  })

  // 3. Edits (corrections of existing memories).
  const edits = users.flatMap((user) => Array.from({ length: WORKLOAD.correctionsPerUser }, (_, edit) => ({ user, edit })))
  await inParallel(edits, WORKLOAD.concurrency, async ({ user, edit }) => {
    const target = syntheticFact(edit).text
    const text = `${target.replace(/d+$/u, '')}${edit + 5000}`
    const outcome = await timed('edit', () => user.runtime.execute('correct', { query: target, text, change: 'changed' }, toolContext(user, `edit-${user.index}-${edit}`, text)))
    if (!outcome.ok) failures.push(`edit ${outcome.summary}`)
  })

  // 4. Lookups the way the app issues them: before any warm snapshot exists, and after every
  //    owner's snapshot was rebuilt. Snapshots carry a 5 s private lease, so by the time the
  //    second pass runs they have expired; it measures the app's real steady state.
  const lookups = users.flatMap((user) => Array.from({ length: WORKLOAD.lookupsPerUser }, (_, lookup) => ({ user, lookup })))
  const lookup = async (phase: 'cold' | 'after_rebuild') => inParallel(lookups, WORKLOAD.concurrency, async ({ user, lookup: index }) => {
    const query = syntheticFact((index * 7) % WORKLOAD.corpora[user.corpus]).query
    const result = await timed(`lookup_${phase}_${user.corpus}`, () => retrieveMemory(user.owner, createRecallInput(query, 'UTC', null, query)))
    // A pack the deadline cut off is the app's honest "memory unavailable": a latency miss, not an error.
    if (result.ok && result.pack?.status === 'unavailable') deadlineMisses.push(phase)
    else if (!result.ok || !result.pack) failures.push(`lookup ${result.ok ? 'missing' : result.failure.code}`)
    else packBytes.push(Buffer.byteLength(result.pack.text))
  })
  await lookup('cold')
  const projectionStarted = performance.now()
  for (let pass = 0; pass < 20; pass += 1) {
    const report = await tick({ workerId: `${run}-warm`, extractor: RULE_EXTRACTOR, learning: false, learningEnabledFor: () => false, limits: { projectionJobs: 200 } })
    if (report.queue.pendingProjection === 0) break
  }
  const projectionMs = performance.now() - projectionStarted
  await lookup('after_rebuild')

  // Worst case, reported separately: a query whose words appear in every memory of a large corpus.
  const large = users.filter((user) => user.corpus === 'large')
  await inParallel(large.flatMap((user) => Array.from({ length: 6 }, () => user)), WORKLOAD.concurrency, async (user) => {
    const query = "What is my sister's, my manager's and my neighbour's birthday, car and gym?"
    const result = await timed('lookup_every_memory_matches_large', () => retrieveMemory(user.owner, createRecallInput(query, 'UTC', null, query)))
    if (!result.ok || result.pack.status === 'unavailable') record('lookup_every_memory_matches_large_unavailable', 1)
  })

  // Learning left over from the captures above is drained first, so event-to-ready is one turn's own path.
  for (let pass = 0; pass < 100; pass += 1) {
    const report = await tick({ workerId: `${run}-predrain`, extractor: RULE_EXTRACTOR, learning: true, learningEnabledFor: () => true, settleMs: 0, limits: { learningJobs: 100, learningJobsPerScope: 20, projectionJobs: 200 } })
    if (report.queue.pendingInterpret === 0 && report.queue.pendingProjection === 0) break
  }

  // 5. Event to ready: a turn becomes a retrievable learned memory (processing only; the
  //    configured settle delay and background interval are added on top in production).
  for (let sample = 0; sample < WORKLOAD.eventToReadySamples; sample += 1) {
    const user = users[sample % users.length]!
    const hobby = `kitesurfing${sample}x`
    const text = `I really enjoy ${hobby} on weekends.`
    const started = performance.now()
    await user.runtime.captureUserTurn!({ ...toolContext(user, `ready-${sample}`, text), conversationId: `conversation/${run}/ready-${sample}` }, signal)
    await tick({ workerId: `${run}-ready`, extractor: RULE_EXTRACTOR, learning: true, learningEnabledFor: () => true, settleMs: 0, scopeId: user.owner.scope.id as never, limits: { learningJobs: 50, learningJobsPerScope: 50 } })
    const found = await retrieveMemory(user.owner, createRecallInput(`Do I enjoy ${hobby}?`, 'UTC', null, `Do I enjoy ${hobby}?`))
    record('event_to_ready', performance.now() - started)
    if (!found.ok || !found.pack.text.includes(hobby)) failures.push(`event_to_ready miss ${sample}`)
  }

  // 6. The same operations while a large learning backlog is queued.
  const backlogUsers: User[] = []
  for (let index = 0; index < WORKLOAD.backlogUsers; index += 1) {
    const memorySession = createServerMemorySession({ owner: `user/${run}-backlog-${index}`, store: new EphemeralMemoryStore(), channel: 'test', authority: 'worker_auth_session' })
    await store.provisionTrustedContext(memorySession)
    const owner = { ...memorySession, store }
    backlogUsers.push({ owner, corpus: 'small', runtime: createRuntime(owner, flags), index: 1000 + index })
  }
  const backlog = backlogUsers.flatMap((user) => Array.from({ length: WORKLOAD.backlogTurnsPerUser }, (_, turn) => ({ user, turn })))
  await inParallel(backlog, WORKLOAD.concurrency, async ({ user, turn }) => {
    const text = `Backlog turn ${turn}: thinking about ${TOPICS[turn % TOPICS.length]}.`
    await user.runtime.captureUserTurn!({ ...toolContext(user, `backlog-${user.index}-${turn}`, text), conversationId: `conversation/${run}/backlog-${user.index}` }, signal)
  })
  const queued = await collectMemoryMetrics(database)
  const underBacklog = users.slice(0, 12)
  await inParallel(underBacklog.flatMap((user) => Array.from({ length: 8 }, (_, index) => ({ user, index }))), WORKLOAD.concurrency, async ({ user, index }) => {
    const query = syntheticFact(index * 3).query
    await timed('lookup_under_backlog', () => retrieveMemory(user.owner, createRecallInput(query, 'UTC', null, query)))
    const text = `Backlog-time fact ${index}: my favourite ${TOPICS[(index + 3) % TOPICS.length]} spot is number ${index}`
    await timed('remember_under_backlog', () => user.runtime.execute('remember', { text, kind: 'fact' }, toolContext(user, `under-${user.index}-${index}`, text)))
    await timed('capture_under_backlog', () => user.runtime.captureUserTurn!({ ...toolContext(user, `under-capture-${user.index}-${index}`, text), conversationId: `conversation/${run}/under-${user.index}` }, signal))
  })
  const drainStarted = performance.now()
  let drained = 0
  for (let pass = 0; pass < 400; pass += 1) {
    const report = await tick({ workerId: `${run}-drain`, extractor: RULE_EXTRACTOR, learning: true, learningEnabledFor: () => true, settleMs: 0, limits: { learningJobs: 50, learningJobsPerScope: 10 } })
    drained += report.learning.processed + report.learning.skipped
    if (report.queue.pendingInterpret === 0) break
  }
  const drainMs = performance.now() - drainStarted

  // 7. Pack composition alone (CPU), with a realistic candidate set.
  const session = users[0]!.owner
  const parsed = createRetrievalRequest(session, createRecallInput('What do I like to do on weekends?', 'UTC', null, 'What do I like to do on weekends?'))
  if (!parsed.ok) throw new Error(parsed.failure.message)
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    document: {
      id: `doc-${index}`, scopeId: session.scope.id, reference: { assertionId: `assertion/command/${String(index).padStart(40, '0')}`, revision: 1 }, sourceKind: 'assertion',
      kind: index % 4 === 0 ? 'preference' : 'fact', text: `Synthetic remembered statement number ${index} about ${TOPICS[index % TOPICS.length]} and weekends`, status: 'accepted', polarity: 'positive',
      subjectId: null, topicId: null, topicLabel: null, projectId: null, artifactIds: [], slotId: null, conflictGroupId: null, conditions: [], exceptions: [], validFrom: null, validUntil: null,
      temporalRelation: 'ordinary', historical: false, interpretedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), basis: 'explicit_user_statement',
      evidence: [{ eventId: `event/${index}`, relation: 'supports', sourceRef: `source/${index}` }], sourceEventId: null, requiresCurrentVerification: false,
    } as unknown as RetrievalDocument,
    fusedScore: 1 / (index + 1), branches: ['lexical'], reasons: ['load'],
  }))
  const coverage = { outcome: 'complete', branches: {}, candidateCount: 40, filteredCandidateCount: 0, freshness: { state: 'authoritative' } } as unknown as RetrievalCoverage
  for (let iteration = 0; iteration < WORKLOAD.packCompositionIterations; iteration += 1) {
    const started = performance.now()
    composeContextPack({ request: parsed.request, coverage, candidates: candidates as never, constraints: [] })
    record('pack_composition', performance.now() - started)
  }

  const version = await database.query<{ version: string }>('SHOW server_version')
  const finalMetrics = await collectMemoryMetrics(database)
  const dead = await database.query<{ kind: string; code: string | null; count: string }>(
    `SELECT kind, last_failure_code AS code, count(*) AS count FROM gideon_memory.jobs WHERE state = 'dead' GROUP BY 1, 2 ORDER BY 3 DESC`,
  )
  const report = {
    stage: 14,
    label: 'bounded synthetic workload on one local machine; not a production capacity claim',
    generatedAt: new Date().toISOString(),
    environment: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model ?? 'unknown', memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version, postgres: version.rows[0]?.version, database: 'disposable local cluster, default settings' },
    workload: { ...WORKLOAD, users: users.length, seededMemories: seeds.length },
    latencyMs: Object.fromEntries(Object.entries(samples).sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => [name, percentiles(values)])),
    warmSnapshotRebuildMs: Math.round(projectionMs),
    backlog: { queuedInterpretations: queued.interpret.pending, uninterpretedTurns: queued.uninterpretedTurns24h, drainedJobs: drained, drainMs: Math.round(drainMs), jobsPerSecond: Math.round((drained / Math.max(drainMs, 1)) * 1000 * 10) / 10 },
    extraPrefill: { packBytes: percentiles(packBytes), estimatedTokensMean: Math.round(packBytes.reduce((sum, value) => sum + value, 0) / Math.max(packBytes.length, 1) / 4) },
    failures: { count: failures.length, sample: failures.slice(0, 10) },
    recallDeadlineMisses: { count: deadlineMisses.length, of: lookups.length * 2, rate: Math.round((deadlineMisses.length / (lookups.length * 2)) * 10_000) / 10_000, deadlineMs: 1_500 },
    finalQueue: {
      interpretPending: finalMetrics.interpret.pending,
      dead: finalMetrics.interpret.dead + finalMetrics.projection.dead,
      rebuildFailureReasons: rebuildFailures,
      deadByKindAndReason: dead.rows.map((row) => ({ kind: row.kind, reason: row.code, count: Number(row.count) })),
      lostAcceptedCommands24h: finalMetrics.lostAcceptedCommands24h,
    },
    notMeasured: { firstSubstantiveAudio: 'needs the realtime voice provider and a real client; not measured locally', cacheRenewalTraffic: 'no provider prompt cache is used by the memory path' },
  }
  writeFileSync(resolve(root, 'docs/memory/reports/stage-14-slo.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ latencyMs: report.latencyMs, backlog: report.backlog, extraPrefill: report.extraPrefill, failures: report.failures }, null, 1))
  expect(failures).toEqual([])
  expect(finalMetrics.lostAcceptedCommands24h).toBe(0)
}, 1_800_000)
