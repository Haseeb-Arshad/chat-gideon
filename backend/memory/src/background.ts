import type { ScopeId } from '../../../src/lib/memory/contracts.ts'
import type { MemoryExtractor, PromotionPolicy } from '../../../src/lib/memory/learning.ts'
import { createServerMemorySession } from '../../../src/server/memory-session.ts'
import { MEMORY_SCHEMA } from './config.ts'
import { runEvidenceRetention, scopesWithoutLearning } from './controls.ts'
import { runPurgeBatch } from './deletion.ts'
import { checkRunningJob, claimJobs, finishCheckedJob, requeueCheckedJob, retryCheckedJob, type ClaimedMemoryJob } from './jobs.ts'
import { processLearningJob, promoteLearnedCandidates, type LearningBudget, type PromotionPassResult } from './learning.ts'
import type { PostgresMemoryStore } from './postgres.ts'
import { rebuildWarmSnapshot } from './projections.ts'
import { isoNow } from './serialization.ts'

/**
 * Bounded background maintenance for the Node memory authority.
 *
 * One tick does a fixed amount of work in priority order: physical purge of
 * logically deleted content first, then stale warm views, then learning from
 * committed turns (fair per user, budgeted), then promotion/retirement of
 * inferred candidates. It never rescans whole histories; every step is capped
 * and resumes from the queue on the next tick.
 */

export interface MaintenanceLimits {
  purgeTasks: number
  projectionJobs: number
  learningJobs: number
  learningJobsPerScope: number
  promotions: number
}

export const DEFAULT_MAINTENANCE_LIMITS: MaintenanceLimits = Object.freeze({
  purgeTasks: 25,
  projectionJobs: 25,
  learningJobs: 10,
  learningJobsPerScope: 2,
  promotions: 25,
})

export interface MaintenanceOptions {
  workerId: string
  extractor: MemoryExtractor
  /** Stage 11 shadow extractor; records disagreement codes only. */
  shadowExtractor?: MemoryExtractor
  /** Give the extractor the scope's current memories for a relation stage. */
  includeKnownMemories?: boolean
  /** Global switch for implicit learning; purge and projections run regardless. */
  learning: boolean
  /** Per-owner rollout decision, evaluated by the server, never by request data. */
  learningEnabledFor: (scopeId: string) => boolean
  now?: string
  /** Restrict one tick to a single scope (targeted repair and tests); default all scopes. */
  scopeId?: ScopeId
  limits?: Partial<MaintenanceLimits>
  /** Interpretation jobs younger than this wait so same-turn explicit commands land first. */
  settleMs?: number
  budget?: LearningBudget
  policy?: PromotionPolicy
  signal?: AbortSignal
}

export interface MaintenanceReport {
  at: string
  purge: { claimed: number; completed: number; failed: number }
  retention: { scopes: number; suppressedEvents: number }
  /** `failureReasons` counts failed rebuilds by failure code (no content), so a dead projection job is explainable. */
  projections: { jobs: number; scopesRebuilt: number; requeued: number; failed: number; failureReasons: Record<string, number> }
  learning: { processed: number; learned: number; corroborated: number; disputed: number; rejected: number; skipped: number; deferred: number; failed: number; disabledScopes: number }
  promotion: PromotionPassResult
  queue: { pendingInterpret: number; pendingProjection: number; dead: number; oldestPendingSeconds: number | null }
}

