import {
  parsePublicMemoryCommand,
  type AssertionId,
  type AssertionVersion,
  type ExactVersionRef,
  type MemoryFailure,
  type MemorySession,
  type PrincipalId,
  type PublicForgetCommand,
  type ScopeId,
} from '../../../src/lib/memory/contracts.ts'
import { MEMORY_SCHEMA } from './config.ts'
import { PostgresMemoryOperationError, PostgresMemoryStore, type PostgresMemoryTransaction } from './postgres.ts'
import { isoNow, revisionId } from './serialization.ts'

const SQL = {
  assertions: `${MEMORY_SCHEMA}.assertions`,
  versions: `${MEMORY_SCHEMA}.assertion_versions`,
  evidence: `${MEMORY_SCHEMA}.evidence_edges`,
  dependencies: `${MEMORY_SCHEMA}.dependency_edges`,
  events: `${MEMORY_SCHEMA}.events`,
  jobs: `${MEMORY_SCHEMA}.jobs`,
  projections: `${MEMORY_SCHEMA}.projections`,
  projectionMembers: `${MEMORY_SCHEMA}.projection_members`,
  suppressions: `${MEMORY_SCHEMA}.deletion_suppressions`,
  epochs: `${MEMORY_SCHEMA}.policy_epochs`,
  plans: `${MEMORY_SCHEMA}.deletion_plans`,
  operations: `${MEMORY_SCHEMA}.deletion_operations`,
  purgeTasks: `${MEMORY_SCHEMA}.purge_tasks`,
  ledger: `${MEMORY_SCHEMA}.control_ledger`,
  revocations: `${MEMORY_SCHEMA}.grant_revocations`,
  grants: `${MEMORY_SCHEMA}.grants`,
  recovery: `${MEMORY_SCHEMA}.recovery_guards`,
  leases: `${MEMORY_SCHEMA}.snapshot_leases`,
  cache: `${MEMORY_SCHEMA}.managed_cache_entries`,
  changes: `${MEMORY_SCHEMA}.change_feed`,
  commands: `${MEMORY_SCHEMA}.command_receipts`,
  receipts: `${MEMORY_SCHEMA}.receipts`,
} as const

export const DEFAULT_DELETION_PLAN_TTL_MS = 30_000
export const MAX_DELETION_PLAN_TTL_MS = 120_000
export const DEFAULT_PRIVATE_SNAPSHOT_LEASE_MS = 5_000
export const MAX_PRIVATE_SNAPSHOT_LEASE_MS = 5_000
export const MAX_DELETION_DEPENDENCY_DEPTH = 8
export const MAX_DELETION_DEPENDENCY_NODES = 500
export const MAX_PURGE_TASK_BATCH = 50
export const MAX_PURGE_TASK_ATTEMPTS = 3

type PostgresSession = MemorySession<unknown> & { readonly store: PostgresMemoryStore }

interface EpochRow {
  policy_epoch: string | number
  deletion_epoch: string | number
}

interface DeletionPlanRow {
  plan_id: string
  scope_id: string
  actor_principal_id: string
  target_assertion_id: string
  target_revision: string | number
  planned_policy_epoch: string | number
  planned_deletion_epoch: string | number
  expires_at: string
  status: 'planned' | 'committed' | 'expired' | 'rejected'
  deletion_id: string | null
}

interface DeletionOperationRow {
  deletion_id: string
  plan_id: string
  scope_id: string
  actor_principal_id: string
  target_assertion_id: string
  target_revision: string | number
  deletion_epoch: string | number
  status: 'logical_blocked' | 'purge_pending' | 'purged' | 'failed'
  backup_retention_limit_days: number | null
  external_copy_status: 'not_controlled' | 'bounded_by_adapter'
  logical_blocked_at: string
}

export interface DeletionTargetInput {
  targetAssertionId?: AssertionId | null
  targetRevision?: number | null
  query?: string | null
}

export interface DeletionPlan {
  schemaVersion: 1
  planId: string
  scopeId: ScopeId
  actorPrincipalId: PrincipalId
  target: ExactVersionRef
  plannedPolicyEpoch: number
  plannedDeletionEpoch: number
  expiresAt: string
  status: 'planned'
}

export type DeletionPlanResult =
  | { ok: true; plan: DeletionPlan }
  | { ok: false; failure: MemoryFailure; candidates?: readonly { assertionId: AssertionId; revision: number; kind: AssertionVersion['kind'] }[] }

export interface DeletionReceipt {
  schemaVersion: 1
  receiptId: string
  deletionId: string
  planId: string
  scopeId: ScopeId
  actorPrincipalId: PrincipalId
  target: ExactVersionRef
  /** Logical privacy state is immediate and independent of physical cleanup. */
  reuseBlocked: true
  logicalBlockedAt: string
  deletionEpoch: number
  physical: {
    status: 'pending' | 'complete' | 'failed'
    totalTasks: number
    completedTasks: number
    pendingTasks: number
    failedTasks: number
  }
  backup: {
    restorationRequiresLedgerReplay: true
    retentionLimitDays: number | null
    externallyControlledCopies: 'not_controlled' | 'bounded_by_adapter'
  }
}

export type DeletionCommandResult =
  | { ok: true; plan: DeletionPlan; receipt: DeletionReceipt }
  | { ok: false; plan: DeletionPlan | null; receipt: null; failure: MemoryFailure; candidates?: readonly { assertionId: AssertionId; revision: number; kind: AssertionVersion['kind'] }[] }

interface DeletionExpansion {
  versions: readonly ExactVersionRef[]
  eventIds: readonly string[]
  projectionIds: readonly string[]
}

interface PurgeTaskRow {
  purge_task_id: string
  deletion_id: string
  scope_id: string
  kind: 'source_event' | 'assertion_version' | 'projection' | 'change_feed' | 'command_receipt' | 'job' | 'managed_cache'
  target_id: string
  target_revision: string | number
  attempts: number
  max_attempts: number
}

export interface PurgeBatchOptions {
  now?: string
  limit?: number
  workerId?: string
  scopeId?: ScopeId
}

export interface PurgeBatchResult {
  claimed: number
  completed: number
  deferred: number
  retried: number
  failed: number
}

export interface DeletionStatusOptions {
  now?: string
}

export interface GrantRevocationReceipt {
  schemaVersion: 1
  receiptId: string
  revocationId: string
  scopeId: ScopeId
  grantId: string
  previousPolicyEpoch: number
  newPolicyEpoch: number
  revokedAt: string
  underlyingDataDeleted: false
  independentScopesUnaffected: true
}

export interface SnapshotLease {
  schemaVersion: 1
  leaseId: string
  scopeId: ScopeId
  principalId: PrincipalId
  policyEpoch: number
  deletionEpoch: number
  issuedAt: string
  expiresAt: string
  revocationWindowMs: number
  status: 'active'
}

export type SnapshotLeaseResult =
  | { ok: true; lease: SnapshotLease }
  | { ok: false; failure: MemoryFailure }

export type SnapshotLeaseValidation =
  | { valid: true; lease: SnapshotLease }
  | { valid: false; reason: 'not_found' | 'expired' | 'revoked' | 'epoch_changed' | 'restore_blocked' }

export type DispatchGuardCheck =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'epoch_changed' | 'restore_blocked' }

export interface MemoryDispatchGuard {
  check(): Promise<DispatchGuardCheck>
  onCancel(listener: () => void): () => void
  cancel(): void
}

export interface RestoreGuardStatus {
  scopeId: ScopeId
  status: 'ready' | 'blocked'
  requiredLedgerSequence: number
  reconciledLedgerSequence: number
  reason: string | null
}

function operationFailure(code: MemoryFailure['code'], message: string, retryable = false, details?: MemoryFailure['details']): PostgresMemoryOperationError {
  return new PostgresMemoryOperationError({ code, message, retryable, ...(details ? { details } : {}) })
}

function failureResult<T>(failure: MemoryFailure): T {
  return { ok: false, failure } as T
}

