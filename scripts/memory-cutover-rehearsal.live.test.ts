import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { closeWriterLocks, CutoverFenceError, legacyCompatibilityView, readAuthority } from '../backend/memory/src/cutover'
import { executeExplicitCommand } from '../backend/memory/src/commands'
import { executeForgetCommand } from '../backend/memory/src/deletion'
import { applyMigrations } from '../backend/memory/src/migrations'
import { collectMemoryMetrics, evaluateMemoryAlerts } from '../backend/memory/src/operations'
import { PostgresMemoryStore } from '../backend/memory/src/postgres'
import { retrieveMemory } from '../backend/memory/src/retrieval'
import { rank, type Memory } from '../src/lib/tools/memory'
import { createServerMemorySession } from '../src/server/memory-session'
import { executeLegacyMigration, planLegacyMigration, rollbackLegacyOwner } from '../src/server/memory-migration'
import { createRecallInput, FencedLegacyStore } from '../src/server/node-memory-integration'
import { uncachedLegacyStore } from '../src/server/identity'

/**
 * Stage 15 local cutover rehearsal on a disposable PostgreSQL:
 *   node scripts/memory-postgres-harness.mjs scripts/memory-cutover-rehearsal.live.test.ts
 * Synthetic owners only. Writes docs/memory/reports/stage-15-rehearsal.json
 * and the (path-redacted) manifest it executed.
 */

const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)
const root = resolve(import.meta.dirname, '..')
const PEOPLE = ['sister', 'manager', 'neighbour', 'dentist', 'landlord', 'coach', 'cousin', 'teacher']
const THINGS = ['birthday', 'car', 'favourite cafe', 'hometown', 'gym', 'dog', 'bakery', 'football club']

function ownerId(index: number): string {
  return `node/${index.toString(16).padStart(4, '0').repeat(16)}`
}

function legacyFor(owner: number, count: number): Memory[] {
  return Array.from({ length: count }, (_, item) => {
    const stamp = new Date(Date.UTC(2025, owner % 12, 1 + (item % 28))).toISOString()
    const person = PEOPLE[item % PEOPLE.length]!
    const thing = THINGS[Math.floor(item / PEOPLE.length) % THINGS.length]!
    return { id: `m${owner}-${item}`, kind: item % 4 === 0 ? 'preference' : 'fact', text: `My ${person}'s ${thing} is canary${owner}x${item}`, createdAt: stamp, usedAt: stamp, uses: item % 3 }
  })
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! * 10) / 10
}

const describeRehearsal = enabled ? it : it.skip
let database: Pool
let store: PostgresMemoryStore
let directory: string

beforeAll(async () => {
  if (!enabled) return
  if (process.env.MEMORY_TEST_DATABASE_OWNED !== '1') throw new Error('The rehearsal requires an owned disposable database.')
  database = new Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL, max: 8 })
  store = new PostgresMemoryStore(database)
  await database.query('DROP SCHEMA IF EXISTS gideon_memory CASCADE')
  await applyMigrations(database)
  directory = mkdtempSync(join(tmpdir(), 'gideon-rehearsal-'))
})

afterAll(async () => {
  if (!enabled) return
  await closeWriterLocks(store)
  await store.close()
  rmSync(directory, { recursive: true, force: true })
})

