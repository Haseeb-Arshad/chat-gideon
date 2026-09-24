import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Memory, MemoryStore } from '../../../src/lib/tools/memory.ts'
import { runServerTool } from '../../../src/lib/tools/registry.ts'
import { ensureNodeAccount, legacyMemoryFile, uncachedLegacyStore } from '../../../src/server/identity.ts'
import { createServerMemorySession } from '../../../src/server/memory-session.ts'
import { FencedLegacyStore, legacySourceFor, resolveNodeMemoryForTurn } from '../../../src/server/node-memory-integration.ts'
import { executeExplicitCommand } from './commands.ts'
import {
  closeWriterLocks,
  CutoverConflictError,
  CutoverFenceError,
  cutoverScope,
  importLegacyMemories,
  legacyCompatibilityView,
  parseLegacyMemories,
  readAuthority,
  rollbackScope,
} from './cutover.ts'
import { executeForgetCommand } from './deletion.ts'
import { applyMigrations } from './migrations.ts'
import { PostgresMemoryStore } from './postgres.ts'
import { retrieveMemory } from './retrieval.ts'

/**
 * Stage 15 cutover rehearsal on real PostgreSQL with synthetic legacy files.
 * Seed cases: C19 (a correction wins over any older copy), C20 (two devices),
 * C21 (duplicate import), C22 (deletion survives rollback and re-cutover),
 * C26 (the legacy array is a projection, never an independent writer).
 * C23-C25 are covered by the Stage 05/14 suites (restore replay, isolation,
 * outage); see the handoff.
 */

const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)
const run = `cutover-${Date.now()}`

function legacyRecord(index: number, text = `Legacy fact number ${index} about the ${['garden', 'car', 'dentist', 'bakery'][index % 4]}`): Memory {
  const stamp = new Date(Date.UTC(2026, 0, 1 + index)).toISOString()
  return { id: `legacy-${index}`, kind: index % 3 === 0 ? 'preference' : index % 5 === 0 ? 'plan' : 'fact', text, createdAt: stamp, usedAt: stamp, uses: index % 4 }
}