async function rebuildProjections(store: PostgresMemoryStore, jobs: readonly ClaimedMemoryJob[], now: string, report: MaintenanceReport): Promise<void> {
  const byScope = new Map<string, ClaimedMemoryJob[]>()
  for (const job of jobs) byScope.set(job.scopeId, [...byScope.get(job.scopeId) ?? [], job])
  for (const [scopeId, scopeJobs] of byScope) {
    // Coalesce: one rebuild covers every pending invalidation of the scope.
    const session = { ...createServerMemorySession({ owner: scopeId, store, channel: 'worker_http', authority: 'worker_internal_owner', policyEpoch: scopeJobs[0]!.policyEpoch }), store }
    let outcome: 'rebuilt' | 'stale' | 'failed' = 'failed'
    let reason = 'threw'
    let retryable = true
    try {
      const result = await rebuildWarmSnapshot(session, { now })
      outcome = result.status === 'published' ? 'rebuilt' : result.status === 'stale' ? 'stale' : 'failed'
      if (result.status === 'unavailable') {
        // Snapshot validation messages are fixed strings (never memory content), so they name the broken rule.
        reason = result.failure.code === 'validation' ? `validation: ${result.failure.message}` : result.failure.code
        retryable = result.failure.retryable
      }
    } catch {
      outcome = 'failed'
    }
    if (outcome === 'failed') report.projections.failureReasons[reason] = (report.projections.failureReasons[reason] ?? 0) + scopeJobs.length
    for (const job of scopeJobs) {
      await store.forContext({ principalId: job.principalId, scopeId: job.scopeId, policyEpoch: job.policyEpoch }).runTransaction(async (tx) => {
        const check = await checkRunningJob(tx, job, now)
        if (check.status === 'lease_lost') return
        if (outcome === 'rebuilt' || check.status === 'revoked') await finishCheckedJob(tx, job, now)
        else if (outcome === 'stale' || check.status === 'stale_epoch') await requeueCheckedJob(tx, job, { availableAt: now, reason: 'stale_projection', ...(check.status === 'stale_epoch' ? { epochs: { policyEpoch: check.policyEpoch, deletionEpoch: check.deletionEpoch } } : {}) })
        // A non-retryable failure goes dead at once instead of burning its attempts.
        else await retryCheckedJob(tx, job, retryable ? { code: 'transient_provider', retryable: true } : { code: 'permanent_invalid', retryable: false }, now)
      }).catch(() => undefined)
    }
    if (outcome === 'rebuilt') report.projections.scopesRebuilt += 1
    else if (outcome === 'stale') report.projections.requeued += scopeJobs.length
    else report.projections.failed += scopeJobs.length
  }
}

async function queueStats(store: PostgresMemoryStore, now: string): Promise<MaintenanceReport['queue']> {
  const result = await store.runTransaction((tx) => tx.query<{ pending_interpret: string; pending_projection: string; dead: string; oldest: string | null }>(
    `
      SELECT
        count(*) FILTER (WHERE kind = 'interpret_event' AND state IN ('pending', 'retry')) AS pending_interpret,
        count(*) FILTER (WHERE kind = 'rebuild_projection' AND state IN ('pending', 'retry')) AS pending_projection,
        count(*) FILTER (WHERE state = 'dead') AS dead,
        min(available_at) FILTER (WHERE state IN ('pending', 'retry')) AS oldest
      FROM ${MEMORY_SCHEMA}.jobs
    `,
  ))
  const row = result.rows[0]
  const oldest = row?.oldest ? Math.max(0, Math.round((Date.parse(now) - Date.parse(row.oldest)) / 1000)) : null
  return { pendingInterpret: Number(row?.pending_interpret ?? 0), pendingProjection: Number(row?.pending_projection ?? 0), dead: Number(row?.dead ?? 0), oldestPendingSeconds: oldest }
}

