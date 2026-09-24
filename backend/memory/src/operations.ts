import type { Pool } from 'pg'
import { MEMORY_SCHEMA } from './config.ts'
import type { PostgresMemoryStore } from './postgres.ts'

/**
 * Stage 14 operational surface: counts-only metrics, alert evaluation and the
 * independent copy of the deletion control ledger that a restore replays.
 *
 * Nothing here returns memory text, event payloads, quotes, owner ids or
 * connection details. Metrics are counts and ages; the ledger carries only
 * ids, revisions and epochs (as the ledger itself does).
 */

const T = {
  jobs: `${MEMORY_SCHEMA}.jobs`,
  events: `${MEMORY_SCHEMA}.events`,
  purge: `${MEMORY_SCHEMA}.purge_tasks`,
  deletions: `${MEMORY_SCHEMA}.deletion_operations`,
  projections: `${MEMORY_SCHEMA}.projections`,
  recovery: `${MEMORY_SCHEMA}.recovery_guards`,
  commands: `${MEMORY_SCHEMA}.command_receipts`,
  versions: `${MEMORY_SCHEMA}.assertion_versions`,
  suppressions: `${MEMORY_SCHEMA}.deletion_suppressions`,
  ledger: `${MEMORY_SCHEMA}.control_ledger`,
  scopes: `${MEMORY_SCHEMA}.scopes`,
} as const

export interface QueueMetrics {
  pending: number
  retry: number
  running: number
  /** Running with an expired lease: a worker died or stalled holding it. */
  expiredLeases: number
  dead: number
  oldestWaitingSeconds: number | null
}

export interface MemoryMetrics {
  at: string
  scopes: number
  interpret: QueueMetrics
  projection: QueueMetrics
  /** Committed user turns in the last day that were not queued for learning (backpressure). */
  uninterpretedTurns24h: number
  staleProjections: { count: number; oldestSeconds: number | null }
  purge: { pending: number; failed: number; oldestPendingSeconds: number | null }
  /** Deletions whose logical block committed but whose physical purge has not finished. */
  deletionsAwaitingPurge: { count: number; oldestSeconds: number | null }
  restoreBlockedScopes: number
  /** Accepted explicit commands in the last day whose exact version is gone without a deletion. Must be 0. */
  lostAcceptedCommands24h: number
}

const seconds = (value: string | null | undefined, now: string): number | null =>
  value ? Math.max(0, Math.round((Date.parse(now) - Date.parse(value)) / 1000)) : null

async function queue(pool: Pool, kind: 'interpret_event' | 'rebuild_projection', now: string): Promise<QueueMetrics> {
  const result = await pool.query<{ pending: string; retry: string; running: string; expired: string; dead: string; oldest: string | null }>(
    `SELECT
       count(*) FILTER (WHERE state = 'pending') AS pending,
       count(*) FILTER (WHERE state = 'retry') AS retry,
       count(*) FILTER (WHERE state = 'running') AS running,
       count(*) FILTER (WHERE state = 'running' AND lease_until < $2::timestamptz) AS expired,
       count(*) FILTER (WHERE state = 'dead') AS dead,
       min(available_at) FILTER (WHERE state IN ('pending', 'retry')) AS oldest
     FROM ${T.jobs} WHERE kind = $1`,
    [kind, now],
  )
  const row = result.rows[0]
  return {
    pending: Number(row?.pending ?? 0),
    retry: Number(row?.retry ?? 0),
    running: Number(row?.running ?? 0),
    expiredLeases: Number(row?.expired ?? 0),
    dead: Number(row?.dead ?? 0),
    oldestWaitingSeconds: seconds(row?.oldest, now),
  }
}

