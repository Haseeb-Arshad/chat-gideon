import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  buildWarmSnapshot,
  MAX_INPUT_VERSIONS,
  parseWarmSnapshot,
  serializeWarmSnapshot,
  type ProjectionChange,
  type ProjectionCoverage,
  type ProjectionInspector,
  type WarmSnapshot,
} from '../../../src/lib/memory/projections.ts'
import {
  parseAssertionVersion,
  type AssertionVersion,
  type ExactVersionRef,
  type MemoryFailure,
  type MemorySession,
  type PrincipalId,
  type ScopeId,
} from '../../../src/lib/memory/contracts.ts'
import { MEMORY_SCHEMA } from './config.ts'
import { PostgresMemoryOperationError, PostgresMemoryStore, type PostgresMemoryTransaction } from './postgres.ts'
import { canonicalJson, isoNow, revisionId, sha256 } from './serialization.ts'

const SQL = {
  assertions: `${MEMORY_SCHEMA}.assertions`,
  versions: `${MEMORY_SCHEMA}.assertion_versions`,
  events: `${MEMORY_SCHEMA}.events`,
  changes: `${MEMORY_SCHEMA}.change_feed`,
  epochs: `${MEMORY_SCHEMA}.policy_epochs`,
  projections: `${MEMORY_SCHEMA}.projections`,
  members: `${MEMORY_SCHEMA}.projection_members`,
  cache: `${MEMORY_SCHEMA}.managed_cache_entries`,
} as const

export const DEFAULT_WARM_SNAPSHOT_TTL_MS = 5_000
export const MAX_WARM_SNAPSHOT_TTL_MS = 5_000
export const MAX_CHANGE_FEED_PAGE = 100
export const CHANGE_CURSOR_VERSION = 1 as const

type PostgresSession = MemorySession<unknown> & { readonly store: PostgresMemoryStore }

interface EpochRow {
  policy_epoch: string | number
  deletion_epoch: string | number
}

interface ChangeRow {
  watermark: string | number
  change_kind: ProjectionChange['changeKind']
  change: unknown
}

interface ProjectionRow {
  projection_id: string
  input_versions: unknown
  covered_sequence_from: string | number
  covered_sequence_to: string | number
  policy_epoch: string | number
  deletion_epoch: string | number
  generation: string
  freshness: 'fresh' | 'stale' | 'expired'
  expires_at: string | null
  updated_at: string
}

export interface ProjectionChangeCursorPayload {
  version: typeof CHANGE_CURSOR_VERSION
  scopeId: ScopeId
  principalId: PrincipalId
  policyEpoch: number
  deletionEpoch: number
  watermark: number
}

export type ChangeFeedPage =
  | {
      status: 'ok'
      resetRequired: false
      changes: readonly ProjectionChange[]
      nextCursor: string
      hasMore: boolean
      oldestWatermark: number | null
      latestWatermark: number
    }
  | {
      status: 'reset_required'
      resetRequired: true
      reason: 'invalid_cursor' | 'scope_changed' | 'epoch_changed' | 'history_compacted' | 'cursor_ahead'
      nextCursor: null
      oldestWatermark: number | null
      latestWatermark: number
    }
  | {
      status: 'unavailable'
      resetRequired: false
      failure: MemoryFailure
    }

export interface PrepareWarmSnapshotOptions {
  now?: string
  ttlMs?: number
  activeTopic?: { id: string; label: string } | null
  snapshotId?: string
  projectionId?: string
}

export interface PreparedWarmSnapshot {
  snapshot: WarmSnapshot
  projectionId: string
}

export type PrepareWarmSnapshotResult =
  | { status: 'prepared'; prepared: PreparedWarmSnapshot }
  | { status: 'unavailable'; failure: MemoryFailure }

export type PublishWarmSnapshotResult =
  | { status: 'published'; snapshot: WarmSnapshot; projectionId: string }
  | { status: 'stale'; reason: 'epoch_changed' | 'newer_change' | 'input_changed' | 'newer_projection' }
  | { status: 'unavailable'; failure: MemoryFailure }

export type WarmSnapshotReadResult =
  | { status: 'available'; snapshot: WarmSnapshot; inspector: ProjectionInspector }
  | { status: 'cold' | 'expired' | 'invalidated' | 'unavailable'; snapshot: null; inspector: ProjectionInspector | null; reason: string; failure?: MemoryFailure }

