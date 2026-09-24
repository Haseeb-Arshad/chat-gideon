import { Pool } from 'pg'
import type { MemorySession } from '../../../src/lib/memory/contracts.ts'
import type { Memory } from '../../../src/lib/tools/memory.ts'
import { assertionIdFor, executeExplicitCommand } from './commands.ts'
import { MEMORY_SCHEMA } from './config.ts'
import { assertionText } from './controls.ts'
import { isPostgresMemoryStore, PostgresMemoryOperationError, type PostgresMemoryStore } from './postgres.ts'
import { isoNow, sha256 } from './serialization.ts'

/**
 * Stage 15: moving one owner from the legacy JSON file to the PostgreSQL
 * authority with exactly one writer at every moment.
 *
 * legacy ──fence──▶ fenced ──import, verify, compare──▶ active ──rollback──▶ rolled_back
 *
 * Every transition is a compare-and-set on the row's revision. While fenced,
 * neither store accepts writes. Once active, the JSON file is only a
 * projection of the new authority; a rollback rewrites it from the current
 * projection, so a deletion made after cutover cannot come back.
 */

const T = {
  cutovers: `${MEMORY_SCHEMA}.authority_cutovers`,
  assertions: `${MEMORY_SCHEMA}.assertions`,
  versions: `${MEMORY_SCHEMA}.assertion_versions`,
  suppressions: `${MEMORY_SCHEMA}.deletion_suppressions`,
  events: `${MEMORY_SCHEMA}.events`,
} as const

export type AuthorityState = 'legacy' | 'fenced' | 'active' | 'rolled_back'

export class CutoverFenceError extends Error {
  readonly name = 'CutoverFenceError'
  constructor(readonly state: AuthorityState | 'unknown') {
    super(`Memory writes are paused while this account's memory is being moved (${state}).`)
  }
}

interface Bound extends MemorySession { store: PostgresMemoryStore }

function bound(session: MemorySession): Bound {
  if (!isPostgresMemoryStore(session.store)) throw new Error('Cutover needs the PostgreSQL memory store.')
  return session as Bound
}

export interface AuthorityRow { state: AuthorityState; revision: number; legacyRevision: string | null; importId: string | null }

/** The writer for a scope; a scope with no row is still on the legacy file. */
export async function readAuthority(store: PostgresMemoryStore, scopeId: string): Promise<AuthorityRow> {
  const result = await store.pool.query<{ state: AuthorityState; revision: string; legacy_revision: string | null; import_id: string | null }>(
    `SELECT state, revision, legacy_revision, import_id FROM ${T.cutovers} WHERE scope_id = $1`,
    [scopeId],
  )
  const row = result.rows[0]
  return row
    ? { state: row.state, revision: Number(row.revision), legacyRevision: row.legacy_revision, importId: row.import_id }
    : { state: 'legacy', revision: 0, legacyRevision: null, importId: null }
}

/** The advisory-lock key for one owner's writer; shared by guarded writes, exclusive for transitions. */
const lockKey = (scopeId: string) => [scopeId, 15150] as const
const LOCK_SQL = 'hashtextextended($1, $2)'

/**
 * Transitions run in one transaction holding the owner's exclusive writer
 * lock, so they wait for guarded writes already in progress and block new
 * ones until the new state is committed. `underLock` runs inside it (the
 * activation re-reads the legacy file there).
 */