describeRehearsal('local cutover rehearsal: plan, shadow, cohort cutover, stop conditions and rollback', async () => {
  const sizes = [0, 1, 3, 8, 15, 20, 25, 30, 40, 50, 55, 60]
  const cohort = sizes.map((size, index) => ({ owner: ownerId(index + 1), memories: legacyFor(index + 1, size) }))
  for (const member of cohort) writeFileSync(join(directory, `${member.owner.slice(5)}.json`), JSON.stringify(member.memories, null, 2))
  // Two owners carry malformed rows; one stray file has no owner key.
  const malformedOwner = cohort[5]!
  writeFileSync(join(directory, `${malformedOwner.owner.slice(5)}.json`), JSON.stringify([...malformedOwner.memories, { id: 'broken-1', kind: 'fact', text: '' }, { id: 'broken-2', kind: 'mystery', text: 'unknown kind', createdAt: '2025-01-01T00:00:00.000Z' }], null, 2))
  writeFileSync(join(directory, 'notes-backup.json'), '[]')
  const env = { ...process.env }
  process.env.GIDEON_MEMORY_DIR = directory

  // 1. Dry-run manifest: nothing is written.
  const manifest = await planLegacyMigration({ directory, environment: 'local-rehearsal' })
  expect(manifest.owners).toHaveLength(12)
  expect(manifest.unrecognizedFiles).toEqual(['notes-backup.json'])
  expect(manifest.owners.find((item) => item.owner === malformedOwner.owner)!.quarantined).toEqual([{ reason: 'empty_text', count: 1 }, { reason: 'unknown_kind', count: 1 }])
  expect((await database.query('SELECT count(*)::int AS count FROM gideon_memory.assertions')).rows[0]).toEqual({ count: 0 })

  // 2. Shadow: import into an isolated database and compare recall with the legacy ranking.
  const shadowName = `shadow_${Date.now()}`
  await database.query(`CREATE DATABASE ${shadowName}`)
  const shadowUrl = new URL(process.env.MEMORY_TEST_DATABASE_URL!)
  shadowUrl.pathname = `/${shadowName}`
  const shadowPool = new Pool({ connectionString: shadowUrl.toString(), max: 8 })
  const shadowStore = new PostgresMemoryStore(shadowPool)
  const shadow = { legacyHits: 0, newHits: 0, samples: 0, legacyMs: [] as number[], newMs: [] as number[] }
  try {
    await applyMigrations(shadowPool)
    const shadowResults = await executeLegacyMigration(manifest, shadowStore)
    expect(shadowResults.every((result) => result.outcome === 'activated')).toBe(true)
    for (const member of cohort) {
      const session = { ...createServerMemorySession({ owner: member.owner, store: shadowStore, channel: 'worker_http', authority: 'worker_internal_owner' }), store: shadowStore }
      for (const memory of member.memories.filter((_, index) => index % 5 === 0)) {
        const [, person, thing] = /^My (\w+)'s (.+) is /u.exec(memory.text)!
        const query = `What is my ${person}'s ${thing}?`
        shadow.samples += 1
        let started = performance.now()
        const legacyTop = rank(member.memories, query).slice(0, 4).map((hit) => hit.memory.text)
        shadow.legacyMs.push(performance.now() - started)
        if (legacyTop.includes(memory.text)) shadow.legacyHits += 1
        started = performance.now()
        const result = await retrieveMemory(session, { ...createRecallInput(query, 'UTC', null, query), deadlineAt: new Date(Date.now() + 15_000).toISOString() })
        shadow.newMs.push(performance.now() - started)
        if (result.ok && result.pack.text.includes(memory.text)) shadow.newHits += 1
      }
    }
    // The live database was untouched by the shadow run.
    expect((await database.query('SELECT count(*)::int AS count FROM gideon_memory.authority_cutovers')).rows[0]).toEqual({ count: 0 })
  } finally {
    await closeWriterLocks(shadowStore)
    await shadowStore.close()
    await database.query(`DROP DATABASE IF EXISTS ${shadowName} WITH (FORCE)`)
  }

  // 3. Cohort cutover. One owner's file changes after planning and is refused until re-planned.
  const drifting = cohort[9]!
  writeFileSync(join(directory, `${drifting.owner.slice(5)}.json`), JSON.stringify([...drifting.memories, legacyFor(99, 1)[0]!], null, 2))
  const first = await executeLegacyMigration(manifest, store)
  expect(first.find((result) => result.owner === drifting.owner)).toMatchObject({ outcome: 'changed_since_plan' })
  expect((await readAuthority(store, drifting.owner)).state).toBe('legacy')
  const replanned = await planLegacyMigration({ directory, environment: 'local-rehearsal' })
  const second = await executeLegacyMigration(replanned, store, { owners: [drifting.owner] })
  const results = [...first.filter((result) => result.owner !== drifting.owner), ...second]
  expect(results.every((result) => result.outcome === 'activated')).toBe(true)

  // Stop conditions.
  const stop = { falseReceipts: 0, unauthorizedDisclosure: 0, lostWrites: 0, resurrections: 0, countMismatches: 0 }
  for (const member of cohort) {
    const session = { ...createServerMemorySession({ owner: member.owner, store, channel: 'worker_http', authority: 'worker_internal_owner' }), store }
    const view = await legacyCompatibilityView(session)
    const expected = member.owner === drifting.owner ? member.memories.length + 1 : member.memories.length
    if (view.length !== expected) stop.countMismatches += 1
    // Canary: every text in this owner's view carries this owner's own tag.
    const tag = `canary${cohort.indexOf(member) + 1}x`
    stop.unauthorizedDisclosure += view.filter((memory) => !memory.text.includes(tag) && !(member.owner === drifting.owner && memory.text.includes('canary99x'))).length
    // A write through the old store after cutover must be refused, not acknowledged and lost.
    const fenced = new FencedLegacyStore(uncachedLegacyStore(member.owner), session)
    const before = readFileSync(join(directory, `${member.owner.slice(5)}.json`), 'utf8')
    try {
      await fenced.mutate((memories) => ({ memories: [...memories, { ...legacyFor(1, 1)[0]!, id: 'late', text: 'A late legacy write' }], result: null }))
      stop.falseReceipts += 1
    } catch (error) {
      if (!(error instanceof CutoverFenceError)) throw error
    }
    if (readFileSync(join(directory, `${member.owner.slice(5)}.json`), 'utf8') !== before) stop.lostWrites += 1
  }

  // 4. Rollback drill after a correction and a forget on two owners, then a repeated migration run.
  const drillOwners = [cohort[4]!, cohort[7]!]
  const drill: { owner: string; projected: number; forgottenBack: boolean; correctedKept: boolean }[] = []
  const forgottenText = new Map<string, string>()
  for (const member of drillOwners) {
    const session = { ...createServerMemorySession({ owner: member.owner, store, channel: 'worker_http', authority: 'worker_internal_owner' }), store }
    const rows = await database.query<{ assertion_id: string; text: string }>(
      `SELECT a.assertion_id, v.version #>> '{payload,proposition,text}' AS text FROM gideon_memory.assertions a JOIN gideon_memory.assertion_versions v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision WHERE a.scope_id = $1 AND v.version #>> '{payload,kind}' = 'fact' ORDER BY a.assertion_id LIMIT 2`,
      [member.owner],
    )
    const [toForget, toCorrect] = rows.rows
    forgottenText.set(member.owner, toForget!.text)
    expect(await executeForgetCommand(session, { schemaVersion: 1, commandId: `command/rehearsal/forget/${member.owner}`, kind: 'forget', targetAssertionId: toForget!.assertion_id, targetRevision: 1, query: null })).toMatchObject({ ok: true })
    expect(await executeExplicitCommand(session, { schemaVersion: 1, commandId: `command/rehearsal/fix/${member.owner}`, kind: 'correct', targetAssertionId: toCorrect!.assertion_id, targetRevision: 1, text: `${toCorrect!.text} (corrected)`, assertionKind: 'fact', conditions: [] })).toMatchObject({ ok: true })
    const rolled = await rollbackLegacyOwner(member.owner, store, directory)
    const file = JSON.parse(readFileSync(join(directory, `${member.owner.slice(5)}.json`), 'utf8')) as Memory[]
    drill.push({ owner: member.owner, projected: rolled.projected, forgottenBack: file.some((memory) => memory.text === toForget!.text), correctedKept: file.some((memory) => memory.text === `${toCorrect!.text} (corrected)`) })
  }
  // Running the whole reviewed migration again (as an operator retry would) changes nothing and resurrects nothing.
  const retry = await executeLegacyMigration(await planLegacyMigration({ directory, environment: 'local-rehearsal' }), store)
  for (const member of drillOwners) {
    const session = { ...createServerMemorySession({ owner: member.owner, store, channel: 'worker_http', authority: 'worker_internal_owner' }), store }
    const texts = (await legacyCompatibilityView(session)).map((memory) => memory.text)
    if (drill.find((item) => item.owner === member.owner)!.forgottenBack) stop.resurrections += 1
    if (texts.includes(forgottenText.get(member.owner)!)) stop.resurrections += 1
  }
  const metrics = await collectMemoryMetrics(database)
  const alerts = evaluateMemoryAlerts(metrics)

  const report = {
    stage: 15,
    label: 'local rehearsal with synthetic owners on a disposable database; not a staging or production migration',
    generatedAt: new Date().toISOString(),
    cohort: { owners: cohort.length, memories: cohort.reduce((sum, member) => sum + member.memories.length, 0), malformedRows: 2, unrecognizedFiles: manifest.unrecognizedFiles.length },
    shadow: {
      samples: shadow.samples,
      legacyRecallCoverage: Math.round((shadow.legacyHits / shadow.samples) * 1000) / 1000,
      newRecallCoverage: Math.round((shadow.newHits / shadow.samples) * 1000) / 1000,
      legacyLookupMs: { p50: percentile(shadow.legacyMs, 50), p95: percentile(shadow.legacyMs, 95) },
      newLookupMs: { p50: percentile(shadow.newMs, 50), p95: percentile(shadow.newMs, 95) },
      isolation: 'separate database; live database had no cutover rows after the shadow run',
    },
    cutover: {
      results: results.map(({ owner, ...rest }) => ({ owner: `${owner.slice(0, 13)}…`, ...rest })),
      refusedBecauseChangedSincePlan: 1,
      retryOutcomes: [...new Set(retry.map((result) => result.outcome))],
    },
    stopConditions: { ...stop, deadJobs: metrics.interpret.dead + metrics.projection.dead, jobsCancelledByDeletion: metrics.interpret.revokedByDeletion + metrics.projection.revokedByDeletion, lostAcceptedCommands24h: metrics.lostAcceptedCommands24h, criticalAlerts: alerts.filter((alert) => alert.severity === 'critical').map((alert) => alert.name) },
    rollbackDrill: drill.map(({ owner, ...rest }) => ({ owner: `${owner.slice(0, 13)}…`, ...rest })),
  }
  writeFileSync(resolve(root, 'docs/memory/reports/stage-15-rehearsal.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(resolve(root, 'docs/memory/reports/stage-15-local-manifest.json'), `${JSON.stringify({ ...manifest, source: { ...manifest.source, directory: '<disposable rehearsal directory>' } }, null, 2)}\n`)
  process.env.GIDEON_MEMORY_DIR = env.GIDEON_MEMORY_DIR
  if (env.GIDEON_MEMORY_DIR === undefined) delete process.env.GIDEON_MEMORY_DIR
  console.log(JSON.stringify({ shadow: report.shadow, stop: report.stopConditions, drill: report.rollbackDrill, retry: report.cutover.retryOutcomes }, null, 1))

  expect(stop).toEqual({ falseReceipts: 0, unauthorizedDisclosure: 0, lostWrites: 0, resurrections: 0, countMismatches: 0 })
  expect(drill.every((item) => !item.forgottenBack && item.correctedKept)).toBe(true)
  expect(report.stopConditions.criticalAlerts).toEqual([])
  expect(report.shadow.newRecallCoverage).toBeGreaterThanOrEqual(report.shadow.legacyRecallCoverage)
}, 600_000)