function operationFailure(code: MemoryFailure['code'], message: string, retryable = false, details?: MemoryFailure['details']): PostgresMemoryOperationError {
  return new PostgresMemoryOperationError({ code, message, retryable, ...(details ? { details } : {}) })
}

function postgresSession(session: MemorySession): PostgresSession {
  if (!(session.store instanceof PostgresMemoryStore)) throw operationFailure('unavailable', 'Warm projections require the PostgreSQL memory authority.')
  return session as PostgresSession
}

function ensureIso(value: string, field: string): string {
  if (!value || Number.isNaN(Date.parse(value))) throw operationFailure('validation', `${field} must be an ISO timestamp.`)
  return value
}

function boundedTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_WARM_SNAPSHOT_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_WARM_SNAPSHOT_TTL_MS) throw operationFailure('validation', 'Warm snapshot TTL exceeds the private lease bound.')
  return ttl
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 20
  if (!Number.isSafeInteger(limit) || limit < 1) throw operationFailure('validation', 'A positive change-feed limit is required.')
  return Math.min(limit, MAX_CHANGE_FEED_PAGE)
}

function base64url(value: string | Buffer): string {
  return (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64url')
}

function unbase64url(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.length ? decoded : null
  } catch {
    return null
  }
}

function cursorSignature(body: string, secret: string): string {
  if (secret.length < 16) throw operationFailure('validation', 'A change cursor secret must be at least 16 characters.')
  return createHmac('sha256', secret).update(body).digest('base64url')
}

export function encodeProjectionChangeCursor(payload: ProjectionChangeCursorPayload, secret: string): string {
  if (!Number.isSafeInteger(payload.watermark) || payload.watermark < 0) throw operationFailure('validation', 'A change cursor watermark must be bounded.')
  const body = base64url(JSON.stringify(payload))
  return `${body}.${cursorSignature(body, secret)}`
}

export function decodeProjectionChangeCursor(token: string, secret: string): ProjectionChangeCursorPayload | null {
  if (typeof token !== 'string' || token.length < 16 || token.length > 1024) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra) return null
  let expected: string
  try {
    expected = cursorSignature(body, secret)
  } catch {
    return null
  }
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null
  const decoded = unbase64url(body)
  if (!decoded) return null
  try {
    const value = JSON.parse(decoded.toString()) as Record<string, unknown>
    if (value.version !== CHANGE_CURSOR_VERSION || typeof value.scopeId !== 'string' || typeof value.principalId !== 'string') return null
    if (!Number.isSafeInteger(value.policyEpoch) || !Number.isSafeInteger(value.deletionEpoch) || !Number.isSafeInteger(value.watermark) || (value.watermark as number) < 0) return null
    return {
      version: CHANGE_CURSOR_VERSION,
      scopeId: value.scopeId as ScopeId,
      principalId: value.principalId as PrincipalId,
      policyEpoch: value.policyEpoch as number,
      deletionEpoch: value.deletionEpoch as number,
      watermark: value.watermark as number,
    }
  } catch {
    return null
  }
}

function parseStoredChange(row: ChangeRow, scopeId: ScopeId): ProjectionChange | null {
  if (!row.change || typeof row.change !== 'object') return null
  const change = row.change as Record<string, unknown>
  const parsedVersion = parseAssertionVersion(change.version)
  const reference = change.assertion
  if (!parsedVersion.ok || !reference || typeof reference !== 'object') return null
  const ref = reference as Record<string, unknown>
  if (typeof ref.assertionId !== 'string' || typeof ref.revision !== 'number' || (change.operation !== 'remember' && change.operation !== 'correct')) return null
  const parsedWatermark = Number(row.watermark)
  if (!Number.isSafeInteger(parsedWatermark) || parsedWatermark < 1 || parsedVersion.value.scopeId !== scopeId) return null
  return {
    scopeId,
    changeWatermark: `watermark/${scopeId}/${parsedWatermark}`,
    operation: change.operation,
    changeKind: row.change_kind,
    assertion: { assertionId: ref.assertionId as ExactVersionRef['assertionId'], revision: ref.revision },
    version: parsedVersion.value,
  }
}