/** Counts and ages across all scopes; safe to export to a metrics system. */
export async function collectMemoryMetrics(pool: Pool, options: { now?: string } = {}): Promise<MemoryMetrics> {
  const now = options.now ?? new Date().toISOString()
  const [interpret, projection] = await Promise.all([queue(pool, 'interpret_event', now), queue(pool, 'rebuild_projection', now)])
  const other = await pool.query<{
    scopes: string; uninterpreted: string; stale: string; stale_oldest: string | null
    purge_pending: string; purge_failed: string; purge_oldest: string | null
    awaiting: string; awaiting_oldest: string | null; blocked: string; lost: string
  }>(
    `SELECT
       (SELECT count(*) FROM ${T.scopes}) AS scopes,
       (SELECT count(*) FROM ${T.events} e
          WHERE e.source_kind = 'user_statement' AND e.committed_phase = 'committed'
            AND e.envelope #> '{payload,commandId}' IS NULL
            AND e.received_at > $1::timestamptz - interval '1 day'
            AND NOT EXISTS (SELECT 1 FROM ${T.jobs} j WHERE j.input_event_id = e.event_id AND j.kind = 'interpret_event')) AS uninterpreted,
       (SELECT count(*) FROM ${T.projections} WHERE freshness = 'stale') AS stale,
       (SELECT min(updated_at) FROM ${T.projections} WHERE freshness = 'stale') AS stale_oldest,
       (SELECT count(*) FROM ${T.purge} WHERE status IN ('pending', 'retry', 'running')) AS purge_pending,
       (SELECT count(*) FROM ${T.purge} WHERE status = 'failed') AS purge_failed,
       (SELECT min(available_at) FROM ${T.purge} WHERE status IN ('pending', 'retry', 'running')) AS purge_oldest,
       (SELECT count(*) FROM ${T.deletions} WHERE status IN ('logical_blocked', 'purge_pending')) AS awaiting,
       (SELECT min(logical_blocked_at) FROM ${T.deletions} WHERE status IN ('logical_blocked', 'purge_pending')) AS awaiting_oldest,
       (SELECT count(*) FROM ${T.recovery} WHERE status = 'blocked' OR reconciled_ledger_sequence < required_ledger_sequence) AS blocked,
       (SELECT count(*) FROM ${T.commands} c
          WHERE c.outcome = 'accepted' AND c.created_at > $1::timestamptz - interval '1 day'
            AND NOT EXISTS (SELECT 1 FROM ${T.versions} v WHERE v.scope_id = c.scope_id AND v.assertion_id = c.assertion_id AND v.revision = c.assertion_revision)
            AND NOT EXISTS (SELECT 1 FROM ${T.suppressions} s WHERE s.scope_id = c.scope_id AND s.assertion_id = c.assertion_id)) AS lost`,
    [now],
  )
  const row = other.rows[0]!
  return {
    at: now,
    scopes: Number(row.scopes),
    interpret,
    projection,
    uninterpretedTurns24h: Number(row.uninterpreted),
    staleProjections: { count: Number(row.stale), oldestSeconds: seconds(row.stale_oldest, now) },
    purge: { pending: Number(row.purge_pending), failed: Number(row.purge_failed), oldestPendingSeconds: seconds(row.purge_oldest, now) },
    deletionsAwaitingPurge: { count: Number(row.awaiting), oldestSeconds: seconds(row.awaiting_oldest, now) },
    restoreBlockedScopes: Number(row.blocked),
    lostAcceptedCommands24h: Number(row.lost),
  }
}

export interface MemoryAlertThresholds {
  learningBacklogWarnSeconds: number
  learningBacklogCriticalSeconds: number
  purgeOverdueSeconds: number
  staleProjectionCount: number
  staleProjectionSeconds: number
}

/** Chosen from the Stage 14 measurements; see docs/memory/operations/runbook.md. */
export const DEFAULT_MEMORY_ALERT_THRESHOLDS: MemoryAlertThresholds = Object.freeze({
  learningBacklogWarnSeconds: 15 * 60,
  learningBacklogCriticalSeconds: 60 * 60,
  purgeOverdueSeconds: 60 * 60,
  staleProjectionCount: 100,
  staleProjectionSeconds: 60 * 60,
})

export interface MemoryAlert {
  name: string
  severity: 'warning' | 'critical'
  value: number
  threshold: number
}

