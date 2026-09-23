import { parseEventEnvelope, type AssertionCommit, type EventEnvelope, type MemoryFailure, type PrincipalId, type ScopeId } from '../../../src/lib/memory/contracts.ts'
import { MEMORY_SCHEMA } from './config.ts'
import { PostgresMemoryStore, type PostgresMemoryTransaction } from './postgres.ts'
import { isoNow, revisionId } from './serialization.ts'

const JOBS = `${MEMORY_SCHEMA}.jobs`
const EVENTS = `${MEMORY_SCHEMA}.events`
const RECEIPTS = `${MEMORY_SCHEMA}.receipts`
const EPOCHS = `${MEMORY_SCHEMA}.policy_epochs`
const SUPPRESSIONS = `${MEMORY_SCHEMA}.deletion_suppressions`
const RECOVERY_GUARDS = `${MEMORY_SCHEMA}.recovery_guards`

export const DEFAULT_JOB_LEASE_MS = 30_000
export const MAX_JOB_BATCH = 100
export const MAX_JOB_ATTEMPTS = 5

export type MemoryJobKind = 'interpret_event' | 'rebuild_projection'

export interface ClaimedMemoryJob {
  jobId: string
  kind: MemoryJobKind
  scopeId: ScopeId
  principalId: PrincipalId
  inputEventId: EventEnvelope['id']
  event: EventEnvelope
  attempt: number
  fence: number
  leasedUntil: string
  policyEpoch: number
  deletionEpoch: number
}

export interface ClaimJobsOptions {
  workerId: string
  limit?: number
  scopeId?: ScopeId
  now?: string
  leaseMs?: number
  /** Only these job kinds; default all. */
  kinds?: readonly MemoryJobKind[]
  /** Leave jobs younger than this unclaimed so same-turn explicit commands land first. */
  minAgeMs?: number
  /** Per-scope fairness: at most this many jobs of one scope per claim. */
  perScopeLimit?: number
}

export type JobFailureCode = 'transient_provider' | 'invalid_payload' | 'revoked_input' | 'permanent_invalid' | 'shutdown'

export interface JobFailure {
  code: JobFailureCode
  retryable: boolean
}

export type JobCompletion =
  | { status: 'completed'; revision: number }
  | { status: 'retry_scheduled'; attempt: number; availableAt: string }
  | { status: 'dead'; failure: JobFailure | MemoryFailure }
  | { status: 'lease_lost'; failure: MemoryFailure }

export interface JobResult {
  assertion: AssertionCommit
}

function positiveInteger(value: number, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return fallback
  return Math.min(value, maximum)
}

function leaseLost(): JobCompletion {
  return {
    status: 'lease_lost',
    failure: { code: 'conflict', message: 'The job lease was replaced before completion.', retryable: true },
  }
}

function backoffMs(attempt: number): number {
  return Math.min(30 * 60_000, 250 * 2 ** Math.max(0, attempt - 1))
}

function safeFailureCode(failure: JobFailure | MemoryFailure): string {
  return failure.code
}