function postgresSession(session: MemorySession): PostgresSession {
  if (!(session.store instanceof PostgresMemoryStore)) {
    throw operationFailure('unavailable', 'Stage 05 deletion requires the Node PostgreSQL authority.', false)
  }
  return session as PostgresSession
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw operationFailure('validation', 'A bounded positive integer is required.', false)
  return Math.min(value, maximum)
}

function ensureTime(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) throw operationFailure('validation', `${field} must be an ISO timestamp.`, false)
  return value
}

function planFromRow(row: DeletionPlanRow): DeletionPlan {
  return {
    schemaVersion: 1,
    planId: row.plan_id,
    scopeId: row.scope_id as ScopeId,
    actorPrincipalId: row.actor_principal_id as PrincipalId,
    target: { assertionId: row.target_assertion_id as AssertionId, revision: Number(row.target_revision) },
    plannedPolicyEpoch: Number(row.planned_policy_epoch),
    plannedDeletionEpoch: Number(row.planned_deletion_epoch),
    expiresAt: row.expires_at,
    status: 'planned',
  }
}

function targetKey(reference: ExactVersionRef): string {
  return `${reference.assertionId}:${reference.revision}`
}

async function currentEpoch(transaction: PostgresMemoryTransaction, scopeId: ScopeId, lock: 'share' | 'update'): Promise<EpochRow> {
  const result = await transaction.query<EpochRow>(
    `SELECT policy_epoch, deletion_epoch FROM ${SQL.epochs} WHERE scope_id = $1 FOR ${lock === 'update' ? 'UPDATE' : 'SHARE'}`,
    [scopeId],
  )
  if (!result.rows[0]) throw operationFailure('unavailable', 'The memory policy epoch is unavailable.', true)
  return result.rows[0]
}

async function appendLedger(
  transaction: PostgresMemoryTransaction,
  scopeId: ScopeId,
  operationId: string,
  deletionId: string,
  policyEpoch: number,
  deletionEpoch: number,
  eventIds: readonly string[],
  versions: readonly ExactVersionRef[],
): Promise<void> {
  const maxResult = await transaction.query<{ max_sequence: string }>(
    `SELECT COALESCE(MAX(ledger_sequence), 0) AS max_sequence FROM ${SQL.ledger} WHERE scope_id = $1`,
    [scopeId],
  )
  let sequence = Number(maxResult.rows[0]?.max_sequence ?? 0) + 1
  for (const eventId of eventIds) {
    await transaction.query(
      `INSERT INTO ${SQL.ledger}
        (scope_id, ledger_sequence, operation_id, operation_kind, deletion_id, event_id, policy_epoch, deletion_epoch)
       VALUES ($1, $2, $3, 'deletion', $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [scopeId, sequence++, operationId, deletionId, eventId, policyEpoch, deletionEpoch],
    )
  }
  for (const reference of versions) {
    await transaction.query(
      `INSERT INTO ${SQL.ledger}
        (scope_id, ledger_sequence, operation_id, operation_kind, deletion_id, assertion_id, assertion_revision, policy_epoch, deletion_epoch)
       VALUES ($1, $2, $3, 'deletion', $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [scopeId, sequence++, operationId, deletionId, reference.assertionId, reference.revision, policyEpoch, deletionEpoch],
    )
  }
}

async function insertPurgeTask(
  transaction: PostgresMemoryTransaction,
  deletionId: string,
  scopeId: ScopeId,
  kind: PurgeTaskRow['kind'],
  targetId: string,
  targetRevision = 0,
  now: string,
): Promise<void> {
  await transaction.query(
    `INSERT INTO ${SQL.purgeTasks}
      (purge_task_id, deletion_id, scope_id, kind, target_id, target_revision, status, attempts, max_attempts, available_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, $7, $8::timestamptz)
     ON CONFLICT (deletion_id, kind, target_id, target_revision) DO NOTHING`,
    [`purge/${deletionId}/${kind}/${targetId}/${targetRevision}`, deletionId, scopeId, kind, targetId, targetRevision, MAX_PURGE_TASK_ATTEMPTS, now],
  )
}

async function expandDeletionTargets(transaction: PostgresMemoryTransaction, root: AssertionVersion): Promise<DeletionExpansion> {
  const versions = new Map<string, ExactVersionRef>()
  const eventIds = new Set<string>(root.evidence.map((edge) => edge.eventId))
  const addVersion = (reference: ExactVersionRef): boolean => {
    if (versions.size >= MAX_DELETION_DEPENDENCY_NODES) return false
    const key = targetKey(reference)
    if (versions.has(key)) return false
    versions.set(key, reference)
    return true
  }

  // Deleting an exact assertion version removes its revision lineage. This
  // keeps a later correction from resurrecting the same private assertion.
  const rootRevisions = await transaction.query<{ revision: string | number }>(
    `SELECT revision FROM ${SQL.versions} WHERE scope_id = $1 AND assertion_id = $2 ORDER BY revision LIMIT $3`,
    [root.scopeId, root.id, MAX_DELETION_DEPENDENCY_NODES],
  )
  for (const row of rootRevisions.rows) addVersion({ assertionId: root.id, revision: Number(row.revision) })
  if (!versions.size) addVersion({ assertionId: root.id, revision: root.revision })

  let truncated = false
  let changed = true
  for (let depth = 0; changed && depth < MAX_DELETION_DEPENDENCY_DEPTH; depth += 1) {
    changed = false
    const snapshot = [...versions.values()]
    for (const reference of snapshot) {
      const edgeRows = await transaction.query<{ event_id: string }>(
        `SELECT event_id FROM ${SQL.evidence} WHERE scope_id = $1 AND assertion_id = $2 AND assertion_revision = $3`,
        [root.scopeId, reference.assertionId, reference.revision],
      )
      for (const row of edgeRows.rows) eventIds.add(row.event_id)
      const dependentRows = await transaction.query<{ assertion_id: string; assertion_revision: string | number }>(
        `SELECT assertion_id, assertion_revision
         FROM ${SQL.dependencies}
         WHERE scope_id = $1 AND dependency_type = 'assertion'
           AND dependency_id = $2 AND dependency_revision = $3
         LIMIT $4`,
        [root.scopeId, reference.assertionId, revisionId(reference.assertionId, reference.revision), MAX_DELETION_DEPENDENCY_NODES],
      )
      for (const row of dependentRows.rows) {
        if (addVersion({ assertionId: row.assertion_id as AssertionId, revision: Number(row.assertion_revision) })) changed = true
      }
    }
    if (eventIds.size) {
      const eventRows = await transaction.query<{ assertion_id: string; assertion_revision: string | number }>(
        `SELECT assertion_id, assertion_revision
         FROM ${SQL.evidence}
         WHERE scope_id = $1 AND event_id = ANY($2::text[])
         LIMIT $3`,
        [root.scopeId, [...eventIds], MAX_DELETION_DEPENDENCY_NODES],
      )
      for (const row of eventRows.rows) {
        if (addVersion({ assertionId: row.assertion_id as AssertionId, revision: Number(row.assertion_revision) })) changed = true
      }
    }
    if (versions.size >= MAX_DELETION_DEPENDENCY_NODES) truncated = true
  }
  if (changed) truncated = true

  const references = [...versions.values()]
  const referenceKeys = new Set(references.map((reference) => revisionId(reference.assertionId, reference.revision)))
  const projectionIds = new Set<string>()
  const memberRows = await transaction.query<{ projection_id: string }>(
    `SELECT DISTINCT projection_id FROM ${SQL.projectionMembers}
     WHERE scope_id = $1 AND assertion_id = ANY($2::text[]) AND assertion_revision = ANY($3::bigint[])`,
    [root.scopeId, [...new Set(references.map((reference) => reference.assertionId))], references.map((reference) => reference.revision)],
  )
  for (const row of memberRows.rows) projectionIds.add(row.projection_id)

  const projectionRows = await transaction.query<{ projection_id: string; input_versions: unknown }>(
    `SELECT projection_id, input_versions FROM ${SQL.projections} WHERE scope_id = $1`,
    [root.scopeId],
  )
  for (const row of projectionRows.rows) {
    const inputs = row.input_versions
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.some((input) => typeof input !== 'string')) {
      // No precise lineage is a reason to invalidate the whole summary.
      projectionIds.add(row.projection_id)
      continue
    }
    if (inputs.some((input) => referenceKeys.has(input))) projectionIds.add(row.projection_id)
  }
  if (truncated) for (const row of projectionRows.rows) projectionIds.add(row.projection_id)

  return { versions: references, eventIds: [...eventIds], projectionIds: [...projectionIds] }
}