describe.skipIf(!enabled)('Stage 15 single-writer cutover', () => {
  const database = new Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL, max: 10, connectionTimeoutMillis: 3_000 })
  const store = new PostgresMemoryStore(database)
  const directory = mkdtempSync(join(tmpdir(), 'gideon-cutover-'))
  let counter = 0
  const saved = { ...process.env }

  beforeAll(async () => {
    if (process.env.MEMORY_TEST_DATABASE_OWNED !== '1') throw new Error('The cutover rehearsal requires an owned disposable database.')
    await database.query('DROP SCHEMA IF EXISTS gideon_memory CASCADE')
    await applyMigrations(database)
    process.env.GIDEON_MEMORY_DIR = directory
  })

  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await closeWriterLocks(store)
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  /** A signed-owner-shaped id with its own legacy file. */
  function owner(tag: string, legacy: unknown) {
    const id = `node/${createHashHex(`${run}-${tag}`)}`
    writeFileSync(legacyMemoryFile(id), JSON.stringify(legacy, null, 2))
    const session = { ...createServerMemorySession({ owner: id, store, channel: 'test', authority: 'worker_auth_session' }), store }
    return { id, session, legacy: legacySourceFor(id) }
  }

  function createHashHex(value: string): string {
    // 64 hex characters, as the signed cookie produces.
    return Buffer.from(value.padEnd(32, '#').slice(0, 32)).toString('hex')
  }

  const readFile = (id: string) => JSON.parse(readFileSync(legacyMemoryFile(id), 'utf8')) as Memory[]

  it('quarantines malformed legacy rows with a reason instead of dropping them', () => {
    const parsed = parseLegacyMemories([
      legacyRecord(1),
      { id: 'no-text', kind: 'fact', text: '   ', createdAt: '2026-01-01T00:00:00.000Z', usedAt: '2026-01-01T00:00:00.000Z', uses: 0 },
      { kind: 'fact', text: 'no id', createdAt: '2026-01-01T00:00:00.000Z' },
      { ...legacyRecord(1), text: 'same id twice' },
      { ...legacyRecord(2), kind: 'secret' },
      { ...legacyRecord(3), createdAt: 'yesterday' },
      { ...legacyRecord(4), text: 'x'.repeat(241) },
      'a bare string',
    ])
    expect(parsed.valid.map((memory) => memory.id)).toEqual(['legacy-1'])
    expect(parsed.quarantined.map((row) => row.reason)).toEqual(['empty_text', 'missing_id', 'duplicate_id', 'unknown_kind', 'invalid_created_at', 'text_too_long', 'not_an_object'])
    expect(parseLegacyMemories({ not: 'an array' }).quarantined).toEqual([{ index: -1, id: null, reason: 'not_an_array' }])
  })

  it('cuts one owner over: every valid row imported with its id and text, malformed rows reported, legacy becomes a projection', async () => {
    const records = Array.from({ length: 30 }, (_, index) => legacyRecord(index))
    const subject = owner('main', [...records, { id: 'bad', kind: 'fact', text: '' }])
    const report = await cutoverScope(subject.session, subject.legacy)
    expect(report).toMatchObject({ outcome: 'activated', expected: 30, verification: { checked: 30, matching: 30, mismatched: [], missing: [] } })
    expect(report.quarantined).toEqual([{ index: 30, id: 'bad', reason: 'empty_text' }])
    expect(report.imports[0]!.counts).toMatchObject({ imported: 30, failed: 0 })
    expect(await readAuthority(store, subject.session.scope.id)).toMatchObject({ state: 'active', legacyRevision: report.legacyRevision })

    // Provenance: imported, not an invented conversation.
    const bases = await database.query<{ basis: string; producer: string }>(
      `SELECT DISTINCT v.version #>> '{attribution,basis}' AS basis, v.version #>> '{producer,name}' AS producer FROM gideon_memory.assertion_versions v WHERE v.scope_id = $1`,
      [subject.session.scope.id],
    )
    expect(bases.rows).toEqual([{ basis: 'imported_legacy', producer: 'memory-import' }])

    // The compatibility view carries the legacy ids, text and creation times.
    const view = await legacyCompatibilityView(subject.session)
    expect(view.map((memory) => memory.id).sort()).toEqual(records.map((memory) => memory.id).sort())
    for (const record of records) expect(view.find((memory) => memory.id === record.id)).toMatchObject({ text: record.text, createdAt: record.createdAt })

    // Sampled current read through the new authority.
    const found = await retrieveMemory(subject.session, {
      query: 'dentist', resolved: { topicId: null, topicLabel: null, entities: [], assertionIds: [], artifactIds: [], unknownReferents: [] },
      activity: { kind: null, topicId: null, topicLabel: null, projectId: null, format: null, attributes: {} },
      requestedTime: { mode: 'current', instant: null, timeZone: 'UTC' }, consistency: 'authoritative',
      budget: { tier: 'maximum', reserveAnswerTokens: 0, reserveToolTokens: 0 }, deadlineAt: new Date(Date.now() + 15_000).toISOString(),
    })
    expect(found.ok && found.pack.text).toContain('Legacy fact number 2 about the dentist')

    // Duplicate import (C21): the same rows again change nothing.
    expect(await cutoverScope(subject.session, subject.legacy)).toMatchObject({ outcome: 'already_active' })
    const again = await importLegacyMemories(subject.session, records, { importId: 'import/legacy/repeat' })
    expect(again.counts).toMatchObject({ imported: 0, already_imported: 30 })
    const count = await database.query(`SELECT count(*)::int AS count FROM gideon_memory.assertions WHERE scope_id = $1`, [subject.session.scope.id])
    expect(count.rows[0]).toEqual({ count: 30 })
  })

  it('refuses every write while fenced, lets an in-flight legacy write finish first, and imports it', async () => {
    const subject = owner('fence', [legacyRecord(1), legacyRecord(2)])
    const slowSave = { release: () => undefined as void }
    const disk: MemoryStore = {
      all: () => subject.legacy.read() as Promise<Memory[]>,
      save: async () => undefined,
      mutate: async (change) => {
        const current = await subject.legacy.read() as Memory[]
        const { memories, result } = change(current)
        await new Promise<void>((resolve) => { slowSave.release = resolve })
        await subject.legacy.write(memories)
        return result
      },
    }
    const legacyStore = new FencedLegacyStore(disk, subject.session)
    // A legacy write begins before the fence and is still writing when the cutover starts.
    const inFlight = legacyStore.mutate((memories) => ({ memories: [...memories, legacyRecord(3, 'Written while the cutover waited')], result: 'ok' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const cutover = cutoverScope(subject.session, subject.legacy)
    await new Promise((resolve) => setTimeout(resolve, 200))
    // The fence is waiting for the in-flight write; nothing is fenced yet.
    expect((await readAuthority(store, subject.session.scope.id)).state).toBe('legacy')
    slowSave.release()
    expect(await inFlight).toBe('ok')
    const report = await cutover
    expect(report).toMatchObject({ outcome: 'activated', expected: 3 })
    expect((await legacyCompatibilityView(subject.session)).map((memory) => memory.text)).toContain('Written while the cutover waited')
    // After activation the legacy store is read-only and serves the projection.
    await expect(legacyStore.mutate((memories) => ({ memories, result: null }))).rejects.toBeInstanceOf(CutoverFenceError)
    expect((await legacyStore.all()).map((memory) => memory.id).sort()).toEqual(['legacy-1', 'legacy-2', 'legacy-3'])
  })

  it('lets only one of two racing operators move an owner', async () => {
    const subject = owner('race', [legacyRecord(1)])
    const results = await Promise.allSettled([cutoverScope(subject.session, subject.legacy), cutoverScope(subject.session, subject.legacy)])
    const activated = results.filter((result) => result.status === 'fulfilled' && result.value.outcome === 'activated')
    expect(activated).toHaveLength(1)
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(CutoverConflictError)
      else expect(['activated', 'already_active']).toContain(result.value.outcome)
    }
    expect((await readAuthority(store, subject.session.scope.id)).state).toBe('active')
  })

  it('rolls back after a correction and a forget without restoring the old file, and a re-cutover does not resurrect', async () => {
    const records = [legacyRecord(1, 'My locker code is 4471'), legacyRecord(2, 'My office is on floor 3'), legacyRecord(3, 'I like jasmine tea')]
    const subject = owner('rollback', records)
    expect(await cutoverScope(subject.session, subject.legacy)).toMatchObject({ outcome: 'activated' })
    const view = await legacyCompatibilityView(subject.session)
    const assertions = await database.query<{ assertion_id: string; text: string }>(
      `SELECT a.assertion_id, v.version #>> '{payload,proposition,text}' AS text FROM gideon_memory.assertions a JOIN gideon_memory.assertion_versions v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision WHERE a.scope_id = $1`,
      [subject.session.scope.id],
    )
    const idOf = (text: string) => assertions.rows.find((row) => row.text === text)!.assertion_id
    expect(view).toHaveLength(3)

    // After cutover the user corrects one memory and forgets another in the new authority.
    const corrected = await executeExplicitCommand(subject.session, { schemaVersion: 1, commandId: `command/${run}/fix`, kind: 'correct', targetAssertionId: idOf('My office is on floor 3'), targetRevision: 1, text: 'My office is on floor 7', assertionKind: 'fact', conditions: [] })
    expect(corrected).toMatchObject({ ok: true })
    const forgotten = await executeForgetCommand(subject.session, { schemaVersion: 1, commandId: `command/${run}/forget`, kind: 'forget', targetAssertionId: idOf('My locker code is 4471'), targetRevision: 1, query: null })
    expect(forgotten).toMatchObject({ ok: true })

    // Rollback: the file is rewritten from the current projection, never the pre-cutover copy.
    const rolled = await rollbackScope(subject.session, subject.legacy)
    expect(rolled.projected).toBe(2)
    const file = readFile(subject.id)
    expect(file.map((memory) => memory.text).sort()).toEqual(['I like jasmine tea', 'My office is on floor 7'])
    expect(JSON.stringify(file)).not.toContain('4471')
    expect(JSON.stringify(file)).not.toContain('floor 3')
    expect((await readAuthority(store, subject.session.scope.id)).state).toBe('rolled_back')

    // The legacy file is the writer again: a legacy remember lands in it.
    const legacyStore = new FencedLegacyStore(uncachedLegacyStore(subject.id), subject.session)
    await legacyStore.mutate((memories) => ({ memories: [...memories, legacyRecord(9, 'Added after rollback')], result: null }))

    // Re-cutover imports the new row, keeps the correction, and does not bring back the forgotten one.
    const back = await cutoverScope(subject.session, subject.legacy)
    expect(back.outcome).toBe('activated')
    const texts = (await legacyCompatibilityView(subject.session)).map((memory) => memory.text).sort()
    expect(texts).toEqual(['Added after rollback', 'I like jasmine tea', 'My office is on floor 7'])
    // Replaying the original pre-cutover rows cannot resurrect the forgotten memory either.
    const replay = await importLegacyMemories(subject.session, records, { importId: 'import/legacy/replay-old-file' })
    expect(replay.rows.find((row) => row.legacyId === 'legacy-1')).toMatchObject({ outcome: 'forgotten' })
    expect((await legacyCompatibilityView(subject.session)).some((memory) => memory.text.includes('4471'))).toBe(false)
  })

  it('two devices updating one imported fact: one wins, the other is told it conflicted (C20)', async () => {
    const subject = owner('devices', [legacyRecord(1, 'Team lunch is on Thursday')])
    await cutoverScope(subject.session, subject.legacy)
    const [target] = (await database.query<{ assertion_id: string }>(`SELECT assertion_id FROM gideon_memory.assertions WHERE scope_id = $1`, [subject.session.scope.id])).rows
    const edit = (text: string, device: string) => executeExplicitCommand(subject.session, { schemaVersion: 1, commandId: `command/${run}/${device}`, kind: 'correct', targetAssertionId: target!.assertion_id, targetRevision: 1, text, assertionKind: 'fact', conditions: [] })
    const [one, two] = await Promise.all([edit('Team lunch is on Friday', 'phone'), edit('Team lunch is on Monday', 'laptop')])
    expect([one, two].filter((result) => result.ok)).toHaveLength(1)
    expect([one, two].find((result) => !result.ok)).toMatchObject({ failure: { code: 'conflict' } })
    const winner = one.ok ? 'Team lunch is on Friday' : 'Team lunch is on Monday'
    expect((await legacyCompatibilityView(subject.session)).map((memory) => memory.text)).toEqual([winner])
  })

  it('routes each turn by the recorded writer: HTTP and a stale socket obey the same fence', async () => {
    Object.assign(process.env, {
      GIDEON_MEMORY_CUTOVER_ENABLED: '1', GIDEON_MEMORY_ROLLOUT_PERCENT: '100', GIDEON_MEMORY_CAPTURE_ENABLED: '1',
      GIDEON_MEMORY_COMMAND_WRITES_ENABLED: '1', GIDEON_MEMORY_RECALL_ENABLED: '1', GIDEON_MEMORY_DIR: directory,
    })
    const cookieFor = async () => {
      const account = await ensureNodeAccount(new Request('http://localhost/api/account', { method: 'POST', headers: { origin: 'http://localhost' } }))
      return (account.headers.get('set-cookie') ?? '').split(';')[0]!
    }
    const request = (cookie: string) => ({ headers: { get: (name: string) => (name === 'cookie' ? cookie : null) } })
    const tool = (memory: Awaited<ReturnType<typeof resolveNodeMemoryForTurn>>, name: string, args: Record<string, unknown>) => runServerTool(name, args, {
      store: memory.memorySession.store, session: memory.memorySession as never, memoryRuntime: memory.memoryRuntime, turnId: `turn-${counter += 1}`,
      callId: 'call-1', latestUserText: String(args.text ?? args.query ?? ''), timezone: 'UTC', signal: new AbortController().signal, env: () => undefined,
    })

    // A brand-new owner with no legacy memory is moved at once.
    const fresh = await resolveNodeMemoryForTurn(request(await cookieFor()), 'http')
    expect(fresh.memoryRuntime).toBeDefined()

    // An owner with legacy memory stays on the legacy file until an operator moves them.
    const cookie = await cookieFor()
    const ownerId = `node/${cookie.split('.')[1]}`
    writeFileSync(legacyMemoryFile(ownerId), JSON.stringify([legacyRecord(1, 'I prefer window seats')]))
    const before = await resolveNodeMemoryForTurn(request(cookie), 'websocket')
    expect(before.memoryRuntime).toBeUndefined()
    expect(await tool(before, 'remember', { text: 'My bike is blue', kind: 'fact' })).toMatchObject({ ok: true })
    expect(readFile(ownerId).map((memory) => memory.text)).toContain('My bike is blue')

    // Operator cutover while that socket stays open.
    const session = { ...createServerMemorySession({ owner: ownerId, store, channel: 'test', authority: 'worker_auth_session' }), store }
    expect(await cutoverScope(session, legacySourceFor(ownerId))).toMatchObject({ outcome: 'activated', expected: 2 })
    // The stale socket can no longer write to the file, and reads the current projection.
    const refused = await tool(before, 'remember', { text: 'Written by a stale socket', kind: 'fact' })
    expect(refused).toMatchObject({ ok: false, receiptState: 'failed' })
    expect(readFile(ownerId).map((memory) => memory.text)).not.toContain('Written by a stale socket')
    expect((await before.memorySession.store.all()).map((memory) => memory.text).sort()).toEqual(['I prefer window seats', 'My bike is blue'])

    // A reconnect gets the new authority; its writes land there.
    const after = await resolveNodeMemoryForTurn(request(cookie), 'http')
    expect(after.memoryRuntime).toBeDefined()
    expect(await tool(after, 'remember', { text: 'My bike is red now', kind: 'fact' })).toMatchObject({ ok: true })

    // After a rollback, the socket that connected while PostgreSQL was active is refused, not silently diverted.
    await rollbackScope(session, legacySourceFor(ownerId))
    expect(await tool(after, 'remember', { text: 'Written after rollback by a stale runtime', kind: 'fact' })).toMatchObject({ ok: false, receiptState: 'failed' })
    expect(await after.memoryRuntime!.retrieve('bike', { turnId: 't', responseId: 'r', principalId: ownerId, scopeId: ownerId, policyEpoch: session.policyEpoch, timezone: 'UTC', latestUserText: 'bike', transcriptHash: 'x'.repeat(64), speculative: false, conversationState: null }, new AbortController().signal)).toEqual({ status: 'unavailable', reason: 'stale' })
    expect(readFile(ownerId).map((memory) => memory.text).sort()).toEqual(['I prefer window seats', 'My bike is blue', 'My bike is red now'])
  })
})