export async function claimJobs(store: PostgresMemoryStore, options: ClaimJobsOptions): Promise<readonly ClaimedMemoryJob[]> {
  const workerId = options.workerId.trim()
  if (!workerId || workerId.length > 160) throw new Error('A bounded worker id is required.')
  const limit = positiveInteger(options.limit ?? 1, 1, MAX_JOB_BATCH)
  const now = options.now ?? isoNow()
  const leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_JOB_LEASE_MS, DEFAULT_JOB_LEASE_MS, 15 * 60_000)
  const leasedUntil = new Date(Date.parse(now) + leaseMs).toISOString()
  const settledBefore = options.minAgeMs ? new Date(Date.parse(now) - Math.max(0, Math.min(options.minAgeMs, 60 * 60_000))).toISOString() : null
  const perScope = positiveInteger(options.perScopeLimit ?? MAX_JOB_BATCH, MAX_JOB_BATCH, MAX_JOB_BATCH)
  const kinds = options.kinds?.length ? [...options.kinds] : null

  return store.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN')
      const result = await client.query<{
        job_id: string
        kind: MemoryJobKind
        scope_id: string
        principal_id: string
        input_event_id: string
        attempts: number
        fence: string | number
        lease_until: string
        policy_epoch: string | number
        deletion_epoch: string | number
      }>(
        `
          WITH eligible AS (
            SELECT job_id, row_number() OVER (PARTITION BY scope_id ORDER BY available_at, created_at) AS scope_rank
            FROM ${JOBS}
            WHERE ($2::text IS NULL OR scope_id = $2)
              AND state IN ('pending', 'retry', 'running')
              AND available_at <= $1::timestamptz
              AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
              AND ($6::text[] IS NULL OR kind = ANY($6::text[]))
              AND ($7::timestamptz IS NULL OR available_at <= $7::timestamptz)
              AND NOT EXISTS (
                SELECT 1 FROM ${SUPPRESSIONS} s
                WHERE s.scope_id = ${JOBS}.scope_id AND s.event_id = ${JOBS}.input_event_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${RECOVERY_GUARDS} g
                WHERE g.scope_id = ${JOBS}.scope_id
                  AND (g.status = 'blocked' OR g.reconciled_ledger_sequence < g.required_ledger_sequence)
              )
          ),
          picked AS (
            SELECT job_id
            FROM ${JOBS}
            WHERE job_id IN (SELECT job_id FROM eligible WHERE scope_rank <= $8)
            ORDER BY available_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $3
          )
          UPDATE ${JOBS} j
          SET state = 'running', attempts = j.attempts + 1, lease_until = $4::timestamptz,
              fence = j.fence + 1, worker_id = $5, updated_at = now()
          FROM picked
          WHERE j.job_id = picked.job_id
          RETURNING j.job_id, j.kind, j.scope_id, j.principal_id, j.input_event_id, j.attempts,
                    j.fence, j.lease_until, j.policy_epoch, j.deletion_epoch
        `,
        [now, options.scopeId ?? null, limit, leasedUntil, workerId, kinds, settledBefore, perScope],
      )
      const jobs: ClaimedMemoryJob[] = []
      for (const row of result.rows) {
        const event = await client.query<{ envelope: unknown }>(
          `SELECT envelope FROM ${EVENTS} WHERE event_id = $1 AND scope_id = $2`,
          [row.input_event_id, row.scope_id],
        )
        const envelope = event.rows[0]?.envelope
        if (!envelope || typeof envelope !== 'object') throw new Error('A claimed job has no valid source event.')
        const parsed = parseEventEnvelope(envelope)
        if (!parsed.ok) throw new Error('A claimed job has an invalid source event.')
        jobs.push({
          jobId: row.job_id,
          kind: row.kind,
          scopeId: row.scope_id as ScopeId,
          principalId: row.principal_id as PrincipalId,
          inputEventId: row.input_event_id as EventEnvelope['id'],
          event: parsed.value,
          attempt: row.attempts,
          fence: Number(row.fence),
          leasedUntil: row.lease_until,
          policyEpoch: Number(row.policy_epoch),
          deletionEpoch: Number(row.deletion_epoch),
        })
      }
      await client.query('COMMIT')
      return jobs
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })
}