export function evaluateMemoryAlerts(metrics: MemoryMetrics, thresholds: MemoryAlertThresholds = DEFAULT_MEMORY_ALERT_THRESHOLDS): MemoryAlert[] {
  const alerts: MemoryAlert[] = []
  const raise = (name: string, severity: MemoryAlert['severity'], value: number | null, threshold: number, when: (value: number) => boolean) => {
    if (value !== null && when(value)) alerts.push({ name, severity, value, threshold })
  }
  // Correctness and privacy obligations first.
  raise('lost_accepted_commands', 'critical', metrics.lostAcceptedCommands24h, 0, (value) => value > 0)
  raise('restore_blocked', 'critical', metrics.restoreBlockedScopes, 0, (value) => value > 0)
  raise('purge_failed', 'critical', metrics.purge.failed, 0, (value) => value > 0)
  raise('purge_overdue', 'critical', metrics.deletionsAwaitingPurge.oldestSeconds, thresholds.purgeOverdueSeconds, (value) => value > thresholds.purgeOverdueSeconds)
  // Throughput.
  const oldest = metrics.interpret.oldestWaitingSeconds
  if (oldest !== null && oldest > thresholds.learningBacklogCriticalSeconds) raise('learning_backlog_age', 'critical', oldest, thresholds.learningBacklogCriticalSeconds, () => true)
  else raise('learning_backlog_age', 'warning', oldest, thresholds.learningBacklogWarnSeconds, (value) => value > thresholds.learningBacklogWarnSeconds)
  raise('dead_jobs', 'warning', metrics.interpret.dead + metrics.projection.dead, 0, (value) => value > 0)
  raise('expired_leases', 'warning', metrics.interpret.expiredLeases + metrics.projection.expiredLeases, 0, (value) => value > 0)
  raise('uninterpreted_turns', 'warning', metrics.uninterpretedTurns24h, 0, (value) => value > 0)
  raise('stale_projections', 'warning', metrics.staleProjections.count, thresholds.staleProjectionCount, (value) => value > thresholds.staleProjectionCount)
  raise('stale_projection_age', 'warning', metrics.staleProjections.oldestSeconds, thresholds.staleProjectionSeconds, (value) => value > thresholds.staleProjectionSeconds)
  return alerts
}

// ---------------------------------------------------------------------------
// Independent control ledger
// ---------------------------------------------------------------------------

export interface ControlLedgerRow {
  scopeId: string
  ledgerSequence: number
  operationId: string
  operationKind: 'deletion' | 'grant_revocation'
  deletionId: string | null
  revocationId: string | null
  eventId: string | null
  assertionId: string | null
  assertionRevision: number | null
  grantId: string | null
  policyEpoch: number
  deletionEpoch: number
}

export interface ControlLedgerExport {
  format: 'gideon-control-ledger'
  version: 1
  exportedAt: string
  rows: ControlLedgerRow[]
}

/**
 * Ledger rows after the given per-scope watermarks, for shipping to storage
 * that a database restore does not roll back. A restore from a backup that
 * predates a deletion has lost the very rows it must replay; this copy is
 * where they come from.
 */
export async function exportControlLedger(store: PostgresMemoryStore, options: { after?: Readonly<Record<string, number>>; limit?: number } = {}): Promise<ControlLedgerExport> {
  const after = options.after ?? {}
  const limit = Math.min(Math.max(options.limit ?? 10_000, 1), 100_000)
  const result = await store.pool.query<{
    scope_id: string; ledger_sequence: string; operation_id: string; operation_kind: 'deletion' | 'grant_revocation'
    deletion_id: string | null; revocation_id: string | null; event_id: string | null; assertion_id: string | null
    assertion_revision: string | null; grant_id: string | null; policy_epoch: string; deletion_epoch: string
  }>(
    `SELECT l.* FROM ${T.ledger} l
     WHERE l.ledger_sequence > COALESCE(($1::jsonb ->> l.scope_id)::bigint, 0)
     ORDER BY l.scope_id, l.ledger_sequence
     LIMIT $2`,
    [JSON.stringify(after), limit],
  )
  return {
    format: 'gideon-control-ledger',
    version: 1,
    exportedAt: new Date().toISOString(),
    rows: result.rows.map((row) => ({
      scopeId: row.scope_id,
      ledgerSequence: Number(row.ledger_sequence),
      operationId: row.operation_id,
      operationKind: row.operation_kind,
      deletionId: row.deletion_id,
      revocationId: row.revocation_id,
      eventId: row.event_id,
      assertionId: row.assertion_id,
      assertionRevision: row.assertion_revision === null ? null : Number(row.assertion_revision),
      grantId: row.grant_id,
      policyEpoch: Number(row.policy_epoch),
      deletionEpoch: Number(row.deletion_epoch),
    })),
  }
}