async function currentEpoch(transaction: PostgresMemoryTransaction, scopeId: ScopeId, lock = false): Promise<EpochRow> {
  const result = await transaction.query<EpochRow>(
    `SELECT policy_epoch, deletion_epoch FROM ${SQL.epochs} WHERE scope_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [scopeId],
  )
  if (!result.rows[0]) throw operationFailure('unavailable', 'The memory policy epoch is unavailable.', true)
  return result.rows[0]
}

async function acceptedAssertions(transaction: PostgresMemoryTransaction, scopeId: ScopeId): Promise<AssertionVersion[]> {
  const rows = await transaction.query<{ version: unknown }>(
    `SELECT v.version
     FROM ${SQL.assertions} a
     JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
     WHERE a.scope_id = $1 AND a.current_status = 'accepted' AND v.status = 'accepted'
     ORDER BY a.updated_at DESC, a.assertion_id
     LIMIT $2`,
    [scopeId, MAX_INPUT_VERSIONS + 1],
  )
  const values: AssertionVersion[] = []
  for (const row of rows.rows) {
    const parsed = parseAssertionVersion(row.version)
    if (!parsed.ok) continue
    if (await transaction.isVersionSuppressed({ assertionId: parsed.value.id, revision: parsed.value.revision }, parsed.value.evidence.map((edge) => edge.eventId))) continue
    values.push(parsed.value)
  }
  return values
}

async function recentChanges(transaction: PostgresMemoryTransaction, scopeId: ScopeId, limit = 32): Promise<ProjectionChange[]> {
  const rows = await transaction.query<ChangeRow>(
    `SELECT watermark, change_kind, change
     FROM ${SQL.changes}
     WHERE scope_id = $1
     ORDER BY watermark DESC
     LIMIT $2`,
    [scopeId, Math.min(Math.max(limit, 1), 32)],
  )
  const values: ProjectionChange[] = []
  for (const row of rows.rows) {
    const parsed = parseStoredChange(row, scopeId)
    if (!parsed) continue
    if (await transaction.isVersionSuppressed({ assertionId: parsed.assertion.assertionId, revision: parsed.assertion.revision }, parsed.version.evidence.map((edge) => edge.eventId))) continue
    values.push(parsed)
  }
  return values
}

async function coverage(transaction: PostgresMemoryTransaction, scopeId: ScopeId): Promise<{ eventSequence: number; changeWatermark: number }> {
  const result = await transaction.query<{ event_sequence: string | null; change_watermark: string | null }>(
    `SELECT
       (SELECT MAX(event_sequence) FROM ${SQL.events} WHERE scope_id = $1) AS event_sequence,
       (SELECT MAX(watermark) FROM ${SQL.changes} WHERE scope_id = $1) AS change_watermark`,
    [scopeId],
  )
  return {
    eventSequence: Number(result.rows[0]?.event_sequence ?? 0),
    changeWatermark: Number(result.rows[0]?.change_watermark ?? 0),
  }
}

function defaultProjectionId(scopeId: ScopeId): string {
  return `projection/warm/${scopeId}`
}

function defaultSnapshotId(scopeId: ScopeId, generation: string): string {
  return `snapshot/warm/${scopeId}/${generation.slice(-40)}`
}

export async function prepareWarmSnapshot(session: MemorySession, options: PrepareWarmSnapshotOptions = {}): Promise<PrepareWarmSnapshotResult> {
  try {
    const durable = postgresSession(session)
    const now = ensureIso(options.now ?? isoNow(), 'now')
    const ttlMs = boundedTtl(options.ttlMs)
    const projectionId = options.projectionId ?? defaultProjectionId(durable.scope.id)
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString()
    const inputs = await durable.store.forSession(durable).runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(durable, 'recall')
      const epoch = await currentEpoch(transaction, durable.scope.id)
      const assertions = await acceptedAssertions(transaction, durable.scope.id)
      const currentCoverage = await coverage(transaction, durable.scope.id)
      const changes = await recentChanges(transaction, durable.scope.id)
      return {
        assertions,
        changes,
        currentCoverage,
        policyEpoch: Number(epoch.policy_epoch),
        deletionEpoch: Number(epoch.deletion_epoch),
      }
    })
    const generation = `warm/${sha256({
      scopeId: durable.scope.id,
      policyEpoch: inputs.policyEpoch,
      deletionEpoch: inputs.deletionEpoch,
      eventSequence: inputs.currentCoverage.eventSequence,
      changeWatermark: inputs.currentCoverage.changeWatermark,
      inputs: inputs.assertions.map((assertion) => `${assertion.id}/${assertion.revision}`),
    }).slice(0, 40)}`
    const snapshot = buildWarmSnapshot({
      snapshotId: options.snapshotId ?? defaultSnapshotId(durable.scope.id, generation),
      projectionId,
      scopeId: durable.scope.id,
      principalId: durable.principal.id,
      generation,
      generatedAt: now,
      expiresAt,
      policyEpoch: inputs.policyEpoch,
      deletionEpoch: inputs.deletionEpoch,
      coveredEventSequence: inputs.currentCoverage.eventSequence,
      coveredChangeWatermark: inputs.currentCoverage.changeWatermark,
      assertions: inputs.assertions,
      recentAcceptedChanges: inputs.changes,
      activeTopic: options.activeTopic ?? null,
    })
    return { status: 'prepared', prepared: { snapshot, projectionId } satisfies PreparedWarmSnapshot }
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return { status: 'unavailable', failure: error.failure }
    return { status: 'unavailable', failure: { code: 'unavailable', message: 'The warm snapshot could not be prepared.', retryable: true } }
  }
}

async function currentInputMatches(transaction: PostgresMemoryTransaction, scopeId: ScopeId, refs: readonly ExactVersionRef[]): Promise<boolean> {
  if (!refs.length) return true
  const rows = await transaction.query<{ assertion_id: string; current_revision: string | number; current_status: string }>(
    `SELECT assertion_id, current_revision, current_status
     FROM ${SQL.assertions}
     WHERE scope_id = $1 AND assertion_id = ANY($2::text[])`,
    [scopeId, refs.map((ref) => ref.assertionId)],
  )
  if (rows.rows.length !== refs.length) return false
  const current = new Map(rows.rows.map((row) => [row.assertion_id, row]))
  return refs.every((ref) => {
    const row = current.get(ref.assertionId)
    if (!row) return false
    return Number(row.current_revision) === ref.revision && row.current_status === 'accepted'
  })
}

function staleResult(reason: Extract<PublishWarmSnapshotResult, { status: 'stale' }>['reason']): PublishWarmSnapshotResult {
  return { status: 'stale', reason }
}

export async function publishPreparedWarmSnapshot(session: MemorySession, prepared: PreparedWarmSnapshot): Promise<PublishWarmSnapshotResult> {
  try {
    const durable = postgresSession(session)
    const parsed = parseWarmSnapshot(prepared.snapshot)
    if (!parsed.ok) return { status: 'unavailable', failure: { code: 'validation', message: parsed.error, retryable: false } }
    const snapshot = parsed.value
    return await durable.store.forSession(durable).runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(durable, 'recall')
      const epoch = await currentEpoch(transaction, durable.scope.id, true)
      if (Number(epoch.policy_epoch) !== snapshot.policyEpoch || Number(epoch.deletion_epoch) !== snapshot.deletionEpoch) return staleResult('epoch_changed')
      const currentCoverage = await coverage(transaction, durable.scope.id)
      if (currentCoverage.changeWatermark > snapshot.coverage.changeWatermarkTo || currentCoverage.eventSequence > snapshot.coverage.eventSequenceTo) return staleResult('newer_change')
      if (!(await currentInputMatches(transaction, durable.scope.id, snapshot.coveredAssertionRefs))) return staleResult('input_changed')

      const existingProjection = await transaction.query<ProjectionRow>(
        `SELECT projection_id, input_versions, covered_sequence_from, covered_sequence_to,
                policy_epoch, deletion_epoch, generation, freshness, expires_at, updated_at
         FROM ${SQL.projections}
         WHERE projection_id = $1 AND scope_id = $2
         FOR UPDATE`,
        [prepared.projectionId, durable.scope.id],
      )
      const existing = existingProjection.rows[0]
      if (existing && Number(existing.covered_sequence_to) > snapshot.coverage.eventSequenceTo) return staleResult('newer_projection')
      if (existing && Number(existing.policy_epoch) !== snapshot.policyEpoch) return staleResult('epoch_changed')

      const inputVersions = snapshot.inspector.dependencies.assertionVersions
      await transaction.query(
        `INSERT INTO ${SQL.projections}
          (projection_id, scope_id, input_versions, covered_sequence_from, covered_sequence_to,
           policy_epoch, deletion_epoch, generation, freshness, expires_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, 'fresh', $9::timestamptz)
         ON CONFLICT (projection_id) DO UPDATE SET
           input_versions = EXCLUDED.input_versions,
           covered_sequence_from = EXCLUDED.covered_sequence_from,
           covered_sequence_to = EXCLUDED.covered_sequence_to,
           policy_epoch = EXCLUDED.policy_epoch,
           deletion_epoch = EXCLUDED.deletion_epoch,
           generation = EXCLUDED.generation,
           freshness = 'fresh',
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
         WHERE ${SQL.projections}.scope_id = EXCLUDED.scope_id`,
        [prepared.projectionId, durable.scope.id, canonicalJson(inputVersions), snapshot.coverage.eventSequenceFrom, snapshot.coverage.eventSequenceTo, snapshot.policyEpoch, snapshot.deletionEpoch, snapshot.inspector.generation, snapshot.expiresAt],
      )
      await transaction.query(`DELETE FROM ${SQL.members} WHERE projection_id = $1 AND scope_id = $2`, [prepared.projectionId, durable.scope.id])
      for (const [rank, ref] of snapshot.coveredAssertionRefs.entries()) {
        await transaction.query(
          `INSERT INTO ${SQL.members} (projection_id, scope_id, assertion_id, assertion_revision, visible_rank)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [prepared.projectionId, durable.scope.id, ref.assertionId, ref.revision, rank],
        )
      }

      const cacheId = `cache/warm/${durable.scope.id}`
      const cacheOwner = await transaction.query<{ principal_id: string }>(`SELECT principal_id FROM ${SQL.cache} WHERE entry_id = $1 FOR UPDATE`, [cacheId])
      if (cacheOwner.rows[0] && cacheOwner.rows[0].principal_id !== durable.principal.id) return staleResult('epoch_changed')
      await transaction.query(
        `INSERT INTO ${SQL.cache}
          (entry_id, scope_id, principal_id, payload, data_watermark, policy_epoch, deletion_epoch, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::timestamptz)
         ON CONFLICT (entry_id) DO UPDATE SET
           scope_id = EXCLUDED.scope_id,
           principal_id = EXCLUDED.principal_id,
           payload = EXCLUDED.payload,
           data_watermark = EXCLUDED.data_watermark,
           policy_epoch = EXCLUDED.policy_epoch,
           deletion_epoch = EXCLUDED.deletion_epoch,
           expires_at = EXCLUDED.expires_at`,
        [cacheId, durable.scope.id, durable.principal.id, serializeWarmSnapshot(snapshot), snapshot.coverage.changeWatermarkTo, snapshot.policyEpoch, snapshot.deletionEpoch, snapshot.expiresAt],
      )
      return { status: 'published', snapshot, projectionId: prepared.projectionId } satisfies PublishWarmSnapshotResult
    })
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return { status: 'unavailable', failure: error.failure }
    return { status: 'unavailable', failure: { code: 'unavailable', message: 'The warm snapshot could not be published.', retryable: true } }
  }
}