export async function completeJob(
  store: PostgresMemoryStore,
  job: ClaimedMemoryJob,
  result: JobResult,
  options: { now?: string } = {},
): Promise<JobCompletion> {
  const now = options.now ?? isoNow()
  const scoped = store.forContext({ principalId: job.principalId, scopeId: job.scopeId, policyEpoch: job.policyEpoch })
  return scoped.runTransaction(async (transaction) => {
    const locked = await transaction.query<{
      state: string
      worker_id: string | null
      fence: string | number
      lease_until: string | null
      attempts: number
      max_attempts: number
      input_event_id: string
      policy_epoch: string | number
      deletion_epoch: string | number
      recovery_status: string
      required_ledger_sequence: string | number
      reconciled_ledger_sequence: string | number
    }>(
      `
        SELECT j.state, j.worker_id, j.fence, j.lease_until, j.attempts, j.max_attempts, j.input_event_id,
               j.policy_epoch, j.deletion_epoch, COALESCE(g.status, 'ready') AS recovery_status,
               COALESCE(g.required_ledger_sequence, 0) AS required_ledger_sequence,
               COALESCE(g.reconciled_ledger_sequence, 0) AS reconciled_ledger_sequence
        FROM ${JOBS} j
        LEFT JOIN ${RECOVERY_GUARDS} g ON g.scope_id = j.scope_id
        WHERE j.job_id = $1 AND j.scope_id = $2
        FOR UPDATE OF j
      `,
      [job.jobId, job.scopeId],
    )
    const row = locked.rows[0]
    if (!row || row.state !== 'running' || Number(row.fence) !== job.fence || row.input_event_id !== job.inputEventId || !row.lease_until || Date.parse(row.lease_until) <= Date.parse(now)) {
      return leaseLost()
    }
    const epoch = await transaction.query<{ policy_epoch: string; deletion_epoch: string }>(
      `SELECT policy_epoch, deletion_epoch FROM ${EPOCHS} WHERE scope_id = $1 FOR SHARE`,
      [job.scopeId],
    )
    if (!epoch.rows[0] || Number(epoch.rows[0].policy_epoch) !== Number(row.policy_epoch) || Number(epoch.rows[0].deletion_epoch) !== Number(row.deletion_epoch)
      || row.recovery_status !== 'ready' || Number(row.reconciled_ledger_sequence) < Number(row.required_ledger_sequence)) {
      const revoked: JobFailure = { code: 'revoked_input', retryable: false }
      await markDead(transaction, job.jobId, revoked)
      return { status: 'dead', failure: revoked }
    }

    const commit = result.assertion.slot
      ? await transaction.withSlotLock(job.scopeId, result.assertion.slot, () => transaction.commitAssertion(result.assertion))
      : await transaction.commitAssertion(result.assertion)
    if (!commit.ok) {
      const dead: JobFailure | MemoryFailure = commit.failure.code === 'conflict' && commit.failure.retryable
        ? { code: 'transient_provider', retryable: true }
        : commit.failure
      if (dead.retryable && row.attempts < row.max_attempts) return scheduleRetry(transaction, job.jobId, row.attempts, dead, now)
      await markDead(transaction, job.jobId, dead)
      return { status: 'dead', failure: dead }
    }

    await transaction.query(
      `
        UPDATE ${JOBS}
        SET state = 'completed', lease_until = NULL, worker_id = NULL, completed_at = $2::timestamptz,
            updated_at = now(), last_failure_code = NULL
        WHERE job_id = $1 AND fence = $3
      `,
      [job.jobId, now, job.fence],
    )
    const receipt = {
      schemaVersion: 1 as const,
      receiptId: `receipt/${job.inputEventId}`,
      eventId: job.inputEventId,
      receivedAt: job.event.receivedAt,
      ok: true as const,
      state: 'accepted' as const,
      canonicalRevision: revisionId(result.assertion.assertion.id, commit.revision),
      indexWatermark: null,
    }
    await transaction.query(
      `UPDATE ${RECEIPTS} SET state = 'accepted', receipt = $2::jsonb, updated_at = now() WHERE event_id = $1`,
      [job.inputEventId, JSON.stringify(receipt)],
    )
    return { status: 'completed', revision: commit.revision }
  })
}

export async function failJob(
  store: PostgresMemoryStore,
  job: ClaimedMemoryJob,
  jobFailure: JobFailure,
  options: { now?: string } = {},
): Promise<JobCompletion> {
  const now = options.now ?? isoNow()
  const scoped = store.forContext({ principalId: job.principalId, scopeId: job.scopeId, policyEpoch: job.policyEpoch })
  return scoped.runTransaction(async (transaction) => {
    const locked = await transaction.query<{ state: string; worker_id: string | null; fence: string | number; lease_until: string | null; attempts: number; max_attempts: number }>(
      `SELECT state, worker_id, fence, lease_until, attempts, max_attempts FROM ${JOBS} WHERE job_id = $1 AND scope_id = $2 FOR UPDATE`,
      [job.jobId, job.scopeId],
    )
    const row = locked.rows[0]
    if (!row || row.state !== 'running' || Number(row.fence) !== job.fence || !row.lease_until || Date.parse(row.lease_until) <= Date.parse(now)) return leaseLost()
    if (jobFailure.retryable && row.attempts < row.max_attempts) return scheduleRetry(transaction, job.jobId, row.attempts, jobFailure, now)
    await markDead(transaction, job.jobId, jobFailure)
    return { status: 'dead', failure: jobFailure }
  })
}