async function suppressionAndInvalidation(
  transaction: PostgresMemoryTransaction,
  scopeId: ScopeId,
  deletionId: string,
  actorPrincipalId: PrincipalId,
  plan: DeletionPlan,
  expansion: DeletionExpansion,
  policyEpoch: number,
  deletionEpoch: number,
  now: string,
): Promise<void> {
  for (const eventId of expansion.eventIds) {
    await transaction.query(
      `INSERT INTO ${SQL.suppressions}
        (suppression_id, scope_id, event_id, policy_epoch, deletion_epoch, reason)
       VALUES ($1, $2, $3, $4, $5, 'user_forget')
       ON CONFLICT DO NOTHING`,
      [`suppression/${deletionId}/event/${eventId}`, scopeId, eventId, policyEpoch, deletionEpoch],
    )
  }
  for (const reference of expansion.versions) {
    await transaction.query(
      `INSERT INTO ${SQL.suppressions}
        (suppression_id, scope_id, assertion_id, assertion_revision, policy_epoch, deletion_epoch, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'user_forget')
       ON CONFLICT DO NOTHING`,
      [`suppression/${deletionId}/assertion/${reference.assertionId}/${reference.revision}`, scopeId, reference.assertionId, reference.revision, policyEpoch, deletionEpoch],
    )
  }
  await transaction.query(
    `UPDATE ${SQL.epochs} SET deletion_epoch = $2, updated_at = now() WHERE scope_id = $1`,
    [scopeId, deletionEpoch],
  )
  const assertionIds = [...new Set(expansion.versions.map((reference) => reference.assertionId))]
  if (assertionIds.length) {
    // The canonical key is an unkeyed hash of the normalized proposition, so a
    // retained copy could confirm a guessed deleted sentence. Reuse of the
    // deleted command is blocked by its retained event suppression instead;
    // a new explicit statement from the user is new evidence and may be kept.
    await transaction.query(
      `UPDATE ${SQL.assertions}
       SET current_status = 'deleted', canonical_key = NULL, updated_at = now()
       WHERE scope_id = $1 AND assertion_id = ANY($2::text[])`,
      [scopeId, assertionIds],
    )
  }
  if (expansion.projectionIds.length) {
    await transaction.query(
      `UPDATE ${SQL.projections}
       SET freshness = 'stale', deletion_epoch = $2, updated_at = now()
       WHERE scope_id = $1 AND projection_id = ANY($3::text[])`,
      [scopeId, deletionEpoch, expansion.projectionIds],
    )
    await transaction.query(
      `DELETE FROM ${SQL.projectionMembers} WHERE scope_id = $1 AND projection_id = ANY($2::text[])`,
      [scopeId, expansion.projectionIds],
    )
  }
  if (expansion.eventIds.length) {
    await transaction.query(
      `UPDATE ${SQL.jobs}
       SET state = 'dead', lease_until = NULL, worker_id = NULL,
           last_failure_code = 'revoked_input', updated_at = now()
       WHERE scope_id = $1 AND input_event_id = ANY($2::text[])
         AND state IN ('pending', 'retry')`,
      [scopeId, expansion.eventIds],
    )
  }
  await transaction.query(
    `UPDATE ${SQL.leases}
     SET status = 'revoked', invalidated_at = $2::timestamptz
     WHERE scope_id = $1 AND status = 'active'`,
    [scopeId, now],
  )
  await transaction.query(
    `INSERT INTO ${SQL.operations}
      (deletion_id, plan_id, scope_id, actor_principal_id, target_assertion_id, target_revision,
       deletion_epoch, status, reuse_blocked, logical_blocked_at, backup_retention_limit_days, external_copy_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'purge_pending', true, $8::timestamptz, NULL, 'not_controlled')`,
    [deletionId, plan.planId, scopeId, actorPrincipalId, plan.target.assertionId, plan.target.revision, deletionEpoch, now],
  )

  await appendLedger(transaction, scopeId, deletionId, deletionId, policyEpoch, deletionEpoch, expansion.eventIds, expansion.versions)
  for (const reference of expansion.versions) await insertPurgeTask(transaction, deletionId, scopeId, 'assertion_version', reference.assertionId, reference.revision, now)
  for (const eventId of expansion.eventIds) {
    await insertPurgeTask(transaction, deletionId, scopeId, 'source_event', eventId, 0, now)
    const jobRows = await transaction.query<{ job_id: string }>(`SELECT job_id FROM ${SQL.jobs} WHERE scope_id = $1 AND input_event_id = $2`, [scopeId, eventId])
    for (const row of jobRows.rows) await insertPurgeTask(transaction, deletionId, scopeId, 'job', row.job_id, 0, now)
  }
  for (const projectionId of expansion.projectionIds) await insertPurgeTask(transaction, deletionId, scopeId, 'projection', projectionId, 0, now)

  const assertionIdsForQuery = [...new Set(expansion.versions.map((reference) => reference.assertionId))]
  const revisionNumbers = expansion.versions.map((reference) => reference.revision)
  const changeRows = await transaction.query<{ watermark: string | number }>(
    `SELECT watermark FROM ${SQL.changes}
     WHERE scope_id = $1 AND (event_id = ANY($2::text[]) OR (assertion_id = ANY($3::text[]) AND assertion_revision = ANY($4::bigint[])))`,
    [scopeId, expansion.eventIds, assertionIdsForQuery, revisionNumbers],
  )
  for (const row of changeRows.rows) await insertPurgeTask(transaction, deletionId, scopeId, 'change_feed', String(row.watermark), 0, now)
  const commandRows = await transaction.query<{ command_id: string }>(
    `SELECT command_id FROM ${SQL.commands}
     WHERE scope_id = $1 AND (event_id = ANY($2::text[]) OR (assertion_id = ANY($3::text[]) AND assertion_revision = ANY($4::bigint[])))`,
    [scopeId, expansion.eventIds, assertionIdsForQuery, revisionNumbers],
  )
  for (const row of commandRows.rows) await insertPurgeTask(transaction, deletionId, scopeId, 'command_receipt', row.command_id, 0, now)
  const cacheRows = await transaction.query<{ entry_id: string }>(`SELECT entry_id FROM ${SQL.cache} WHERE scope_id = $1`, [scopeId])
  for (const row of cacheRows.rows) await insertPurgeTask(transaction, deletionId, scopeId, 'managed_cache', row.entry_id, 0, now)
}