export async function rebuildWarmSnapshot(session: MemorySession, options: PrepareWarmSnapshotOptions = {}): Promise<PrepareWarmSnapshotResult | PublishWarmSnapshotResult> {
  const prepared = await prepareWarmSnapshot(session, options)
  if (prepared.status !== 'prepared') return prepared
  return publishPreparedWarmSnapshot(session, prepared.prepared)
}

export async function readWarmSnapshot(session: MemorySession, options: { now?: string; leaseId?: string; deadlineAt?: string; signal?: AbortSignal } = {}): Promise<WarmSnapshotReadResult> {
  try {
    const durable = postgresSession(session)
    const now = ensureIso(options.now ?? isoNow(), 'now')
    const remainingMs = options.deadlineAt ? Date.parse(options.deadlineAt) - Date.now() : null
    if (options.signal?.aborted) return { status: 'unavailable', snapshot: null, inspector: null, reason: 'retrieval_cancelled', failure: { code: 'unavailable', message: 'The warm snapshot read was cancelled.', retryable: true } }
    if (remainingMs !== null && (!Number.isFinite(remainingMs) || remainingMs <= 0)) return { status: 'unavailable', snapshot: null, inspector: null, reason: 'retrieval_deadline_expired', failure: { code: 'unavailable', message: 'The warm snapshot read exceeded the retrieval deadline.', retryable: true } }
    if (options.leaseId) {
      const { validatePrivateSnapshotLease } = await import('./deletion.ts')
      const lease = await validatePrivateSnapshotLease(durable, options.leaseId, { now })
      if (!lease.valid) return { status: lease.reason === 'expired' ? 'expired' : 'invalidated', snapshot: null, inspector: null, reason: `private_lease_${lease.reason}` }
    }
    return await durable.store.forSession(durable).runTransaction(async (transaction) => {
      if (options.signal?.aborted) throw new Error('Warm snapshot read cancelled.')
      if (remainingMs !== null) await transaction.query(`SELECT set_config('statement_timeout', $1, true)`, [`${Math.max(1, Math.floor(remainingMs))}ms`])
      await transaction.assertAuthorizedContext(durable, 'recall')
      const epoch = await currentEpoch(transaction, durable.scope.id)
      const rows = await transaction.query<{ payload: unknown; policy_epoch: string | number; deletion_epoch: string | number; expires_at: string | null }>(
        `SELECT payload, policy_epoch, deletion_epoch, expires_at
         FROM ${SQL.cache}
         WHERE entry_id = $1 AND scope_id = $2 AND principal_id = $3`,
        [`cache/warm/${durable.scope.id}`, durable.scope.id, durable.principal.id],
      )
      const row = rows.rows[0]
      if (!row) return { status: 'cold', snapshot: null, inspector: null, reason: 'no_private_snapshot' } satisfies WarmSnapshotReadResult
      if (Number(row.policy_epoch) !== Number(epoch.policy_epoch) || Number(row.deletion_epoch) !== Number(epoch.deletion_epoch)) return { status: 'invalidated', snapshot: null, inspector: null, reason: 'memory_epoch_changed' } satisfies WarmSnapshotReadResult
      if (row.expires_at && Date.parse(row.expires_at) <= Date.parse(now)) return { status: 'expired', snapshot: null, inspector: null, reason: 'snapshot_lease_expired' } satisfies WarmSnapshotReadResult
      const parsed = parseWarmSnapshot(row.payload)
      if (!parsed.ok) return { status: 'unavailable', snapshot: null, inspector: null, reason: parsed.error, failure: { code: 'unavailable', message: 'The private warm snapshot failed validation.', retryable: false } } satisfies WarmSnapshotReadResult
      if (parsed.value.scopeId !== durable.scope.id || parsed.value.principalId !== durable.principal.id) return { status: 'invalidated', snapshot: null, inspector: null, reason: 'snapshot_binding_mismatch' } satisfies WarmSnapshotReadResult
      if (parsed.value.freshness !== 'fresh') return { status: 'invalidated', snapshot: null, inspector: parsed.value.inspector, reason: 'snapshot_not_fresh' } satisfies WarmSnapshotReadResult
      return { status: 'available', snapshot: parsed.value, inspector: parsed.value.inspector } satisfies WarmSnapshotReadResult
    })
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return { status: 'unavailable', snapshot: null, inspector: null, reason: error.failure.code, failure: error.failure }
    return { status: 'unavailable', snapshot: null, inspector: null, reason: 'authority_unavailable', failure: { code: 'unavailable', message: 'The warm snapshot authority is unavailable.', retryable: true } }
  }
}

