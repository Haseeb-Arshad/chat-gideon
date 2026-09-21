import { parseEventEnvelope, type AssertionCommit, type EventEnvelope, type MemoryFailure, type PrincipalId, type ScopeId } from '../../../src/lib/memory/contracts.ts'
import { MEMORY_SCHEMA } from './config.ts'
import { PostgresMemoryStore } from './postgres.ts'
import { isoNow, revisionId } from './serialization.ts'

const JOBS = `${MEMORY_SCHEMA}.jobs`
const EVENTS = `${MEMORY_SCHEMA}.events`
const RECEIPTS = `${MEMORY_SCHEMA}.receipts`
const EPOCHS = `${MEMORY_SCHEMA}.policy_epochs`

export const DEFAULT_JOB_LEASE_MS = 30_000
export const MAX_JOB_BATCH = 100
export const MAX_JOB_ATTEMPTS = 5

export interface ClaimedMemoryJob {
  jobId: string
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

  return store.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN')
      const result = await client.query<{
        job_id: string
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
          WITH picked AS (
            SELECT job_id
            FROM ${JOBS}
            WHERE ($2::text IS NULL OR scope_id = $2)
              AND state IN ('pending', 'retry', 'running')
              AND available_at <= $1::timestamptz
              AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
            ORDER BY available_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $3
          )
          UPDATE ${JOBS} j
          SET state = 'running', attempts = j.attempts + 1, lease_until = $4::timestamptz,
              fence = j.fence + 1, worker_id = $5, updated_at = now()
          FROM picked
          WHERE j.job_id = picked.job_id
          RETURNING j.job_id, j.scope_id, j.principal_id, j.input_event_id, j.attempts,
                    j.fence, j.lease_until, j.policy_epoch, j.deletion_epoch
        `,
        [now, options.scopeId ?? null, limit, leasedUntil, workerId],
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
    }>(
      `
        SELECT state, worker_id, fence, lease_until, attempts, max_attempts, input_event_id,
               policy_epoch, deletion_epoch
        FROM ${JOBS}
        WHERE job_id = $1 AND scope_id = $2
        FOR UPDATE
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
    if (!epoch.rows[0] || Number(epoch.rows[0].policy_epoch) !== Number(row.policy_epoch) || Number(epoch.rows[0].deletion_epoch) !== Number(row.deletion_epoch)) {
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