async function deletionReceipt(transaction: PostgresMemoryTransaction, deletionId: string): Promise<DeletionReceipt> {
  const operationResult = await transaction.query<DeletionOperationRow>(
    `SELECT deletion_id, plan_id, scope_id, actor_principal_id, target_assertion_id, target_revision,
            deletion_epoch, status, backup_retention_limit_days, external_copy_status, logical_blocked_at
     FROM ${SQL.operations} WHERE deletion_id = $1`,
    [deletionId],
  )
  const operation = operationResult.rows[0]
  if (!operation) throw operationFailure('not_found', 'The deletion operation does not exist.', false)
  const counts = await transaction.query<{ total: string; completed: string; pending: string; failed: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status = 'completed')::text AS completed,
            count(*) FILTER (WHERE status IN ('pending', 'running', 'retry'))::text AS pending,
            count(*) FILTER (WHERE status = 'failed')::text AS failed
     FROM ${SQL.purgeTasks} WHERE deletion_id = $1`,
    [deletionId],
  )
  const row = counts.rows[0] ?? { total: '0', completed: '0', pending: '0', failed: '0' }
  const failed = Number(row.failed)
  const pending = Number(row.pending)
  const status = failed > 0 ? 'failed' : pending > 0 ? 'pending' : 'complete'
  return {
    schemaVersion: 1,
    receiptId: `receipt/deletion/${deletionId}`,
    deletionId,
    planId: operation.plan_id,
    scopeId: operation.scope_id as ScopeId,
    actorPrincipalId: operation.actor_principal_id as PrincipalId,
    target: { assertionId: operation.target_assertion_id as AssertionId, revision: Number(operation.target_revision) },
    reuseBlocked: true,
    logicalBlockedAt: operation.logical_blocked_at,
    deletionEpoch: Number(operation.deletion_epoch),
    physical: { status, totalTasks: Number(row.total), completedTasks: Number(row.completed), pendingTasks: pending, failedTasks: failed },
    backup: {
      restorationRequiresLedgerReplay: true,
      retentionLimitDays: operation.backup_retention_limit_days,
      externallyControlledCopies: operation.external_copy_status,
    },
  }
}

/** Create a short-lived exact destructive target. Query matches are resolved before commit. */
export async function createDeletionPlan(
  session: MemorySession,
  input: DeletionTargetInput,
  options: { now?: string; ttlMs?: number; planId?: string } = {},
): Promise<DeletionPlanResult> {
  try {
    const durable = postgresSession(session)
    const now = ensureTime(options.now ?? isoNow(), 'now')
    const ttlMs = boundedInteger(options.ttlMs, DEFAULT_DELETION_PLAN_TTL_MS, MAX_DELETION_PLAN_TTL_MS)
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString()
    const planId = options.planId ?? `plan/deletion/${crypto.randomUUID()}`
    return await durable.store.forSession(durable).runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(durable, 'forget')
      const epoch = await currentEpoch(transaction, durable.scope.id, 'share')
      let target: ExactVersionRef
      if (input.targetAssertionId !== undefined && input.targetAssertionId !== null) {
        if (!Number.isSafeInteger(input.targetRevision) || (input.targetRevision ?? 0) < 1) {
          throw operationFailure('validation', 'An exact deletion plan requires an exact assertion revision.', false)
        }
        target = { assertionId: input.targetAssertionId, revision: input.targetRevision as number }
        const exists = await transaction.query(`SELECT 1 FROM ${SQL.versions} WHERE scope_id = $1 AND assertion_id = $2 AND revision = $3`, [durable.scope.id, target.assertionId, target.revision])
        if (!exists.rows[0]) throw operationFailure('not_found', 'The exact deletion target is not available in this scope.', false)
        if (await transaction.isSuppressed(target)) throw operationFailure('suppressed', 'The exact deletion target is already suppressed.', false)
      } else {
        const query = input.query?.trim() ?? ''
        if (!query) throw operationFailure('validation', 'A deletion plan needs an exact target or a non-empty query.', false)
        const candidates = await transaction.scopedCandidates({ scopeId: durable.scope.id, subject: durable.subject, query, limit: 20, asOf: null })
        const exact = candidates.map((candidate) => ({ assertionId: candidate.id, revision: candidate.revision, kind: candidate.kind }))
        if (!exact.length) throw operationFailure('not_found', 'No exact memory target matched this query.', false)
        if (exact.length !== 1) {
          return { ok: false, failure: { code: 'ambiguous', message: 'More than one memory target matched; choose an exact assertion and revision.', retryable: false, details: { candidateCount: exact.length } }, candidates: exact }
        }
        target = { assertionId: exact[0]!.assertionId, revision: exact[0]!.revision }
      }
      const plan = {
        planId,
        scopeId: durable.scope.id,
        actorPrincipalId: durable.principal.id,
        targetAssertionId: target.assertionId,
        targetRevision: target.revision,
        plannedPolicyEpoch: Number(epoch.policy_epoch),
        plannedDeletionEpoch: Number(epoch.deletion_epoch),
        expiresAt,
        status: 'planned',
      } as const
      const inserted = await transaction.query<DeletionPlanRow>(
        `INSERT INTO ${SQL.plans}
          (plan_id, scope_id, actor_principal_id, target_assertion_id, target_revision,
           planned_policy_epoch, planned_deletion_epoch, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, 'planned')
         RETURNING plan_id, scope_id, actor_principal_id, target_assertion_id, target_revision,
                   planned_policy_epoch, planned_deletion_epoch, expires_at, status, deletion_id`,
        [plan.planId, plan.scopeId, plan.actorPrincipalId, plan.targetAssertionId, plan.targetRevision, plan.plannedPolicyEpoch, plan.plannedDeletionEpoch, plan.expiresAt],
      )
      return { ok: true, plan: planFromRow(inserted.rows[0]!) }
    })
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return failureResult<DeletionPlanResult>(error.failure)
    return failureResult<DeletionPlanResult>({ code: 'unavailable', message: 'Memory authority is unavailable; no deletion plan was committed.', retryable: true })
  }
}

/** Commit the logical block once, then report physical purge independently. */
export async function executeDeletionPlan(
  session: MemorySession,
  planId: string,
  options: { now?: string } = {},
): Promise<{ ok: true; receipt: DeletionReceipt } | { ok: false; receipt: null; failure: MemoryFailure }> {
  try {
    const durable = postgresSession(session)
    const now = ensureTime(options.now ?? isoNow(), 'now')
    const execution = await durable.store.forSession(durable).runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(durable, 'forget')
      const epoch = await currentEpoch(transaction, durable.scope.id, 'update')
      const planResult = await transaction.query<DeletionPlanRow>(`SELECT * FROM ${SQL.plans} WHERE plan_id = $1 FOR UPDATE`, [planId])
      const planRow = planResult.rows[0]
      if (!planRow || planRow.scope_id !== durable.scope.id || planRow.actor_principal_id !== durable.principal.id) {
        throw operationFailure('unauthorized', 'The deletion plan is not bound to this authenticated actor and scope.', false)
      }
      if (planRow.status === 'committed' && planRow.deletion_id) return deletionReceipt(transaction, planRow.deletion_id)
      if (planRow.status !== 'planned') throw operationFailure('conflict', 'The deletion plan is no longer executable.', false)
      if (Date.parse(planRow.expires_at) <= Date.parse(now)) {
        await transaction.query(`UPDATE ${SQL.plans} SET status = 'expired' WHERE plan_id = $1`, [planId])
        return { failure: { code: 'conflict', message: 'The deletion plan expired before its logical block committed.', retryable: false } satisfies MemoryFailure }
      }
      if (Number(epoch.policy_epoch) !== Number(planRow.planned_policy_epoch) || Number(epoch.deletion_epoch) !== Number(planRow.planned_deletion_epoch)) {
        await transaction.query(`UPDATE ${SQL.plans} SET status = 'rejected' WHERE plan_id = $1`, [planId])
        return { failure: { code: 'conflict', message: 'The memory policy changed; create a fresh exact deletion plan.', retryable: true } satisfies MemoryFailure }
      }
      const target: ExactVersionRef = { assertionId: planRow.target_assertion_id as AssertionId, revision: Number(planRow.target_revision) }
      const root = await transaction.exactVersion(target)
      if (!root) {
        if (await transaction.isSuppressed(target)) throw operationFailure('suppressed', 'The deletion target is already suppressed.', false)
        throw operationFailure('not_found', 'The exact deletion target is no longer available.', false)
      }
      const expansion = await expandDeletionTargets(transaction, root)
      const deletionId = `deletion/${crypto.randomUUID()}`
      const deletionEpoch = Number(epoch.deletion_epoch) + 1
      await suppressionAndInvalidation(transaction, durable.scope.id, deletionId, durable.principal.id, planFromRow(planRow), expansion, Number(epoch.policy_epoch), deletionEpoch, now)
      await transaction.query(`UPDATE ${SQL.plans} SET status = 'committed', deletion_id = $2, committed_at = $3::timestamptz WHERE plan_id = $1`, [planId, deletionId, now])
      return deletionReceipt(transaction, deletionId)
    })
    if ('failure' in execution) return { ok: false, receipt: null, failure: execution.failure }
    return { ok: true, receipt: execution }
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return { ok: false, receipt: null, failure: error.failure }
    return { ok: false, receipt: null, failure: { code: 'unavailable', message: 'Memory authority is unavailable; the deletion transaction was rolled back.', retryable: true } }
  }
}

/** Parse, resolve and commit a forget command without a redundant confirmation step. */
export async function executeForgetCommand(
  session: MemorySession,
  input: PublicForgetCommand | unknown,
  options: { now?: string; ttlMs?: number } = {},
): Promise<DeletionCommandResult> {
  const parsed = parsePublicMemoryCommand(input)
  if (!parsed.ok || parsed.value.kind !== 'forget') {
    return { ok: false, plan: null, receipt: null, failure: { code: 'validation', message: parsed.ok ? 'Expected a forget command.' : parsed.error.message, retryable: false } }
  }
  const planResult = await createDeletionPlan(session, parsed.value, options)
  if (!planResult.ok) return { ...planResult, plan: null, receipt: null }
  const execution = await executeDeletionPlan(session, planResult.plan.planId, options)
  if (!execution.ok) return { ...execution, plan: planResult.plan, receipt: null }
  return { ok: true, plan: planResult.plan, receipt: execution.receipt }
}

export async function getDeletionStatus(
  session: MemorySession,
  deletionId: string,
  options: DeletionStatusOptions = {},
): Promise<{ ok: true; receipt: DeletionReceipt } | { ok: false; receipt: null; failure: MemoryFailure }> {
  try {
    const durable = postgresSession(session)
    ensureTime(options.now ?? isoNow(), 'now')
    const receipt = await durable.store.forSession(durable).runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(durable, 'inspect')
      const exists = await transaction.query(`SELECT 1 FROM ${SQL.operations} WHERE deletion_id = $1 AND scope_id = $2`, [deletionId, durable.scope.id])
      if (!exists.rows[0]) throw operationFailure('not_found', 'The deletion operation does not exist in this scope.', false)
      return deletionReceipt(transaction, deletionId)
    })
    return { ok: true, receipt }
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return { ok: false, receipt: null, failure: error.failure }
    return { ok: false, receipt: null, failure: { code: 'unavailable', message: 'Memory authority is unavailable; deletion status could not be read.', retryable: true } }
  }
}

async function refreshDeletionOperation(transaction: PostgresMemoryTransaction, deletionId: string): Promise<void> {
  const counts = await transaction.query<{ pending: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('pending', 'running', 'retry'))::text AS pending,
            count(*) FILTER (WHERE status = 'failed')::text AS failed
     FROM ${SQL.purgeTasks} WHERE deletion_id = $1`,
    [deletionId],
  )
  const row = counts.rows[0] ?? { pending: '0', failed: '0' }
  const status = Number(row.failed) > 0 ? 'failed' : Number(row.pending) > 0 ? 'purge_pending' : 'purged'
  await transaction.query(
    `UPDATE ${SQL.operations}
     SET status = $2,
         purge_started_at = CASE WHEN $2 <> 'logical_blocked' AND purge_started_at IS NULL THEN now() ELSE purge_started_at END,
         purge_completed_at = CASE WHEN $2 = 'purged' THEN COALESCE(purge_completed_at, now()) ELSE purge_completed_at END
     WHERE deletion_id = $1`,
    [deletionId, status],
  )
}