export async function readProjectionChangeFeed(
  session: MemorySession,
  options: { cursor?: string | null; cursorSecret: string; limit?: number } ,
): Promise<ChangeFeedPage> {
  try {
    const durable = postgresSession(session)
    const limit = boundedLimit(options.limit)
    const suppliedCursor = options.cursor ?? null
    const cursor = suppliedCursor ? decodeProjectionChangeCursor(suppliedCursor, options.cursorSecret) : null
    return await durable.store.forSession(durable).runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(durable, 'recall')
      const epoch = await currentEpoch(transaction, durable.scope.id)
      const bounds = await transaction.query<{ oldest: string | null; latest: string | null }>(
        `SELECT MIN(watermark) AS oldest, MAX(watermark) AS latest FROM ${SQL.changes} WHERE scope_id = $1`,
        [durable.scope.id],
      )
      const oldest = bounds.rows[0]?.oldest === null || bounds.rows[0]?.oldest === undefined ? null : Number(bounds.rows[0].oldest)
      const latest = Number(bounds.rows[0]?.latest ?? 0)
      if (suppliedCursor && !cursor) return { status: 'reset_required', resetRequired: true, reason: 'invalid_cursor', nextCursor: null, oldestWatermark: oldest, latestWatermark: latest } satisfies ChangeFeedPage
      if (cursor && (cursor.scopeId !== durable.scope.id || cursor.principalId !== durable.principal.id)) return { status: 'reset_required', resetRequired: true, reason: 'scope_changed', nextCursor: null, oldestWatermark: oldest, latestWatermark: latest } satisfies ChangeFeedPage
      if (cursor && (cursor.policyEpoch !== Number(epoch.policy_epoch) || cursor.deletionEpoch !== Number(epoch.deletion_epoch))) return { status: 'reset_required', resetRequired: true, reason: 'epoch_changed', nextCursor: null, oldestWatermark: oldest, latestWatermark: latest } satisfies ChangeFeedPage
      const after = cursor?.watermark ?? 0
      if ((oldest !== null && after < oldest - 1) || (oldest === null && after > 0)) return { status: 'reset_required', resetRequired: true, reason: 'history_compacted', nextCursor: null, oldestWatermark: oldest, latestWatermark: latest } satisfies ChangeFeedPage
      if (after > latest) return { status: 'reset_required', resetRequired: true, reason: 'cursor_ahead', nextCursor: null, oldestWatermark: oldest, latestWatermark: latest } satisfies ChangeFeedPage
      const rows = await transaction.query<ChangeRow>(
        `SELECT watermark, change_kind, change FROM ${SQL.changes}
         WHERE scope_id = $1 AND watermark > $2
         ORDER BY watermark LIMIT $3`,
        [durable.scope.id, after, limit],
      )
      const changes: ProjectionChange[] = []
      for (const row of rows.rows) {
        const change = parseStoredChange(row, durable.scope.id)
        if (!change) continue
        if (await transaction.isVersionSuppressed({ assertionId: change.assertion.assertionId, revision: change.assertion.revision }, change.version.evidence.map((edge) => edge.eventId))) continue
        changes.push(change)
      }
      const nextWatermark = rows.rows.length ? Number(rows.rows[rows.rows.length - 1]?.watermark ?? after) : after
      const nextCursor = encodeProjectionChangeCursor({ version: CHANGE_CURSOR_VERSION, scopeId: durable.scope.id, principalId: durable.principal.id, policyEpoch: Number(epoch.policy_epoch), deletionEpoch: Number(epoch.deletion_epoch), watermark: nextWatermark }, options.cursorSecret)
      return { status: 'ok', resetRequired: false, changes, nextCursor, hasMore: nextWatermark < latest, oldestWatermark: oldest, latestWatermark: latest } satisfies ChangeFeedPage
    })
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return { status: 'unavailable', resetRequired: false, failure: error.failure }
    return { status: 'unavailable', resetRequired: false, failure: { code: 'unavailable', message: 'The change feed is unavailable.', retryable: true } }
  }
}

export async function readProjectionInspector(session: MemorySession): Promise<WarmSnapshotReadResult> {
  return readWarmSnapshot(session)
}

export function coverageForSnapshot(snapshot: WarmSnapshot): ProjectionCoverage {
  return snapshot.coverage
}

export function revisionRefsForSnapshot(snapshot: WarmSnapshot): readonly ExactVersionRef[] {
  return snapshot.coveredAssertionRefs
}

export function snapshotScope(snapshot: WarmSnapshot): { scopeId: ScopeId; principalId: PrincipalId } {
  return { scopeId: snapshot.scopeId, principalId: snapshot.principalId }
}

export function snapshotRevisionIds(snapshot: WarmSnapshot): readonly string[] {
  return snapshot.coveredAssertionRefs.map((ref) => revisionId(ref.assertionId, ref.revision))
}