async function transition(store: PostgresMemoryStore, scopeId: string, from: readonly AuthorityState[], expectedRevision: number, to: AuthorityState, fields: Record<string, unknown> = {}, underLock?: () => Promise<void>): Promise<AuthorityRow> {
  const columns = Object.keys(fields)
  const assignments = columns.map((column, index) => `${column} = $${index + 5}`)
  const values = columns.map((column) => fields[column])
  const stamp = to === 'fenced' ? ', fenced_at = now()' : to === 'active' ? ', activated_at = now()' : to === 'rolled_back' ? ', rolled_back_at = now()' : ''
  const changed = await store.runTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_SQL})`, [...lockKey(scopeId)])
    if (underLock) await underLock()
    const result = expectedRevision === 0
    ? await tx.query<{ revision: string }>(
      `INSERT INTO ${T.cutovers} (scope_id, state${columns.length ? `, ${columns.join(', ')}` : ''}${to === 'fenced' ? ', fenced_at' : ''})
       SELECT $1, $2${columns.map((_, index) => `, $${index + 5}`).join('')}${to === 'fenced' ? ', now()' : ''}
       WHERE $3::text[] @> ARRAY['legacy'] AND $4::bigint = 0
       ON CONFLICT (scope_id) DO NOTHING
       RETURNING revision`,
      [scopeId, to, from, expectedRevision, ...values],
    )
    : await tx.query<{ revision: string }>(
      `UPDATE ${T.cutovers}
       SET state = $2, revision = revision + 1, updated_at = now()${stamp}${assignments.length ? `, ${assignments.join(', ')}` : ''}
       WHERE scope_id = $1 AND state = ANY($3::text[]) AND revision = $4
       RETURNING revision`,
      [scopeId, to, from, expectedRevision, ...values],
    )
    return Boolean(result.rows[0])
  })
  if (!changed) throw new CutoverConflictError(scopeId)
  return readAuthority(store, scopeId)
}

const lockPools = new WeakMap<Pool, Pool>()

/** A small separate pool for writer locks, so a held lock never waits on the pool its own work needs. */
function lockPool(store: PostgresMemoryStore): Pool {
  let pool = lockPools.get(store.pool)
  if (!pool) {
    pool = new Pool({ ...store.pool.options, max: 4, allowExitOnIdle: true, application_name: 'chat-gideon-memory-fence' })
    pool.on('error', () => undefined)
    lockPools.set(store.pool, pool)
  }
  return pool
}

/** Closes the writer-lock pool of a store (tests and shutdown). */
export async function closeWriterLocks(store: PostgresMemoryStore): Promise<void> {
  const pool = lockPools.get(store.pool)
  lockPools.delete(store.pool)
  await pool?.end()
}

/**
 * Runs one write only if this store is the owner's writer, holding the
 * owner's shared writer lock for the whole write: a cutover or rollback
 * cannot change the writer in the middle of it.
 */
export async function withWriterLock<T>(store: PostgresMemoryStore, scopeId: string, allowed: readonly AuthorityState[], work: () => Promise<T>): Promise<T> {
  let client: import('pg').PoolClient
  try {
    client = await lockPool(store).connect()
  } catch {
    throw new CutoverFenceError('unknown')
  }
  let broken: Error | undefined
  const onError = (error: Error) => { broken = error }
  client.on('error', onError)
  try {
    try {
      await client.query(`SELECT pg_advisory_lock_shared(${LOCK_SQL})`, [...lockKey(scopeId)])
    } catch {
      throw new CutoverFenceError('unknown')
    }
    try {
      const row = await client.query<{ state: AuthorityState }>(`SELECT state FROM ${T.cutovers} WHERE scope_id = $1`, [scopeId]).catch(() => null)
      if (!row) throw new CutoverFenceError('unknown')
      const state = row.rows[0]?.state ?? 'legacy'
      if (!allowed.includes(state)) throw new CutoverFenceError(state)
      return await work()
    } finally {
      await client.query(`SELECT pg_advisory_unlock_shared(${LOCK_SQL})`, [...lockKey(scopeId)]).catch((error: Error) => { broken ??= error })
    }
  } finally {
    client.off('error', onError)
    // A broken client is destroyed, which also drops any lock it still held.
    client.release(broken)
  }
}

class LegacyChangedError extends Error {}

export class CutoverConflictError extends Error {
  readonly name = 'CutoverConflictError'
  constructor(scopeId: string) { super(`Another cutover step changed ${scopeId.slice(0, 12)}… first; nothing was changed.`) }
}

// ---------------------------------------------------------------------------
// Legacy source
// ---------------------------------------------------------------------------

export interface QuarantinedLegacyRow { index: number; id: string | null; reason: string }
export interface LegacyParse { valid: Memory[]; quarantined: QuarantinedLegacyRow[]; revision: string }

const LEGACY_KINDS = new Set(['fact', 'preference', 'plan', 'person'])

/**
 * Reads the legacy array without dropping anything silently: every row is
 * either valid or quarantined with a reason. `revision` is the hash of the
 * whole file content, the fence value compared before activation.
 */
export function parseLegacyMemories(raw: unknown): LegacyParse {
  const revision = sha256(raw ?? null)
  if (raw === null || raw === undefined) return { valid: [], quarantined: [], revision }
  if (!Array.isArray(raw)) return { valid: [], quarantined: [{ index: -1, id: null, reason: 'not_an_array' }], revision }
  const valid: Memory[] = []
  const quarantined: QuarantinedLegacyRow[] = []
  const seen = new Set<string>()
  raw.forEach((row, index) => {
    const record = row && typeof row === 'object' ? row as Record<string, unknown> : null
    const id = record && typeof record.id === 'string' && record.id.trim() ? record.id : null
    const reject = (reason: string) => quarantined.push({ index, id, reason })
    if (!record) return reject('not_an_object')
    if (!id) return reject('missing_id')
    if (seen.has(id)) return reject('duplicate_id')
    if (typeof record.text !== 'string' || !record.text.trim()) return reject('empty_text')
    if (record.text.length > 240) return reject('text_too_long')
    if (!LEGACY_KINDS.has(record.kind as string)) return reject('unknown_kind')
    if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) return reject('invalid_created_at')
    seen.add(id)
    valid.push({
      id,
      kind: record.kind as Memory['kind'],
      text: record.text,
      createdAt: record.createdAt,
      usedAt: typeof record.usedAt === 'string' && !Number.isNaN(Date.parse(record.usedAt)) ? record.usedAt : record.createdAt,
      uses: Number.isSafeInteger(record.uses) && (record.uses as number) >= 0 ? record.uses as number : 0,
    })
  })
  return { valid, quarantined, revision }
}

/** The command id that imports one legacy record, stable across retries and hosts. */
export function legacyCommandId(scopeId: string, legacyId: string): string {
  return `legacy/${sha256({ scopeId, legacyId }).slice(0, 48)}`
}

export type LegacyImportOutcome = 'imported' | 'already_imported' | 'duplicate_text' | 'forgotten' | 'failed'
export interface LegacyImportReport {
  importId: string
  counts: Record<LegacyImportOutcome, number>
  rows: { legacyId: string; outcome: LegacyImportOutcome; assertionId: string | null; reason: string | null }[]
}

/**
 * Idempotent: a record already imported is recognised by its stable command
 * id, and one that was imported and then forgotten is never written again.
 * Legacy kinds map to fact/preference so the text survives unchanged; the
 * basis is `imported_legacy` and no source conversation or approval is
 * invented. The legacy id and creation time ride on the import event.
 */
export async function importLegacyMemories(session: MemorySession, memories: readonly Memory[], options: { importId: string; now?: string }): Promise<LegacyImportReport> {
  const owner = bound(session)
  const report: LegacyImportReport = { importId: options.importId, counts: { imported: 0, already_imported: 0, duplicate_text: 0, forgotten: 0, failed: 0 }, rows: [] }
  for (const memory of memories) {
    const commandId = legacyCommandId(owner.scope.id, memory.id)
    const assertionId = assertionIdFor(owner.scope.id, commandId)
    const record = (outcome: LegacyImportOutcome, id: string | null, reason: string | null = null) => {
      report.counts[outcome] += 1
      report.rows.push({ legacyId: memory.id, outcome, assertionId: id, reason })
    }
    const prior = await owner.store.pool.query<{ current_status: string | null; suppressed: boolean }>(
      `SELECT (SELECT current_status FROM ${T.assertions} WHERE scope_id = $1 AND assertion_id = $2) AS current_status,
              EXISTS (SELECT 1 FROM ${T.suppressions} WHERE scope_id = $1 AND assertion_id = $2) AS suppressed`,
      [owner.scope.id, assertionId],
    )
    if (prior.rows[0]?.suppressed || prior.rows[0]?.current_status === 'deleted') { record('forgotten', null, 'forgotten_after_import'); continue }
    if (prior.rows[0]?.current_status) { record('already_imported', assertionId); continue }
    const result = await executeExplicitCommand(owner, {
      schemaVersion: 1, commandId, kind: 'remember', text: memory.text,
      assertionKind: memory.kind === 'preference' ? 'preference' : 'fact', conditions: [],
    }, { now: options.now, origin: { kind: 'import', importId: options.importId, exportedAt: null, legacyId: memory.id, legacyCreatedAt: memory.createdAt } })
    if (!result.ok) { record('failed', null, result.failure.code); continue }
    record(result.outcome === 'duplicate' ? (result.assertion.id === assertionId ? 'already_imported' : 'duplicate_text') : 'imported', result.assertion.id)
  }
  return report
}

export interface LegacyVerification { checked: number; matching: number; mismatched: string[]; missing: string[] }

/** Every imported row must now read back with the identical text (by hash). */
export async function verifyLegacyImport(session: MemorySession, memories: readonly Memory[], report: LegacyImportReport): Promise<LegacyVerification> {
  const owner = bound(session)
  const byLegacy = new Map(report.rows.map((row) => [row.legacyId, row]))
  const verification: LegacyVerification = { checked: 0, matching: 0, mismatched: [], missing: [] }
  for (const memory of memories) {
    const row = byLegacy.get(memory.id)
    if (!row || row.outcome === 'forgotten' || row.outcome === 'failed') continue
    verification.checked += 1
    const current = await owner.store.pool.query<{ version: Parameters<typeof assertionText>[0] }>(
      `SELECT v.version FROM ${T.assertions} a JOIN ${T.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
       WHERE a.scope_id = $1 AND a.assertion_id = $2 AND a.current_status IN ('accepted', 'disputed')`,
      [owner.scope.id, row.assertionId],
    )
    const version = current.rows[0]?.version
    if (!version) { verification.missing.push(memory.id); continue }
    // A duplicate-text row points at the memory holding that text; a corrected one legitimately differs.
    if (version.revision === 1 && sha256(assertionText(version).trim()) !== sha256(memory.text.trim())) verification.mismatched.push(memory.id)
    else verification.matching += 1
  }
  return verification
}

// ---------------------------------------------------------------------------
// Cutover and rollback
// ---------------------------------------------------------------------------

export interface LegacySource {
  /** The raw JSON array (or null when the owner has no file). */
  read(): Promise<unknown>
  /** Replace the file (rollback only). */
  write(memories: Memory[]): Promise<void>
}

export interface CutoverReport {
  scopeId: string
  outcome: 'activated' | 'already_active' | 'aborted'
  reason: string | null
  legacyRevision: string
  expected: number
  quarantined: QuarantinedLegacyRow[]
  imports: LegacyImportReport[]
  verification: LegacyVerification | null
  deltaRounds: number
}

/**
 * Fence → import → verify → compare → activate. A legacy write that raced
 * the fence changes the file hash, so the delta is imported and compared
 * again (bounded); if it keeps changing, the scope stays fenced and the
 * report says why. A failed verification also stays fenced: nobody writes
 * until an operator resolves it or rolls back.
 */
export async function cutoverScope(session: MemorySession, legacy: LegacySource, options: { now?: string; maxDeltaRounds?: number } = {}): Promise<CutoverReport> {
  const owner = bound(session)
  const scopeId = owner.scope.id
  await owner.store.provisionTrustedContext(owner)
  let authority = await readAuthority(owner.store, scopeId)
  if (authority.state === 'active') return { scopeId, outcome: 'already_active', reason: null, legacyRevision: authority.legacyRevision ?? '', expected: 0, quarantined: [], imports: [], verification: null, deltaRounds: 0 }
  if (authority.state !== 'fenced') authority = await transition(owner.store, scopeId, ['legacy', 'rolled_back'], authority.revision, 'fenced')

  const imports: LegacyImportReport[] = []
  let parsed = parseLegacyMemories(await legacy.read())
  // A file that is not an array at all is not "empty": moving it would hide
  // whatever it held. Stay fenced and let an operator repair or roll back.
  if (parsed.quarantined.some((row) => row.index === -1)) {
    return { scopeId, outcome: 'aborted', reason: 'legacy_unreadable', legacyRevision: parsed.revision, expected: 0, quarantined: parsed.quarantined, imports, verification: null, deltaRounds: 0 }
  }
  let verification: LegacyVerification | null = null
  const maxRounds = options.maxDeltaRounds ?? 3
  for (let round = 1; round <= maxRounds; round += 1) {
    const importId = `import/legacy/${sha256({ scopeId, revision: parsed.revision }).slice(0, 32)}`
    imports.push(await importLegacyMemories(owner, parsed.valid, { importId, now: options.now ?? isoNow() }))
    verification = await verifyLegacyImport(owner, parsed.valid, imports.at(-1)!)
    const base = { scopeId, legacyRevision: parsed.revision, expected: parsed.valid.length, quarantined: parsed.quarantined, imports, verification, deltaRounds: round }
    if (imports.at(-1)!.counts.failed > 0) return { ...base, outcome: 'aborted', reason: 'import_failures' }
    if (verification.mismatched.length || verification.missing.length) return { ...base, outcome: 'aborted', reason: 'verification_failed' }
    // Compare and activate under the exclusive writer lock: a legacy write
    // that slipped past the fence has either landed (and changes the hash)
    // or is refused afterwards; none can land after activation.
    let again: LegacyParse | null = null
    try {
      await transition(owner.store, scopeId, ['fenced'], authority.revision, 'active', {
        legacy_revision: parsed.revision,
        import_id: importId,
        expected_count: parsed.valid.length,
        imported_count: imports.reduce((sum, item) => sum + item.counts.imported, 0),
        quarantined_count: parsed.quarantined.length,
      }, async () => {
        const current = parseLegacyMemories(await legacy.read())
        if (current.revision !== parsed.revision) {
          again = current
          throw new LegacyChangedError()
        }
      })
      return { ...base, outcome: 'activated', reason: null }
    } catch (error) {
      if (!(error instanceof LegacyChangedError) || !again) throw error
    }
    parsed = again
  }
  return { scopeId, outcome: 'aborted', reason: 'legacy_kept_changing', legacyRevision: parsed.revision, expected: parsed.valid.length, quarantined: parsed.quarantined, imports, verification, deltaRounds: maxRounds }
}

/**
 * The legacy array as a projection of the new authority: current accepted
 * memories only, so anything forgotten, suppressed or replaced is absent.
 * Imported rows keep their legacy id.
 */
export async function legacyCompatibilityView(session: MemorySession): Promise<Memory[]> {
  const owner = bound(session)
  const rows = await owner.store.pool.query<{ assertion_id: string; version: Parameters<typeof assertionText>[0]; legacy_id: string | null; legacy_created_at: string | null; created_at: Date }>(
    `SELECT a.assertion_id, v.version, a.created_at,
            e.envelope #>> '{payload,legacyId}' AS legacy_id,
            e.envelope #>> '{payload,legacyCreatedAt}' AS legacy_created_at
     FROM ${T.assertions} a
     JOIN ${T.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
     LEFT JOIN ${T.events} e ON e.scope_id = a.scope_id AND e.event_id = v.version #>> '{evidence,0,eventId}'
     WHERE a.scope_id = $1 AND a.current_status = 'accepted' AND v.status = 'accepted'
       AND NOT EXISTS (SELECT 1 FROM ${T.suppressions} s WHERE s.scope_id = a.scope_id AND s.assertion_id = a.assertion_id AND s.assertion_revision = a.current_revision)
     ORDER BY a.created_at, a.assertion_id
     LIMIT 400`,
    [owner.scope.id],
  )
  return rows.rows.map((row) => {
    const created = row.legacy_created_at ?? new Date(row.created_at).toISOString()
    const kind = row.version.kind === 'preference' ? 'preference' : row.version.kind === 'decision' ? 'plan' : 'fact'
    return { id: row.legacy_id ?? row.assertion_id, kind, text: assertionText(row.version).slice(0, 240), createdAt: created, usedAt: created, uses: 0 }
  })
}

export interface RollbackReport { scopeId: string; projected: number; legacyRevision: string }

/**
 * Hands writing back to the legacy file without reopening anything deleted:
 * fence, rewrite the file from the current projection, then mark it the
 * writer. The pre-cutover file is never restored.
 */
export async function rollbackScope(session: MemorySession, legacy: LegacySource): Promise<RollbackReport> {
  const owner = bound(session)
  let authority = await readAuthority(owner.store, owner.scope.id)
  if (authority.state !== 'active' && authority.state !== 'fenced') throw new CutoverConflictError(owner.scope.id)
  if (authority.state === 'active') authority = await transition(owner.store, owner.scope.id, ['active'], authority.revision, 'fenced')
  const projection = await legacyCompatibilityView(owner)
  await legacy.write(projection)
  const revision = parseLegacyMemories(await legacy.read()).revision
  await transition(owner.store, owner.scope.id, ['fenced'], authority.revision, 'rolled_back', { legacy_revision: revision })
  return { scopeId: owner.scope.id, projected: projection.length, legacyRevision: revision }
}

/** Throws the typed fence error unless `allowed` includes the scope's state; an unreadable state fails closed. */
export async function assertWriter(store: PostgresMemoryStore, scopeId: string, allowed: readonly AuthorityState[]): Promise<AuthorityState> {
  let state: AuthorityState
  try {
    state = (await readAuthority(store, scopeId)).state
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) throw new CutoverFenceError('unknown')
    throw new CutoverFenceError('unknown')
  }
  if (!allowed.includes(state)) throw new CutoverFenceError(state)
  return state
}