async function executePurgeTask(transaction: PostgresMemoryTransaction, task: PurgeTaskRow, now: string): Promise<'completed' | 'deferred'> {
  if (task.kind === 'source_event') {
    const dependencies = await transaction.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SQL.purgeTasks}
       WHERE deletion_id = $1 AND kind = 'assertion_version' AND status <> 'completed'`,
      [task.deletion_id],
    )
    if (Number(dependencies.rows[0]?.count ?? 0) > 0) {
      const status = task.attempts >= task.max_attempts ? 'failed' : 'retry'
      await transaction.query(`UPDATE ${SQL.purgeTasks} SET status = $2, available_at = $3::timestamptz, lease_until = NULL, last_failure = CASE WHEN $2 = 'failed' THEN 'dependencies_pending' ELSE last_failure END, updated_at = now() WHERE purge_task_id = $1`, [task.purge_task_id, status, now])
      await refreshDeletionOperation(transaction, task.deletion_id)
      return 'deferred'
    }
    await transaction.query(`DELETE FROM ${SQL.receipts} WHERE event_id = $1`, [task.target_id])
    await transaction.query(`DELETE FROM ${SQL.jobs} WHERE scope_id = $1 AND input_event_id = $2`, [task.scope_id, task.target_id])
    await transaction.query(`DELETE FROM ${SQL.changes} WHERE scope_id = $1 AND event_id = $2`, [task.scope_id, task.target_id])
    await transaction.query(`DELETE FROM ${SQL.commands} WHERE scope_id = $1 AND event_id = $2`, [task.scope_id, task.target_id])
    await transaction.query(`DELETE FROM ${SQL.evidence} WHERE scope_id = $1 AND event_id = $2`, [task.scope_id, task.target_id])
    await transaction.query(`DELETE FROM ${SQL.events} WHERE scope_id = $1 AND event_id = $2`, [task.scope_id, task.target_id])
  } else if (task.kind === 'assertion_version') {
    await transaction.query(`DELETE FROM ${SQL.projectionMembers} WHERE scope_id = $1 AND assertion_id = $2 AND assertion_revision = $3`, [task.scope_id, task.target_id, Number(task.target_revision)])
    await transaction.query(`DELETE FROM ${SQL.dependencies} WHERE scope_id = $1 AND assertion_id = $2 AND assertion_revision = $3`, [task.scope_id, task.target_id, Number(task.target_revision)])
    await transaction.query(`DELETE FROM ${SQL.evidence} WHERE scope_id = $1 AND assertion_id = $2 AND assertion_revision = $3`, [task.scope_id, task.target_id, Number(task.target_revision)])
    await transaction.query(`DELETE FROM ${SQL.changes} WHERE scope_id = $1 AND assertion_id = $2 AND assertion_revision = $3`, [task.scope_id, task.target_id, Number(task.target_revision)])
    await transaction.query(`DELETE FROM ${SQL.commands} WHERE scope_id = $1 AND assertion_id = $2 AND assertion_revision = $3`, [task.scope_id, task.target_id, Number(task.target_revision)])
    const assertion = await transaction.query<{ current_revision: string | number; canonical_key: string | null }>(`SELECT current_revision, canonical_key FROM ${SQL.assertions} WHERE scope_id = $1 AND assertion_id = $2 FOR UPDATE`, [task.scope_id, task.target_id])
    await transaction.query(`DELETE FROM ${SQL.versions} WHERE scope_id = $1 AND assertion_id = $2 AND revision = $3`, [task.scope_id, task.target_id, Number(task.target_revision)])
    if (assertion.rows[0] && Number(assertion.rows[0].current_revision) === Number(task.target_revision)) {
      const remaining = await transaction.query<{ revision: string | number; status: string }>(`SELECT revision, status FROM ${SQL.versions} WHERE scope_id = $1 AND assertion_id = $2 ORDER BY revision DESC LIMIT 1`, [task.scope_id, task.target_id])
      if (!remaining.rows[0]) {
        if (assertion.rows[0].canonical_key) {
          await transaction.query(
            `UPDATE ${SQL.assertions}
             SET subject_kind = 'unresolved', subject_key = 'deleted', slot_id = NULL,
                 slot_cardinality = NULL, current_status = 'deleted', updated_at = now()
             WHERE scope_id = $1 AND assertion_id = $2`,
            [task.scope_id, task.target_id],
          )
        } else {
          await transaction.query(`DELETE FROM ${SQL.assertions} WHERE scope_id = $1 AND assertion_id = $2`, [task.scope_id, task.target_id])
        }
      } else {
        const suppressed = await transaction.query(`SELECT 1 FROM ${SQL.suppressions} WHERE scope_id = $1 AND assertion_id = $2 AND assertion_revision = $3`, [task.scope_id, task.target_id, Number(remaining.rows[0].revision)])
        await transaction.query(`UPDATE ${SQL.assertions} SET current_revision = $3, current_status = $4, updated_at = now() WHERE scope_id = $1 AND assertion_id = $2`, [task.scope_id, task.target_id, Number(remaining.rows[0].revision), suppressed.rows[0] ? 'deleted' : remaining.rows[0].status])
      }
    }
  } else if (task.kind === 'projection') {
    await transaction.query(`DELETE FROM ${SQL.projectionMembers} WHERE projection_id = $1 AND scope_id = $2`, [task.target_id, task.scope_id])
    await transaction.query(`DELETE FROM ${SQL.projections} WHERE projection_id = $1 AND scope_id = $2`, [task.target_id, task.scope_id])
  } else if (task.kind === 'change_feed') {
    const watermark = Number(task.target_id)
    if (!Number.isSafeInteger(watermark) || watermark < 1) throw operationFailure('validation', 'A purge task contained an invalid change watermark.', false)
    await transaction.query(`DELETE FROM ${SQL.changes} WHERE scope_id = $1 AND watermark = $2`, [task.scope_id, watermark])
  } else if (task.kind === 'command_receipt') {
    await transaction.query(`DELETE FROM ${SQL.commands} WHERE scope_id = $1 AND command_id = $2`, [task.scope_id, task.target_id])
  } else if (task.kind === 'job') {
    await transaction.query(`DELETE FROM ${SQL.jobs} WHERE scope_id = $1 AND job_id = $2`, [task.scope_id, task.target_id])
  } else if (task.kind === 'managed_cache') {
    await transaction.query(`DELETE FROM ${SQL.cache} WHERE scope_id = $1 AND entry_id = $2`, [task.scope_id, task.target_id])
  }
  await transaction.query(`UPDATE ${SQL.purgeTasks} SET status = 'completed', lease_until = NULL, updated_at = now() WHERE purge_task_id = $1`, [task.purge_task_id])
  await refreshDeletionOperation(transaction, task.deletion_id)
  return 'completed'
}

async function markPurgeFailure(store: PostgresMemoryStore, task: PurgeTaskRow, code: string, now: string): Promise<'retried' | 'failed'> {
  return store.runTransaction(async (transaction) => {
    const status = task.attempts >= task.max_attempts ? 'failed' : 'retry'
    await transaction.query(
      `UPDATE ${SQL.purgeTasks}
       SET status = $2, lease_until = NULL, available_at = $3::timestamptz,
           last_failure = $4, updated_at = now()
       WHERE purge_task_id = $1 AND status = 'running'`,
      [task.purge_task_id, status, status === 'failed' ? now : new Date(Date.parse(now) + Math.min(60_000, 250 * 2 ** Math.max(0, task.attempts - 1))).toISOString(), code.slice(0, 120)],
    )
    await refreshDeletionOperation(transaction, task.deletion_id)
    return status === 'failed' ? 'failed' : 'retried'
  })
}

/** Run a bounded, retrying purge batch. The control ledger and suppression rows remain. */
export async function runPurgeBatch(store: PostgresMemoryStore, options: PurgeBatchOptions = {}): Promise<PurgeBatchResult> {
  const now = ensureTime(options.now ?? isoNow(), 'now')
  const limit = boundedInteger(options.limit, Math.min(MAX_PURGE_TASK_BATCH, 10), MAX_PURGE_TASK_BATCH)
  const leaseUntil = new Date(Date.parse(now) + 30_000).toISOString()
  const tasks = await store.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN')
      const result = await client.query<PurgeTaskRow>(
        `
          WITH picked AS (
            SELECT purge_task_id
            FROM ${SQL.purgeTasks}
            WHERE ($2::text IS NULL OR scope_id = $2)
              AND status IN ('pending', 'retry', 'running')
              AND attempts < max_attempts
              AND available_at <= $1::timestamptz
              AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
            ORDER BY CASE kind
              WHEN 'assertion_version' THEN 10
              WHEN 'projection' THEN 20
              WHEN 'change_feed' THEN 30
              WHEN 'command_receipt' THEN 40
              WHEN 'job' THEN 50
              WHEN 'managed_cache' THEN 60
              WHEN 'source_event' THEN 90
              ELSE 100 END, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $3
          )
          UPDATE ${SQL.purgeTasks} t
          SET status = 'running', attempts = t.attempts + 1, lease_until = $4::timestamptz, updated_at = now()
          FROM picked
          WHERE t.purge_task_id = picked.purge_task_id
          RETURNING t.purge_task_id, t.deletion_id, t.scope_id, t.kind, t.target_id, t.target_revision, t.attempts, t.max_attempts
        `,
        [now, options.scopeId ?? null, limit, leaseUntil],
      )
      await client.query('COMMIT')
      return result.rows
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })
  const result: PurgeBatchResult = { claimed: tasks.length, completed: 0, deferred: 0, retried: 0, failed: 0 }
  for (const task of tasks) {
    try {
      const outcome = await store.runTransaction((transaction) => executePurgeTask(transaction, task, now))
      if (outcome === 'completed') result.completed += 1
      else result.deferred += 1
    } catch (error) {
      const code = error instanceof PostgresMemoryOperationError
        ? error.failure.code
        : typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? `postgres_${error.code}`
          : 'purge_failed'
      const status = await markPurgeFailure(store, task, code, now)
      if (status === 'failed') result.failed += 1
      else result.retried += 1
    }
  }
  return result
}

/** Revoke one app grant by policy epoch; this never deletes canonical data. */
export async function revokeMemoryGrant(
  session: MemorySession,
  grantId: string,
  options: { now?: string; revocationId?: string } = {},
): Promise<{ ok: true; receipt: GrantRevocationReceipt } | { ok: false; receipt: null; failure: MemoryFailure }> {
  try {
    const durable = postgresSession(session)
    const now = ensureTime(options.now ?? isoNow(), 'now')
    const receipt = await durable.store.forSession(durable).runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(durable, 'inspect')
      const epoch = await currentEpoch(transaction, durable.scope.id, 'update')
      const grant = await transaction.query<{ grant_id: string; principal_id: string; revoked_at: string | null }>(
        `SELECT grant_id, principal_id, revoked_at FROM ${SQL.grants} WHERE grant_id = $1 AND scope_id = $2 FOR UPDATE`,
        [grantId, durable.scope.id],
      )
      if (!grant.rows[0] || grant.rows[0].principal_id !== durable.principal.id) throw operationFailure('unauthorized', 'The grant is not owned by this authenticated principal in this scope.', false)
      if (grant.rows[0].revoked_at) throw operationFailure('conflict', 'The grant is already revoked.', false)
      const previousPolicyEpoch = Number(epoch.policy_epoch)
      const newPolicyEpoch = previousPolicyEpoch + 1
      const revocationId = options.revocationId ?? `revocation/${crypto.randomUUID()}`
      await transaction.query(`UPDATE ${SQL.grants} SET revoked_at = $3::timestamptz, expires_at = COALESCE(expires_at, $3::timestamptz) WHERE grant_id = $1 AND scope_id = $2`, [grantId, durable.scope.id, now])
      await transaction.query(`UPDATE ${SQL.epochs} SET policy_epoch = $2, updated_at = now() WHERE scope_id = $1`, [durable.scope.id, newPolicyEpoch])
      await transaction.query(
        `UPDATE ${SQL.jobs}
         SET state = 'dead', lease_until = NULL, worker_id = NULL, last_failure_code = 'revoked_input', updated_at = now()
         WHERE scope_id = $1 AND principal_id = $2 AND state IN ('pending', 'retry')`,
        [durable.scope.id, durable.principal.id],
      )
      await transaction.query(`UPDATE ${SQL.leases} SET status = 'revoked', invalidated_at = $2::timestamptz WHERE scope_id = $1 AND status = 'active'`, [durable.scope.id, now])
      const maxResult = await transaction.query<{ max_sequence: string }>(`SELECT COALESCE(MAX(ledger_sequence), 0) AS max_sequence FROM ${SQL.ledger} WHERE scope_id = $1`, [durable.scope.id])
      const sequence = Number(maxResult.rows[0]?.max_sequence ?? 0) + 1
      await transaction.query(
        `INSERT INTO ${SQL.revocations} (revocation_id, scope_id, actor_principal_id, grant_id, previous_policy_epoch, new_policy_epoch)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [revocationId, durable.scope.id, durable.principal.id, grantId, previousPolicyEpoch, newPolicyEpoch],
      )
      await transaction.query(
        `INSERT INTO ${SQL.ledger}
          (scope_id, ledger_sequence, operation_id, operation_kind, revocation_id, grant_id, policy_epoch, deletion_epoch)
         VALUES ($1, $2, $3, 'grant_revocation', $4, $5, $6, $7)`,
        [durable.scope.id, sequence, revocationId, revocationId, grantId, newPolicyEpoch, Number(epoch.deletion_epoch)],
      )
      return {
        schemaVersion: 1,
        receiptId: `receipt/revocation/${revocationId}`,
        revocationId,
        scopeId: durable.scope.id,
        grantId,
        previousPolicyEpoch,
        newPolicyEpoch,
        revokedAt: now,
        underlyingDataDeleted: false,
        independentScopesUnaffected: true,
      } satisfies GrantRevocationReceipt
    })
    return { ok: true, receipt }
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return { ok: false, receipt: null, failure: error.failure }
    return { ok: false, receipt: null, failure: { code: 'unavailable', message: 'Memory authority is unavailable; the grant revocation was rolled back.', retryable: true } }
  }
}