async function scheduleRetry(
  transaction: { query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(text: string, values?: readonly unknown[]): Promise<import('pg').QueryResult<T>> },
  jobId: string,
  attempt: number,
  jobFailure: JobFailure | MemoryFailure,
  now: string,
): Promise<JobCompletion> {
  const availableAt = new Date(Date.parse(now) + backoffMs(attempt)).toISOString()
  await transaction.query(
    `
      UPDATE ${JOBS}
      SET state = 'retry', available_at = $2::timestamptz, lease_until = NULL, worker_id = NULL,
          last_failure_code = $3, updated_at = now()
      WHERE job_id = $1
    `,
    [jobId, availableAt, safeFailureCode(jobFailure)],
  )
  return { status: 'retry_scheduled', attempt, availableAt }
}

async function markDead(
  transaction: { query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(text: string, values?: readonly unknown[]): Promise<import('pg').QueryResult<T>> },
  jobId: string,
  jobFailure: JobFailure | MemoryFailure,
): Promise<void> {
  await transaction.query(
    `
      UPDATE ${JOBS}
      SET state = 'dead', lease_until = NULL, worker_id = NULL, last_failure_code = $2, updated_at = now()
      WHERE job_id = $1
    `,
    [jobId, safeFailureCode(jobFailure)],
  )
}

type QueryRunner = Pick<PostgresMemoryTransaction, 'query'>

export type RunningJobCheck =
  | { status: 'ok'; attempts: number; maxAttempts: number }
  | { status: 'lease_lost' }
  /** Policy/grant changed, restore is pending, or the input itself was deleted. */
  | { status: 'revoked' }
  /** Only the deletion epoch moved and the input survives: recompute, do not commit. */
  | { status: 'stale_epoch'; policyEpoch: number; deletionEpoch: number; attempts: number; maxAttempts: number }

/**
 * Locks a claimed job inside the caller's transaction and rechecks its fence,
 * lease, epochs, restore guard and input suppression. Callers that computed
 * outside the transaction (model calls) must commit nothing unless this is ok.
 */
export async function checkRunningJob(transaction: QueryRunner, job: ClaimedMemoryJob, now: string): Promise<RunningJobCheck> {
  const locked = await transaction.query<{
    state: string; fence: string | number; lease_until: string | null; attempts: number; max_attempts: number; input_event_id: string
    policy_epoch: string | number; deletion_epoch: string | number
    recovery_status: string; required_ledger_sequence: string | number; reconciled_ledger_sequence: string | number
    current_policy_epoch: string | number | null; current_deletion_epoch: string | number | null; suppressed: boolean
  }>(
    `
      SELECT j.state, j.fence, j.lease_until, j.attempts, j.max_attempts, j.input_event_id,
             j.policy_epoch, j.deletion_epoch, COALESCE(g.status, 'ready') AS recovery_status,
             COALESCE(g.required_ledger_sequence, 0) AS required_ledger_sequence,
             COALESCE(g.reconciled_ledger_sequence, 0) AS reconciled_ledger_sequence,
             e.policy_epoch AS current_policy_epoch, e.deletion_epoch AS current_deletion_epoch,
             EXISTS (SELECT 1 FROM ${SUPPRESSIONS} s WHERE s.scope_id = j.scope_id AND s.event_id = j.input_event_id) AS suppressed
      FROM ${JOBS} j
      LEFT JOIN ${RECOVERY_GUARDS} g ON g.scope_id = j.scope_id
      LEFT JOIN ${EPOCHS} e ON e.scope_id = j.scope_id
      WHERE j.job_id = $1 AND j.scope_id = $2
      FOR UPDATE OF j
    `,
    [job.jobId, job.scopeId],
  )
  const row = locked.rows[0]
  if (!row || row.state !== 'running' || Number(row.fence) !== job.fence || row.input_event_id !== job.inputEventId || !row.lease_until || Date.parse(row.lease_until) <= Date.parse(now)) {
    return { status: 'lease_lost' }
  }
  if (row.suppressed || row.current_policy_epoch === null || Number(row.current_policy_epoch) !== Number(row.policy_epoch)
    || row.recovery_status !== 'ready' || Number(row.reconciled_ledger_sequence) < Number(row.required_ledger_sequence)) {
    return { status: 'revoked' }
  }
  if (Number(row.current_deletion_epoch) !== Number(row.deletion_epoch)) {
    return { status: 'stale_epoch', policyEpoch: Number(row.current_policy_epoch), deletionEpoch: Number(row.current_deletion_epoch), attempts: row.attempts, maxAttempts: row.max_attempts }
  }
  return { status: 'ok', attempts: row.attempts, maxAttempts: row.max_attempts }
}