export async function runMemoryMaintenance(store: PostgresMemoryStore, options: MaintenanceOptions): Promise<MaintenanceReport> {
  const now = options.now ?? isoNow()
  const limits = { ...DEFAULT_MAINTENANCE_LIMITS, ...options.limits }
  const report: MaintenanceReport = {
    at: now,
    purge: { claimed: 0, completed: 0, failed: 0 },
    retention: { scopes: 0, suppressedEvents: 0 },
    projections: { jobs: 0, scopesRebuilt: 0, requeued: 0, failed: 0, failureReasons: {} },
    learning: { processed: 0, learned: 0, corroborated: 0, disputed: 0, rejected: 0, skipped: 0, deferred: 0, failed: 0, disabledScopes: 0 },
    promotion: { examined: 0, promoted: 0, retired: 0 },
    queue: { pendingInterpret: 0, pendingProjection: 0, dead: 0, oldestPendingSeconds: null },
  }

  // 1. Privacy obligations outrank everything else.
  const purge = await runPurgeBatch(store, { now, limit: limits.purgeTasks, scopeId: options.scopeId })
  report.purge = { claimed: purge.claimed, completed: purge.completed, failed: purge.failed }
  if (options.signal?.aborted) return report
  // Each owner's evidence retention choice is a deletion too (Stage 12); its
  // purge tasks run in a later tick's purge step.
  if (!options.scopeId) report.retention = await runEvidenceRetention(store, { now })
  if (options.signal?.aborted) return report

  // 2. Stale warm views, coalesced per scope.
  const projectionJobs = await claimJobs(store, { workerId: `${options.workerId}/projections`, kinds: ['rebuild_projection'], limit: limits.projectionJobs, scopeId: options.scopeId, now })
  report.projections.jobs = projectionJobs.length
  await rebuildProjections(store, projectionJobs, now, report)
  if (options.signal?.aborted) return report

  // 3. Learning from committed turns, fair across users.
  if (options.learning) {
    const learningJobs = await claimJobs(store, {
      workerId: `${options.workerId}/learning`,
      kinds: ['interpret_event'],
      limit: limits.learningJobs,
      perScopeLimit: limits.learningJobsPerScope,
      scopeId: options.scopeId,
      minAgeMs: options.settleMs ?? 15_000,
      now,
    })
    const disabled = new Set<string>()
    // The owner's own setting (learning off, or a temporary conversation) wins over the rollout.
    const ownerOff = await scopesWithoutLearning(store, learningJobs.map((job) => job.scopeId), now)
    for (const job of learningJobs) {
      if (options.signal?.aborted) {
        await store.forContext({ principalId: job.principalId, scopeId: job.scopeId, policyEpoch: job.policyEpoch }).runTransaction(async (tx) => {
          if ((await checkRunningJob(tx, job, now)).status !== 'lease_lost') await requeueCheckedJob(tx, job, { availableAt: now, reason: 'shutdown' })
        }).catch(() => undefined)
        continue
      }
      if (!options.learningEnabledFor(job.scopeId) || ownerOff.has(job.scopeId)) {
        disabled.add(job.scopeId)
        // Turns captured while learning is off for this owner are closed, not learned later.
        const outcome = await processLearningJob(store, job, { extractor: options.extractor, now, disabled: true }).catch(() => null)
        if (outcome?.status === 'skipped') report.learning.skipped += 1
        continue
      }
      const outcome = await processLearningJob(store, job, {
        extractor: options.extractor,
        now,
        budget: options.budget,
        signal: options.signal,
        shadow: options.shadowExtractor,
        includeKnownMemories: options.includeKnownMemories,
      }).catch(() => null)
      report.learning.processed += 1
      if (!outcome) report.learning.failed += 1
      else if (outcome.status === 'completed') {
        for (const decision of outcome.decisions) {
          if (decision.action === 'add') report.learning.learned += 1
          else if (decision.action === 'corroborate') report.learning.corroborated += 1
          else if (decision.action === 'dispute') report.learning.disputed += 1
          else report.learning.rejected += 1
        }
      } else if (outcome.status === 'skipped') report.learning.skipped += 1
      else if (outcome.status === 'deferred') report.learning.deferred += 1
      else if (outcome.status !== 'lease_lost') report.learning.failed += 1
    }
    report.learning.disabledScopes = disabled.size

    // 4. Promotion/retirement of inferred candidates.
    if (!options.signal?.aborted) {
      report.promotion = await promoteLearnedCandidates(store, { now, limit: limits.promotions, policy: options.policy, scopeId: options.scopeId })
    }
  }

  report.queue = await queueStats(store, now)
  return report
}

export interface MemoryBackgroundHandle {
  stop(): Promise<void>
  lastReport(): MaintenanceReport | null
}

/**
 * Runs maintenance ticks until stopped. Ticks never overlap; a failed tick is
 * logged as a count only (no content, no connection strings) and retried on
 * the next interval. The timer does not keep the process alive on its own.
 */
export function startMemoryBackground(
  store: PostgresMemoryStore,
  options: Omit<MaintenanceOptions, 'now' | 'signal'> & { intervalMs?: number; onReport?: (report: MaintenanceReport) => void; onError?: (count: number) => void },
): MemoryBackgroundHandle {
  const controller = new AbortController()
  const intervalMs = Math.min(Math.max(options.intervalMs ?? 10_000, 1_000), 10 * 60_000)
  let last: MaintenanceReport | null = null
  let failures = 0
  let running: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = async () => {
    if (controller.signal.aborted) return
    try {
      last = await runMemoryMaintenance(store, { ...options, signal: controller.signal })
      options.onReport?.(last)
    } catch {
      failures += 1
      options.onError?.(failures)
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => { running = tick() }, intervalMs)
      ;(timer as { unref?: () => void }).unref?.()
    }
  }
  timer = setTimeout(() => { running = tick() }, Math.min(intervalMs, 2_000))
  ;(timer as { unref?: () => void }).unref?.()

  return {
    async stop() {
      controller.abort()
      if (timer) clearTimeout(timer)
      await running
    },
    lastReport: () => last,
  }
}