export interface ControlLedgerImportResult {
  inserted: number
  alreadyPresent: number
  /** Scopes that do not exist in this database hold no data to protect. */
  skippedUnknownScopes: number
  /** Highest imported sequence per scope; pass each to `markRestorePending`. */
  requiredBySequence: Record<string, number>
}

/**
 * Loads an exported ledger into a restored database, in one transaction.
 * A different row already at the same sequence means the two ledgers have
 * diverged; that is refused rather than merged.
 */
export async function importControlLedger(store: PostgresMemoryStore, document: unknown): Promise<ControlLedgerImportResult> {
  const doc = document as Partial<ControlLedgerExport> | null
  if (!doc || doc.format !== 'gideon-control-ledger' || doc.version !== 1 || !Array.isArray(doc.rows)) throw new Error('Not a control ledger export.')
  const rows = doc.rows
  for (const row of rows) {
    if (!row || typeof row.scopeId !== 'string' || !Number.isSafeInteger(row.ledgerSequence) || row.ledgerSequence < 1
      || (row.operationKind !== 'deletion' && row.operationKind !== 'grant_revocation')
      || !Number.isSafeInteger(row.policyEpoch) || !Number.isSafeInteger(row.deletionEpoch)) throw new Error('Malformed control ledger row.')
  }
  return store.runTransaction(async (transaction) => {
    const result: ControlLedgerImportResult = { inserted: 0, alreadyPresent: 0, skippedUnknownScopes: 0, requiredBySequence: {} }
    const known = await transaction.query<{ scope_id: string }>(`SELECT scope_id FROM ${T.scopes} WHERE scope_id = ANY($1::text[])`, [[...new Set(rows.map((row) => row.scopeId))]])
    const scopes = new Set(known.rows.map((row) => row.scope_id))
    for (const row of rows) {
      if (!scopes.has(row.scopeId)) { result.skippedUnknownScopes += 1; continue }
      const existing = await transaction.query<{ operation_id: string; event_id: string | null; assertion_id: string | null; assertion_revision: string | null; grant_id: string | null }>(
        `SELECT operation_id, event_id, assertion_id, assertion_revision, grant_id FROM ${T.ledger} WHERE scope_id = $1 AND ledger_sequence = $2`,
        [row.scopeId, row.ledgerSequence],
      )
      const present = existing.rows[0]
      if (present) {
        const same = present.operation_id === row.operationId && present.event_id === row.eventId && present.assertion_id === row.assertionId
          && (present.assertion_revision === null ? null : Number(present.assertion_revision)) === row.assertionRevision && present.grant_id === row.grantId
        if (!same) throw new Error('The restored control ledger diverges from the exported one; refusing to merge.')
        result.alreadyPresent += 1
      } else {
        await transaction.query(
          `INSERT INTO ${T.ledger} (scope_id, ledger_sequence, operation_id, operation_kind, deletion_id, revocation_id, event_id, assertion_id, assertion_revision, grant_id, policy_epoch, deletion_epoch)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [row.scopeId, row.ledgerSequence, row.operationId, row.operationKind, row.deletionId, row.revocationId, row.eventId, row.assertionId, row.assertionRevision, row.grantId, row.policyEpoch, row.deletionEpoch],
        )
        result.inserted += 1
      }
      result.requiredBySequence[row.scopeId] = Math.max(result.requiredBySequence[row.scopeId] ?? 0, row.ledgerSequence)
    }
    return result
  })
}