export async function issuePrivateSnapshotLease(
  session: MemorySession,
  options: { now?: string; ttlMs?: number; leaseId?: string } = {},
): Promise<SnapshotLeaseResult> {
  try {
    const durable = postgresSession(session)
    const now = ensureTime(options.now ?? isoNow(), 'now')
    const ttlMs = boundedInteger(options.ttlMs, DEFAULT_PRIVATE_SNAPSHOT_LEASE_MS, MAX_PRIVATE_SNAPSHOT_LEASE_MS)
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString()
    const lease = await durable.store.forSession(durable).runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(durable, 'recall')
      const epoch = await currentEpoch(transaction, durable.scope.id, 'share')
      const leaseId = options.leaseId ?? `lease/snapshot/${crypto.randomUUID()}`
      await transaction.query(
        `INSERT INTO ${SQL.leases}
          (lease_id, scope_id, principal_id, policy_epoch, deletion_epoch, issued_at, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'active')`,
        [leaseId, durable.scope.id, durable.principal.id, Number(epoch.policy_epoch), Number(epoch.deletion_epoch), now, expiresAt],
      )
      return { schemaVersion: 1, leaseId, scopeId: durable.scope.id, principalId: durable.principal.id, policyEpoch: Number(epoch.policy_epoch), deletionEpoch: Number(epoch.deletion_epoch), issuedAt: now, expiresAt, revocationWindowMs: MAX_PRIVATE_SNAPSHOT_LEASE_MS, status: 'active' } satisfies SnapshotLease
    })
    return { ok: true, lease }
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return failureResult<SnapshotLeaseResult>(error.failure)
    return failureResult<SnapshotLeaseResult>({ code: 'unavailable', message: 'Memory authority is unavailable; no private snapshot lease was issued.', retryable: true })
  }
}