/** Completes a checked job without requiring an assertion (a no-op interpretation is a valid result). */
export async function finishCheckedJob(transaction: QueryRunner, job: ClaimedMemoryJob, now: string): Promise<void> {
  await transaction.query(
    `UPDATE ${JOBS} SET state = 'completed', lease_until = NULL, worker_id = NULL, completed_at = $2::timestamptz, updated_at = now(), last_failure_code = NULL WHERE job_id = $1 AND fence = $3`,
    [job.jobId, now, job.fence],
  )
}

/**
 * Returns a checked job to the queue without spending an attempt: used for
 * budget deferral and for recomputing after an unrelated deletion moved the
 * scope's deletion epoch.
 */
export async function requeueCheckedJob(
  transaction: QueryRunner,
  job: ClaimedMemoryJob,
  options: { availableAt: string; reason: string; epochs?: { policyEpoch: number; deletionEpoch: number } },
): Promise<void> {
  await transaction.query(
    `
      UPDATE ${JOBS}
      SET state = 'pending', available_at = $2::timestamptz, lease_until = NULL, worker_id = NULL,
          attempts = GREATEST(attempts - 1, 0), last_failure_code = $3,
          policy_epoch = COALESCE($4, policy_epoch), deletion_epoch = COALESCE($5, deletion_epoch), updated_at = now()
      WHERE job_id = $1 AND fence = $6
    `,
    [job.jobId, options.availableAt, options.reason, options.epochs?.policyEpoch ?? null, options.epochs?.deletionEpoch ?? null, job.fence],
  )
}

/** Dead-letters a checked job with a safe reason code. */
export async function deadLetterCheckedJob(transaction: QueryRunner, job: ClaimedMemoryJob, failure: JobFailure | MemoryFailure): Promise<void> {
  await markDead(transaction, job.jobId, failure)
}

/** Retries a checked job with bounded backoff, or dead-letters it when attempts are spent. */
export async function retryCheckedJob(transaction: QueryRunner, job: ClaimedMemoryJob, failure: JobFailure, now: string): Promise<JobCompletion> {
  const row = await transaction.query<{ attempts: number; max_attempts: number }>(`SELECT attempts, max_attempts FROM ${JOBS} WHERE job_id = $1`, [job.jobId])
  const attempts = row.rows[0]?.attempts ?? job.attempt
  if (failure.retryable && attempts < (row.rows[0]?.max_attempts ?? MAX_JOB_ATTEMPTS)) return scheduleRetry(transaction, job.jobId, attempts, failure, now)
  await markDead(transaction, job.jobId, failure)
  return { status: 'dead', failure }
}

export interface RunJobBatchOptions {
  workerId: string
  limit?: number
  leaseMs?: number
  now?: string
  signal?: AbortSignal
}

export async function runJobBatch(
  store: PostgresMemoryStore,
  handler: (event: EventEnvelope, job: ClaimedMemoryJob) => Promise<JobResult>,
  options: RunJobBatchOptions,
): Promise<readonly JobCompletion[]> {
  const jobs = await claimJobs(store, options)
  const completions: JobCompletion[] = []
  for (const job of jobs) {
    if (options.signal?.aborted) {
      completions.push(await failJob(store, job, { code: 'shutdown', retryable: true }, { now: options.now }))
      continue
    }
    try {
      const result = await handler(job.event, job)
      completions.push(await completeJob(store, job, result, { now: options.now }))
    } catch {
      completions.push(await failJob(store, job, { code: 'transient_provider', retryable: true }, { now: options.now }))
    }
  }
  return completions
}