export async function validatePrivateSnapshotLease(
  session: MemorySession,
  leaseId: string,
  options: { now?: string } = {},
): Promise<SnapshotLeaseValidation> {
  const durable = postgresSession(session)
  const now = ensureTime(options.now ?? isoNow(), 'now')
  return durable.store.forSession(durable).runTransaction(async (transaction) => {
    if (session.trust !== 'authenticated' || session.principal.id !== durable.principal.id || session.scope.id !== durable.scope.id) return { valid: false, reason: 'not_found' }
    const rowResult = await transaction.query<{ lease_id: string; scope_id: string; principal_id: string; policy_epoch: string | number; deletion_epoch: string | number; issued_at: string; expires_at: string; status: 'active' | 'expired' | 'revoked' }>(`SELECT * FROM ${SQL.leases} WHERE lease_id = $1 AND scope_id = $2 AND principal_id = $3 FOR UPDATE`, [leaseId, durable.scope.id, durable.principal.id])
    const row = rowResult.rows[0]
    if (!row) return { valid: false, reason: 'not_found' }
    if (row.status !== 'active') return { valid: false, reason: 'revoked' }
    if (Date.parse(row.expires_at) <= Date.parse(now)) {
      await transaction.query(`UPDATE ${SQL.leases} SET status = 'expired', invalidated_at = $2::timestamptz WHERE lease_id = $1`, [leaseId, now])
      return { valid: false, reason: 'expired' }
    }
    const guard = await transaction.query<{ status: string; required_ledger_sequence: string; reconciled_ledger_sequence: string }>(`SELECT status, required_ledger_sequence, reconciled_ledger_sequence FROM ${SQL.recovery} WHERE scope_id = $1`, [durable.scope.id])
    if (guard.rows[0] && (guard.rows[0].status === 'blocked' || Number(guard.rows[0].reconciled_ledger_sequence) < Number(guard.rows[0].required_ledger_sequence))) return { valid: false, reason: 'restore_blocked' }
    const epoch = await currentEpoch(transaction, durable.scope.id, 'share')
    if (Number(epoch.policy_epoch) !== Number(row.policy_epoch) || Number(epoch.deletion_epoch) !== Number(row.deletion_epoch)) {
      await transaction.query(`UPDATE ${SQL.leases} SET status = 'revoked', invalidated_at = $2::timestamptz WHERE lease_id = $1`, [leaseId, now])
      return { valid: false, reason: 'epoch_changed' }
    }
    return {
      valid: true,
      lease: { schemaVersion: 1, leaseId: row.lease_id, scopeId: row.scope_id as ScopeId, principalId: row.principal_id as PrincipalId, policyEpoch: Number(row.policy_epoch), deletionEpoch: Number(row.deletion_epoch), issuedAt: row.issued_at, expiresAt: row.expires_at, revocationWindowMs: MAX_PRIVATE_SNAPSHOT_LEASE_MS, status: 'active' },
    }
  })
}

export async function createMemoryDispatchGuard(session: MemorySession): Promise<MemoryDispatchGuard> {
  const durable = postgresSession(session)
  const baseline = await durable.store.forSession(durable).runTransaction(async (transaction) => {
    await transaction.assertAuthorizedContext(durable, 'recall')
    const epoch = await currentEpoch(transaction, durable.scope.id, 'share')
    return { policyEpoch: Number(epoch.policy_epoch), deletionEpoch: Number(epoch.deletion_epoch) }
  })
  let cancelled = false
  const listeners = new Set<() => void>()
  const cancel = (): void => {
    if (cancelled) return
    cancelled = true
    for (const listener of listeners) listener()
    listeners.clear()
  }
  return {
    async check(): Promise<DispatchGuardCheck> {
      if (cancelled) return { ok: false, reason: 'cancelled' }
      const current = await durable.store.forSession(durable).runTransaction(async (transaction) => {
        const guard = await transaction.query<{ status: string; required_ledger_sequence: string; reconciled_ledger_sequence: string }>(`SELECT status, required_ledger_sequence, reconciled_ledger_sequence FROM ${SQL.recovery} WHERE scope_id = $1`, [durable.scope.id])
        if (guard.rows[0] && (guard.rows[0].status === 'blocked' || Number(guard.rows[0].reconciled_ledger_sequence) < Number(guard.rows[0].required_ledger_sequence))) return 'restore_blocked' as const
        const epoch = await currentEpoch(transaction, durable.scope.id, 'share')
        return Number(epoch.policy_epoch) === baseline.policyEpoch && Number(epoch.deletion_epoch) === baseline.deletionEpoch ? true : false
      })
      if (current === true) return { ok: true }
      cancel()
      return { ok: false, reason: current === 'restore_blocked' ? 'restore_blocked' : 'epoch_changed' }
    },
    onCancel(listener: () => void): () => void {
      if (cancelled) listener()
      else listeners.add(listener)
      return () => listeners.delete(listener)
    },
    cancel,
  }
}

export async function markRestorePending(
  store: PostgresMemoryStore,
  scopeId: ScopeId,
  options: { requiredLedgerSequence?: number; reason?: string } = {},
): Promise<RestoreGuardStatus> {
  return store.runTransaction(async (transaction) => {
    const maxResult = await transaction.query<{ max_sequence: string }>(`SELECT COALESCE(MAX(ledger_sequence), 0) AS max_sequence FROM ${SQL.ledger} WHERE scope_id = $1`, [scopeId])
    const maxSequence = Number(maxResult.rows[0]?.max_sequence ?? 0)
    const requested = options.requiredLedgerSequence ?? maxSequence
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > maxSequence) throw operationFailure('validation', 'A restore guard cannot require a ledger watermark that is not available.', false)
    const current = await transaction.query<{ required_ledger_sequence: string; reconciled_ledger_sequence: string }>(`SELECT required_ledger_sequence, reconciled_ledger_sequence FROM ${SQL.recovery} WHERE scope_id = $1 FOR UPDATE`, [scopeId])
    const required = Math.max(requested, Number(current.rows[0]?.required_ledger_sequence ?? 0))
    const reconciled = Math.min(Number(current.rows[0]?.reconciled_ledger_sequence ?? 0), required)
    await transaction.query(
      `INSERT INTO ${SQL.recovery} (scope_id, status, required_ledger_sequence, reconciled_ledger_sequence, reason, blocked_at)
       VALUES ($1, 'blocked', $2, $3, $4, now())
       ON CONFLICT (scope_id) DO UPDATE SET status = 'blocked', required_ledger_sequence = $2,
         reconciled_ledger_sequence = $3, reason = $4, blocked_at = now(), reconciled_at = NULL`,
      [scopeId, required, reconciled, options.reason ?? 'restore_requires_control_ledger_replay'],
    )
    return { scopeId, status: 'blocked', requiredLedgerSequence: required, reconciledLedgerSequence: reconciled, reason: options.reason ?? 'restore_requires_control_ledger_replay' }
  })
}

export async function reconcileRestoreLedger(store: PostgresMemoryStore, scopeId: ScopeId): Promise<RestoreGuardStatus> {
  return store.runTransaction(async (transaction) => {
    const guardResult = await transaction.query<{ status: 'ready' | 'blocked'; required_ledger_sequence: string; reconciled_ledger_sequence: string; reason: string | null }>(`SELECT status, required_ledger_sequence, reconciled_ledger_sequence, reason FROM ${SQL.recovery} WHERE scope_id = $1 FOR UPDATE`, [scopeId])
    const guard = guardResult.rows[0]
    if (!guard) throw operationFailure('not_found', 'No restore guard exists for this scope.', false)
    const required = Number(guard.required_ledger_sequence)
    let reconciled = Number(guard.reconciled_ledger_sequence)
    const rows = await transaction.query<{ ledger_sequence: string; operation_kind: 'deletion' | 'grant_revocation'; event_id: string | null; assertion_id: string | null; assertion_revision: string | null; grant_id: string | null; policy_epoch: string; deletion_epoch: string }>(
      `SELECT ledger_sequence, operation_kind, event_id, assertion_id, assertion_revision, grant_id, policy_epoch, deletion_epoch
       FROM ${SQL.ledger} WHERE scope_id = $1 AND ledger_sequence > $2 AND ledger_sequence <= $3 ORDER BY ledger_sequence`,
      [scopeId, reconciled, required],
    )
    if (rows.rows.length !== required - reconciled) throw operationFailure('unavailable', 'The restore control ledger has a gap; memory remains blocked.', true, { reason: 'control_ledger_gap' })
    for (const row of rows.rows) {
      if (row.operation_kind === 'deletion') {
        if (row.event_id) {
          await transaction.query(
            `INSERT INTO ${SQL.suppressions} (suppression_id, scope_id, event_id, policy_epoch, deletion_epoch, reason)
             VALUES ($1, $2, $3, $4, $5, 'recovery_replay') ON CONFLICT DO NOTHING`,
            [`recovery/${scopeId}/${row.ledger_sequence}`, scopeId, row.event_id, Number(row.policy_epoch), Number(row.deletion_epoch)],
          )
        } else if (row.assertion_id && row.assertion_revision) {
          await transaction.query(
            `INSERT INTO ${SQL.suppressions} (suppression_id, scope_id, assertion_id, assertion_revision, policy_epoch, deletion_epoch, reason)
             VALUES ($1, $2, $3, $4, $5, $6, 'recovery_replay') ON CONFLICT DO NOTHING`,
            [`recovery/${scopeId}/${row.ledger_sequence}`, scopeId, row.assertion_id, Number(row.assertion_revision), Number(row.policy_epoch), Number(row.deletion_epoch)],
          )
          // A restored backup predates the deletion and still carries the
          // content-derived canonical key; replay removes it with the status.
          await transaction.query(
            `UPDATE ${SQL.assertions} SET current_status = 'deleted', canonical_key = NULL, updated_at = now() WHERE scope_id = $1 AND assertion_id = $2`,
            [scopeId, row.assertion_id],
          )
        }
      } else if (row.grant_id) {
        await transaction.query(`UPDATE ${SQL.grants} SET revoked_at = COALESCE(revoked_at, now()) WHERE scope_id = $1 AND grant_id = $2`, [scopeId, row.grant_id])
      }
      await transaction.query(`UPDATE ${SQL.epochs} SET policy_epoch = GREATEST(policy_epoch, $2), deletion_epoch = GREATEST(deletion_epoch, $3), updated_at = now() WHERE scope_id = $1`, [scopeId, Number(row.policy_epoch), Number(row.deletion_epoch)])
      reconciled = Number(row.ledger_sequence)
    }
    await transaction.query(`UPDATE ${SQL.recovery} SET status = 'ready', reconciled_ledger_sequence = $2, reconciled_at = now() WHERE scope_id = $1`, [scopeId, required])
    return { scopeId, status: 'ready', requiredLedgerSequence: required, reconciledLedgerSequence: required, reason: guard.reason }
  })
}

export async function readRestoreGuardStatus(store: PostgresMemoryStore, scopeId: ScopeId): Promise<RestoreGuardStatus> {
  return store.runTransaction(async (transaction) => {
    const result = await transaction.query<{ status: 'ready' | 'blocked'; required_ledger_sequence: string; reconciled_ledger_sequence: string; reason: string | null }>(`SELECT status, required_ledger_sequence, reconciled_ledger_sequence, reason FROM ${SQL.recovery} WHERE scope_id = $1`, [scopeId])
    const row = result.rows[0]
    return row
      ? { scopeId, status: row.status, requiredLedgerSequence: Number(row.required_ledger_sequence), reconciledLedgerSequence: Number(row.reconciled_ledger_sequence), reason: row.reason }
      : { scopeId, status: 'ready', requiredLedgerSequence: 0, reconciledLedgerSequence: 0, reason: null }
  })
}
