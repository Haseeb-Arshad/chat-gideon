import {
  parseAssertionVersion,
  parseEventEnvelope,
  type AssertionPayload,
  type AssertionVersion,
  type Condition,
  type EventEnvelope,
  type ExactVersionRef,
  type PrincipalId,
  type ScopeId,
  type SourceSpan,
} from '../../../src/lib/memory/contracts.ts'
import {
  DEFAULT_PROMOTION_POLICY,
  LEARNING_SCHEMA_VERSION,
  MAX_PRIOR_TURNS,
  MAX_WINDOW_TEXT_CHARS,
  decideCandidate,
  diffShadowExtraction,
  evaluatePromotion,
  screenWindow,
  validateExtractorOutput,
  type ExistingMemory,
  type ExtractionCandidate,
  type ExtractionWindow,
  type ExtractorUsage,
  type LearnedMemoryView,
  type LearningDecision,
  type MemoryExtractor,
  type PromotionPolicy,
  type ShadowDiff,
} from '../../../src/lib/memory/learning.ts'
import { acceptedAssertionCount, allocateWatermark, watermarkId } from './commands.ts'
import { MEMORY_SCHEMA } from './config.ts'
import {
  checkRunningJob,
  deadLetterCheckedJob,
  finishCheckedJob,
  requeueCheckedJob,
  retryCheckedJob,
  type ClaimedMemoryJob,
} from './jobs.ts'
import type { PostgresMemoryStore, PostgresMemoryTransaction } from './postgres.ts'
import { canonicalJson, isoNow, revisionId, sha256 } from './serialization.ts'

/**
 * Stage 10 server worker: conservative extraction from committed user turns.
 *
 * The extractor call happens outside any transaction and only proposes. The
 * commit transaction then rechecks the job fence, lease, grant/deletion
 * epochs, source suppression and consent, reloads current memories and
 * reconciles deterministically. Nothing learned here can rewrite a memory the
 * user stated or corrected, and every accepted item cites its exact span.
 */

const SQL = {
  events: `${MEMORY_SCHEMA}.events`,
  assertions: `${MEMORY_SCHEMA}.assertions`,
  versions: `${MEMORY_SCHEMA}.assertion_versions`,
  evidence: `${MEMORY_SCHEMA}.evidence_edges`,
  suppressions: `${MEMORY_SCHEMA}.deletion_suppressions`,
  receipts: `${MEMORY_SCHEMA}.receipts`,
  changes: `${MEMORY_SCHEMA}.change_feed`,
  epochs: `${MEMORY_SCHEMA}.policy_epochs`,
  grants: `${MEMORY_SCHEMA}.grants`,
  decisions: `${MEMORY_SCHEMA}.learning_decisions`,
  budgets: `${MEMORY_SCHEMA}.learning_budgets`,
} as const

export interface LearningBudget {
  maxJobsPerDay: number
  maxUnitsPerDay: number
  maxCostMicrosPerDay: number
}

/** Per-user daily ceilings. Exhausting them defers learning; explicit commands are unaffected. */
export const DEFAULT_LEARNING_BUDGET: LearningBudget = Object.freeze({
  maxJobsPerDay: 200,
  maxUnitsPerDay: 400_000,
  maxCostMicrosPerDay: 50_000,
})

/** Learning stops before the durable quota is full so explicit remember keeps headroom. */
export const LEARNING_QUOTA_RESERVE = 0.1
const MAX_EXISTING_FOR_RECONCILIATION = 300
const MAX_KNOWN_IN_WINDOW = 24
const DEFAULT_EXTRACTION_TIMEOUT_MS = 20_000

export interface LearningJobOptions {
  extractor: MemoryExtractor
  now?: string
  budget?: LearningBudget
  timeoutMs?: number
  signal?: AbortSignal
  /** Learning is off for this owner: close the job without reading or extracting. */
  disabled?: boolean
  /**
   * Stage 11 shadow: runs after the writing extractor, outside every
   * transaction, and only records disagreement codes. It never writes memory
   * and its failure never affects the job.
   */
  shadow?: MemoryExtractor
  /**
   * Adds the scope's current memories (bounded, text only, opaque handles) to
   * the window for a classifier's relation stage. Only for extractors that
   * use it: it widens what a remote provider sees.
   */
  includeKnownMemories?: boolean
}

export type LearningJobOutcome =
  | { status: 'completed'; decisions: readonly { action: string; reason: string; assertionId: string | null }[]; usage: ExtractorUsage }
  | { status: 'skipped'; reason: string }
  | { status: 'deferred'; reason: 'budget_exhausted' | 'stale_epoch' }
  | { status: 'retry_scheduled' | 'dead'; reason: string }
  | { status: 'lease_lost' }
  | { status: 'revoked' }

type Tx = PostgresMemoryTransaction

function scoped(store: PostgresMemoryStore, job: Pick<ClaimedMemoryJob, 'principalId' | 'scopeId' | 'policyEpoch'>): PostgresMemoryStore {
  return store.forContext({ principalId: job.principalId, scopeId: job.scopeId, policyEpoch: job.policyEpoch })
}

function dayOf(instant: string): string {
  return instant.slice(0, 10)
}

function nextDay(instant: string): string {
  return new Date(Date.parse(`${dayOf(instant)}T00:00:00.000Z`) + 86_400_000).toISOString()
}

function payloadText(event: EventEnvelope): string {
  return typeof event.payload.text === 'string' ? event.payload.text : ''
}

/** Committed user text of this turn plus at most three earlier committed user turns in the conversation. */
async function loadWindow(store: PostgresMemoryStore, job: ClaimedMemoryJob): Promise<ExtractionWindow | null> {
  const event = job.event
  if (event.sourceKind !== 'user_statement' || event.committedPhase !== 'committed') return null
  const text = payloadText(event)
  const prior = await scoped(store, job).runTransaction(async (tx) => tx.query<{ event_id: string; envelope: unknown }>(
    `
      SELECT e.event_id, e.envelope
      FROM ${SQL.events} e
      WHERE e.scope_id = $1 AND e.source_kind = 'user_statement' AND e.committed_phase = 'committed'
        AND e.envelope->>'conversationId' = $2 AND e.event_sequence < $3
        AND NOT EXISTS (SELECT 1 FROM ${SQL.suppressions} s WHERE s.scope_id = e.scope_id AND s.event_id = e.event_id)
      ORDER BY e.event_sequence DESC
      LIMIT $4
    `,
    [job.scopeId, event.conversationId, event.sequence, MAX_PRIOR_TURNS],
  ))
  const priorTurns = prior.rows.reverse().flatMap((row) => {
    const parsed = parseEventEnvelope(row.envelope)
    const priorText = parsed.ok ? payloadText(parsed.value).slice(0, MAX_WINDOW_TEXT_CHARS) : ''
    return priorText ? [{ eventId: row.event_id, text: priorText }] : []
  })
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    scopeId: job.scopeId,
    eventId: event.id,
    conversationId: event.conversationId,
    sourceRevision: event.sourceAuthority.revision,
    receivedAt: event.receivedAt,
    text,
    priorTurns,
  }
}

async function budgetAllows(store: PostgresMemoryStore, job: ClaimedMemoryJob, now: string, budget: LearningBudget): Promise<boolean> {
  const row = await scoped(store, job).runTransaction((tx) => tx.query<{ jobs_used: number; units_used: string; cost_micros: string }>(
    `SELECT jobs_used, units_used, cost_micros FROM ${SQL.budgets} WHERE scope_id = $1 AND window_start = $2::date`,
    [job.scopeId, dayOf(now)],
  ))
  const used = row.rows[0]
  if (!used) return true
  return used.jobs_used < budget.maxJobsPerDay && Number(used.units_used) < budget.maxUnitsPerDay && Number(used.cost_micros) < budget.maxCostMicrosPerDay
}

async function chargeBudget(tx: Tx, scopeId: string, now: string, usage: ExtractorUsage): Promise<void> {
  await tx.query(
    `
      INSERT INTO ${SQL.budgets} (scope_id, window_start, jobs_used, units_used, cost_micros)
      VALUES ($1, $2::date, 1, $3, $4)
      ON CONFLICT (scope_id, window_start) DO UPDATE
      SET jobs_used = ${SQL.budgets}.jobs_used + 1,
          units_used = ${SQL.budgets}.units_used + EXCLUDED.units_used,
          cost_micros = ${SQL.budgets}.cost_micros + EXCLUDED.cost_micros,
          updated_at = now()
    `,
    [scopeId, dayOf(now), Math.max(0, Math.round(usage.inputUnits + usage.outputUnits)), Math.max(0, Math.round(usage.costMicros))],
  )
}

/** The identifiers a decision or published change is attributed to. */
type LearningContext = Pick<ClaimedMemoryJob, 'scopeId' | 'inputEventId'> & { jobId: string | null }

async function recordDecision(
  tx: Tx,
  job: LearningContext,
  extractor: Pick<MemoryExtractor, 'id' | 'version' | 'promptVersion' | 'schemaVersion' | 'model'>,
  index: number,
  action: string,
  reason: string,
  assertion: ExactVersionRef | null,
): Promise<void> {
  await tx.query(
    `
      INSERT INTO ${SQL.decisions}
        (decision_id, scope_id, job_id, event_id, candidate_index, extractor_id, extractor_version, prompt_version,
         schema_version, model, action, reason, assertion_id, assertion_revision)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (decision_id) DO NOTHING
    `,
    [
      `decision/${sha256({ scope: job.scopeId, event: job.inputEventId, extractor: extractor.id, version: extractor.version, index, action }).slice(0, 48)}`,
      job.scopeId, job.jobId, job.inputEventId, index, extractor.id, extractor.version, extractor.promptVersion,
      extractor.schemaVersion, extractor.model, action, reason.replace(/[^a-z_]/gu, '_').slice(0, 64) || 'unspecified',
      assertion?.assertionId ?? null, assertion?.revision ?? null,
    ],
  )
}

function textOfVersion(version: AssertionVersion): string {
  const payload = version.payload
  if (payload.kind === 'fact') return payload.proposition.type === 'free_form' ? payload.proposition.text : `${payload.proposition.slot.slotId}: ${String(payload.proposition.value)}`
  if (payload.kind === 'preference' || payload.kind === 'constraint') return payload.text
  if (payload.kind === 'decision') return `${payload.topic}: ${payload.decision}`
  return payload.topic
}

function conditionsOf(version: AssertionVersion): readonly Condition[] {
  const payload = version.payload
  if (payload.kind === 'preference' || payload.kind === 'constraint') return payload.conditions
  if (payload.kind === 'fact' && payload.proposition.type === 'free_form') return payload.proposition.conditions
  return []
}

/** Current, unsuppressed memories of the scope, read inside the commit transaction. */
async function currentMemories(tx: Tx, scopeId: string): Promise<ExistingMemory[]> {
  const rows = await tx.query<{ version: unknown }>(
    `
      SELECT v.version
      FROM ${SQL.assertions} a
      JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
      WHERE a.scope_id = $1 AND a.current_status IN ('candidate', 'accepted', 'disputed')
      ORDER BY a.updated_at DESC
      LIMIT $2
    `,
    [scopeId, MAX_EXISTING_FOR_RECONCILIATION],
  )
  const memories: ExistingMemory[] = []
  for (const row of rows.rows) {
    const parsed = parseAssertionVersion(row.version)
    if (!parsed.ok || parsed.value.kind === 'episode_checkpoint') continue
    const version = parsed.value
    if (await tx.isVersionSuppressed({ assertionId: version.id, revision: version.revision }, version.evidence.map((edge) => edge.eventId))) continue
    memories.push({
      assertionId: version.id,
      revision: version.revision,
      kind: version.kind,
      text: textOfVersion(version),
      polarity: version.polarity,
      status: version.status as ExistingMemory['status'],
      basis: version.attribution.basis,
      conditions: conditionsOf(version),
    })
  }
  return memories
}

function spanFor(event: EventEnvelope, window: ExtractionWindow, candidate: ExtractionCandidate): SourceSpan {
  const document = event.sourceSpans[0]?.quote === window.text
    ? event.sourceSpans[0].document
    : {
        sourceId: `source/event/${sha256({ scope: window.scopeId, event: event.id }).slice(0, 40)}` as SourceSpan['document']['sourceId'],
        revision: window.sourceRevision as SourceSpan['document']['revision'],
        contentHash: sha256(window.text),
      }
  return { document, start: candidate.evidence.start, end: candidate.evidence.end, textHash: sha256(candidate.evidence.quote), quote: candidate.evidence.quote }
}

function payloadFor(candidate: ExtractionCandidate, event: EventEnvelope): AssertionPayload {
  if (candidate.kind === 'fact') {
    return { kind: 'fact', proposition: { type: 'free_form', text: candidate.text, subject: event.subject, conditions: candidate.conditions } }
  }
  if (candidate.kind === 'decision') return { kind: 'decision', topic: 'conversation', decision: candidate.text, alternatives: [], reasons: [] }
  return { kind: candidate.kind, text: candidate.text, conditions: candidate.conditions, exceptions: [] }
}

function producerFor(extractor: MemoryExtractor): AssertionVersion['producer'] {
  return { name: extractor.id, version: `${extractor.version}+${extractor.promptVersion}+schema${extractor.schemaVersion}`.slice(0, 120), model: extractor.model }
}

function learnedAssertion(
  job: ClaimedMemoryJob,
  window: ExtractionWindow,
  decision: Extract<LearningDecision, { action: 'add' }>,
  index: number,
  extractor: MemoryExtractor,
  now: string,
): AssertionVersion | null {
  const candidate = decision.candidate
  const id = `assertion/learned/${sha256({ scope: job.scopeId, event: job.inputEventId, index, extractor: extractor.id }).slice(0, 40)}`
  const version = {
    schemaVersion: 1,
    id,
    revision: 1,
    scopeId: job.scopeId,
    subject: job.event.subject,
    kind: candidate.kind,
    payload: payloadFor(candidate, job.event),
    attribution: { actor: { kind: 'principal', principalId: job.principalId }, basis: decision.basis },
    polarity: candidate.polarity,
    status: decision.status,
    time: { validTime: candidate.validTime, receivedAt: job.event.receivedAt, interpretedAt: now, relation: candidate.relation },
    evidence: [{ eventId: job.inputEventId, span: spanFor(job.event, window, candidate), relation: 'supports' }],
    dependencies: [{ type: 'event', id: job.inputEventId, revision: window.sourceRevision }],
    producer: producerFor(extractor),
  }
  const parsed = parseAssertionVersion(version)
  return parsed.ok ? parsed.value : null
}

async function publishAccepted(tx: Tx, job: LearningContext, assertion: AssertionVersion, kind: 'learned' | 'promoted', eventId: string): Promise<void> {
  const watermark = await allocateWatermark(tx, job.scopeId)
  const change = {
    scopeId: job.scopeId,
    changeWatermark: watermarkId(job.scopeId, watermark),
    // Overlays accept remember/correct; a learned or promoted item is new visible memory.
    operation: 'remember' as const,
    assertion: { assertionId: assertion.id, revision: assertion.revision },
    version: assertion,
  }
  await tx.query(
    `INSERT INTO ${SQL.changes} (scope_id, watermark, command_id, event_id, assertion_id, assertion_revision, change_kind, change)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [job.scopeId, watermark, `${kind}/${assertion.id}/${assertion.revision}`.slice(0, 160), eventId, assertion.id, assertion.revision, kind, canonicalJson(change)],
  )
}

async function attachEvidence(tx: Tx, scopeId: string, target: ExistingMemory, eventId: string, relation: 'supports' | 'contradicts', span: SourceSpan): Promise<void> {
  await tx.query(
    `
      INSERT INTO ${SQL.evidence} (scope_id, assertion_id, assertion_revision, event_id, relation, source_span)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT DO NOTHING
    `,
    [scopeId, target.assertionId, target.revision, eventId, relation, canonicalJson(span)],
  )
}

type DecisionClass = 'accept' | 'hold' | 'support' | 'refuse'

function decisionClass(decision: LearningDecision): DecisionClass {
  if (decision.action === 'add') return decision.status === 'accepted' ? 'accept' : 'hold'
  if (decision.action === 'corroborate') return 'support'
  if (decision.action === 'dispute') return 'hold'
  return 'refuse'
}

function overlaps(left: ExtractionCandidate, right: ExtractionCandidate): boolean {
  return left.evidence.start < right.evidence.end && right.evidence.start < left.evidence.end
}

/**
 * Reason codes describing how a shadow extractor's outcome would differ from
 * the writing extractor's, matched by overlapping evidence spans. Shadow-only
 * proposals use indexes from 32; a failed shadow run is one `shadow_failed`.
 */
export function compareShadow(
  written: readonly ExtractionCandidate[],
  shadow: readonly ExtractionCandidate[] | null,
  existing: readonly ExistingMemory[],
): { index: number; reason: string }[] {
  if (!shadow) return [{ index: -1, reason: 'shadow_failed' }]
  const decide = (candidate: ExtractionCandidate) => decisionClass(decideCandidate(candidate, existing, { activeTopicKnown: false }))
  const used = new Set<number>()
  const records: { index: number; reason: string }[] = []
  written.slice(0, 32).forEach((candidate, index) => {
    const match = shadow.findIndex((other, position) => !used.has(position) && overlaps(candidate, other))
    if (match < 0) {
      records.push({ index, reason: 'shadow_missing' })
      return
    }
    used.add(match)
    const mine = decide(candidate)
    const theirs = decide(shadow[match]!)
    records.push({ index, reason: mine === theirs ? 'shadow_agree' : `shadow_${theirs}` })
  })
  shadow.forEach((candidate, position) => {
    if (used.has(position) || records.length >= 60) return
    records.push({ index: 32 + Math.min(position, 31), reason: `shadow_extra_${decide(candidate)}` })
  })
  return records
}

/**
 * Processes one claimed `interpret_event` job end to end. Returns what
 * happened; the job row is always left completed, requeued, retried or dead.
 */
export async function processLearningJob(
  store: PostgresMemoryStore,
  job: ClaimedMemoryJob,
  options: LearningJobOptions,
): Promise<LearningJobOutcome> {
  const now = options.now ?? isoNow()
  const extractor = options.extractor
  const budget = options.budget ?? DEFAULT_LEARNING_BUDGET

  const closeWithoutExtraction = (reason: string): Promise<LearningJobOutcome> => scoped(store, job).runTransaction(async (tx) => {
    const check = await checkRunningJob(tx, job, now)
    if (check.status === 'lease_lost') return { status: 'lease_lost' }
    if (check.status === 'revoked') {
      await deadLetterCheckedJob(tx, job, { code: 'revoked_input', retryable: false })
      return { status: 'revoked' }
    }
    await recordDecision(tx, job, extractor, -1, 'skip', reason, null)
    await finishCheckedJob(tx, job, now)
    return { status: 'skipped', reason }
  })

  if (options.disabled) return closeWithoutExtraction('learning_disabled')
  if (job.kind !== 'interpret_event') return closeWithoutExtraction('not_an_interpretation_job')
  const loaded = await loadWindow(store, job)
  if (!loaded) return closeWithoutExtraction('not_a_committed_user_turn')
  let window = loaded
  if (options.includeKnownMemories) {
    // Scope is bound by the job's context before anything is read; the
    // classifier sees opaque handles, never assertion ids.
    const known = await scoped(store, job).runTransaction((tx) => currentMemories(tx, job.scopeId))
    window = { ...loaded, knownMemories: known.filter((memory) => memory.status === 'accepted').slice(0, MAX_KNOWN_IN_WINDOW).map((memory, index) => ({ handle: `k${index}`, text: memory.text })) }
  }
  const screen = screenWindow(window)
  if (!screen.ok) return closeWithoutExtraction(screen.reason)
  if (extractor.placement === 'remote' && window.priorTurns.some((turn) => !turn.text)) return closeWithoutExtraction('invalid_window')

  if (!await budgetAllows(store, job, now, budget)) {
    return scoped(store, job).runTransaction(async (tx) => {
      const check = await checkRunningJob(tx, job, now)
      if (check.status !== 'ok' && check.status !== 'stale_epoch') return check.status === 'revoked' ? { status: 'revoked' } : { status: 'lease_lost' }
      await requeueCheckedJob(tx, job, { availableAt: nextDay(now), reason: 'budget_exhausted' })
      return { status: 'deferred', reason: 'budget_exhausted' }
    })
  }

  // The extractor runs outside every transaction, under its own deadline.
  let output: unknown
  let usage: ExtractorUsage = { inputUnits: 0, outputUnits: 0, costMicros: 0 }
  try {
    const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]
    const result = await extractor.extract(window, AbortSignal.any(signals))
    output = result.output
    usage = result.usage
  } catch {
    return scoped(store, job).runTransaction(async (tx) => {
      const check = await checkRunningJob(tx, job, now)
      if (check.status === 'lease_lost') return { status: 'lease_lost' }
      if (check.status === 'revoked') {
        await deadLetterCheckedJob(tx, job, { code: 'revoked_input', retryable: false })
        return { status: 'revoked' }
      }
      const retried = await retryCheckedJob(tx, job, { code: 'transient_provider', retryable: true }, now)
      return { status: retried.status === 'retry_scheduled' ? 'retry_scheduled' : 'dead', reason: 'extractor_failed' }
    })
  }
  const validated = validateExtractorOutput(window, output)

  // Shadow extraction: its own deadline, never retried, never written.
  let shadow: { extractor: MemoryExtractor; candidates: readonly ExtractionCandidate[] | null } | null = null
  if (options.shadow) {
    try {
      const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]
      const result = await options.shadow.extract(window, AbortSignal.any(signals))
      usage = { inputUnits: usage.inputUnits + result.usage.inputUnits, outputUnits: usage.outputUnits + result.usage.outputUnits, costMicros: usage.costMicros + result.usage.costMicros }
      shadow = { extractor: options.shadow, candidates: validateExtractorOutput(window, result.output).candidates }
    } catch {
      shadow = { extractor: options.shadow, candidates: null }
    }
  }

  return scoped(store, job).runTransaction(async (tx): Promise<LearningJobOutcome> => {
    const check = await checkRunningJob(tx, job, now)
    if (check.status === 'lease_lost') return { status: 'lease_lost' }
    if (check.status === 'revoked') {
      await deadLetterCheckedJob(tx, job, { code: 'revoked_input', retryable: false })
      return { status: 'revoked' }
    }
    if (check.status === 'stale_epoch') {
      // A deletion elsewhere in the scope happened while extracting. Recompute
      // against the new state rather than committing a stale reconciliation.
      await requeueCheckedJob(tx, job, { availableAt: now, reason: 'stale_epoch', epochs: { policyEpoch: check.policyEpoch, deletionEpoch: check.deletionEpoch } })
      return { status: 'deferred', reason: 'stale_epoch' }
    }
    const source = await tx.query<{ envelope: unknown }>(`SELECT envelope FROM ${SQL.events} WHERE scope_id = $1 AND event_id = $2`, [job.scopeId, job.inputEventId])
    const current = source.rows[0] ? parseEventEnvelope(source.rows[0].envelope) : null
    if (!current?.ok || !current.value.consent || payloadText(current.value) !== window.text) {
      await deadLetterCheckedJob(tx, job, { code: 'revoked_input', retryable: false })
      return { status: 'revoked' }
    }
    // Serialize learned writes with explicit commands for watermark and quota order.
    await tx.query(`SELECT scope_id FROM ${SQL.epochs} WHERE scope_id = $1 FOR UPDATE`, [job.scopeId])
    const quota = await acceptedAssertionCount(tx, job.scopeId)
    const learningCeiling = Math.floor(quota.limit * (1 - LEARNING_QUOTA_RESERVE))
    let count = quota.count
    const existing = await currentMemories(tx, job.scopeId)
    const outcomes: { action: string; reason: string; assertionId: string | null }[] = []
    let firstAccepted: AssertionVersion | null = null
    if (shadow) {
      // Both sides are judged by the same reconciler against the same snapshot.
      for (const record of compareShadow(validated.candidates, shadow.candidates, [...existing])) {
        await recordDecision(tx, job, shadow.extractor, record.index, 'shadow', record.reason, null)
      }
    }

    for (const rejected of validated.rejected) {
      await recordDecision(tx, job, extractor, Math.max(rejected.index, -1), 'reject', rejected.reason, null)
      outcomes.push({ action: 'reject', reason: rejected.reason, assertionId: null })
    }
    for (const [index, candidate] of validated.candidates.entries()) {
      const decision = decideCandidate(candidate, existing, { activeTopicKnown: false })
      if (decision.action === 'reject') {
        await recordDecision(tx, job, extractor, index, 'reject', decision.reason, null)
        outcomes.push({ action: 'reject', reason: decision.reason, assertionId: null })
        continue
      }
      if (decision.action === 'corroborate' || decision.action === 'dispute') {
        await attachEvidence(tx, job.scopeId, decision.target, job.inputEventId, decision.action === 'corroborate' ? 'supports' : 'contradicts', spanFor(job.event, window, candidate))
        await recordDecision(tx, job, extractor, index, decision.action, decision.reason, { assertionId: decision.target.assertionId as ExactVersionRef['assertionId'], revision: decision.target.revision })
        outcomes.push({ action: decision.action, reason: decision.reason, assertionId: decision.target.assertionId })
        continue
      }
      if (count >= learningCeiling) {
        await recordDecision(tx, job, extractor, index, 'reject', 'quota_reserved', null)
        outcomes.push({ action: 'reject', reason: 'quota_reserved', assertionId: null })
        continue
      }
      const assertion = learnedAssertion(job, window, decision, index, extractor, now)
      if (!assertion) {
        await recordDecision(tx, job, extractor, index, 'reject', 'invalid_assertion', null)
        outcomes.push({ action: 'reject', reason: 'invalid_assertion', assertionId: null })
        continue
      }
      const committed = await tx.commitAssertion({ assertion, expectedRevision: null, slot: null, canonicalKey: null })
      if (!committed.ok) {
        await recordDecision(tx, job, extractor, index, 'reject', committed.failure.code, null)
        outcomes.push({ action: 'reject', reason: committed.failure.code, assertionId: null })
        continue
      }
      count += 1
      if (assertion.status === 'accepted') {
        await publishAccepted(tx, job, assertion, 'learned', job.inputEventId)
        firstAccepted ??= assertion
      }
      existing.unshift({
        assertionId: assertion.id, revision: assertion.revision, kind: assertion.kind, text: textOfVersion(assertion),
        polarity: assertion.polarity, status: assertion.status as ExistingMemory['status'], basis: assertion.attribution.basis, conditions: conditionsOf(assertion),
      })
      await recordDecision(tx, job, extractor, index, 'add', decision.reason, { assertionId: assertion.id, revision: assertion.revision })
      outcomes.push({ action: 'add', reason: decision.reason, assertionId: assertion.id })
    }

    if (firstAccepted) {
      await tx.insertProjectionJob(job.event)
      const receipt = {
        schemaVersion: 1 as const,
        receiptId: `receipt/${job.inputEventId}`,
        eventId: job.inputEventId,
        receivedAt: job.event.receivedAt,
        ok: true as const,
        state: 'accepted' as const,
        canonicalRevision: revisionId(firstAccepted.id, firstAccepted.revision),
        indexWatermark: null,
      }
      await tx.query(`UPDATE ${SQL.receipts} SET state = 'accepted', receipt = $2::jsonb, updated_at = now() WHERE event_id = $1`, [job.inputEventId, JSON.stringify(receipt)])
    }
    if (!validated.candidates.length && !validated.rejected.length) await recordDecision(tx, job, extractor, -1, 'skip', 'nothing_to_learn', null)
    await chargeBudget(tx, job.scopeId, now, usage)
    await finishCheckedJob(tx, job, now)
    return { status: 'completed', decisions: outcomes, usage }
  })
}

// ---------------------------------------------------------------------------
// Promotion and retirement of inferred candidates
// ---------------------------------------------------------------------------

export interface PromotionPassOptions {
  now?: string
  policy?: PromotionPolicy
  limit?: number
  scopeId?: ScopeId
}

export interface PromotionPassResult {
  examined: number
  promoted: number
  retired: number
}

const PROMOTION_EXTRACTOR = { id: 'promotion-policy', version: '1.0.0', promptVersion: 'policy-2026-09-23', schemaVersion: LEARNING_SCHEMA_VERSION, model: null } as const

/**
 * Bounded pass over inferred candidates. A candidate is promoted only when
 * the conservative policy passes on independent user evidence; one that sat
 * unsupported past its TTL is retired. Each change is its own transaction that
 * rechecks the candidate's current revision and scope grant.
 */
export async function promoteLearnedCandidates(store: PostgresMemoryStore, options: PromotionPassOptions = {}): Promise<PromotionPassResult> {
  const now = options.now ?? isoNow()
  const policy = options.policy ?? DEFAULT_PROMOTION_POLICY
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200)
  const candidates = await store.runTransaction((tx) => tx.query<{ scope_id: string; assertion_id: string; revision: string; principal_id: string | null; policy_epoch: string | null; created_at: string }>(
    `
      SELECT a.scope_id, a.assertion_id, a.current_revision AS revision, g.principal_id, e.policy_epoch, a.created_at
      FROM ${SQL.assertions} a
      JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
      LEFT JOIN LATERAL (SELECT principal_id FROM ${SQL.grants} WHERE scope_id = a.scope_id AND revoked_at IS NULL LIMIT 1) g ON true
      LEFT JOIN ${SQL.epochs} e ON e.scope_id = a.scope_id
      WHERE a.current_status = 'candidate' AND v.version->'attribution'->>'basis' = 'inference'
        AND ($1::text IS NULL OR a.scope_id = $1)
      ORDER BY a.updated_at
      LIMIT $2
    `,
    [options.scopeId ?? null, limit],
  ))
  const result: PromotionPassResult = { examined: 0, promoted: 0, retired: 0 }
  for (const row of candidates.rows) {
    if (!row.principal_id || row.policy_epoch === null) continue
    result.examined += 1
    const context = { principalId: row.principal_id as PrincipalId, scopeId: row.scope_id as ScopeId, policyEpoch: Number(row.policy_epoch) }
    const outcome = await store.forContext(context).runTransaction(async (tx) => {
      await tx.query(`SELECT scope_id FROM ${SQL.epochs} WHERE scope_id = $1 FOR UPDATE`, [row.scope_id])
      const current = await tx.currentVersion(row.assertion_id as AssertionVersion['id'])
      if (!current || current.status !== 'candidate' || current.revision !== Number(row.revision)) return 'skip' as const
      const support = await tx.query<{ event_id: string; relation: 'supports' | 'contradicts' | 'derived_from'; source_kind: string; conversation_id: string; received_at: string }>(
        `
          SELECT ee.event_id, ee.relation, e.source_kind, e.envelope->>'conversationId' AS conversation_id, e.envelope->>'receivedAt' AS received_at
          FROM ${SQL.evidence} ee
          JOIN ${SQL.events} e ON e.scope_id = ee.scope_id AND e.event_id = ee.event_id
          WHERE ee.scope_id = $1 AND ee.assertion_id = $2
            AND NOT EXISTS (SELECT 1 FROM ${SQL.suppressions} s WHERE s.scope_id = ee.scope_id AND s.event_id = ee.event_id)
          ORDER BY e.event_sequence
        `,
        [row.scope_id, row.assertion_id],
      )
      const supportRows = support.rows.map((item) => ({ sourceKind: item.source_kind, conversationId: item.conversation_id, receivedAt: item.received_at, relation: item.relation }))
      const text = textOfVersion(current)
      const verdict = evaluatePromotion(text, supportRows, policy)
      const latest = support.rows.filter((item) => item.relation === 'supports').at(-1)
      if (!latest) return 'skip' as const
      const job: LearningContext = { jobId: null, scopeId: row.scope_id as ScopeId, inputEventId: latest.event_id as EventEnvelope['id'] }
      const expired = Date.parse(now) - Date.parse(row.created_at) > policy.candidateTtlDays * 86_400_000
      if (!verdict.promote && !expired) return 'skip' as const
      const supporting = [...new Map(support.rows.filter((item) => item.relation === 'supports').map((item) => [item.event_id, item])).values()]
      const next = parseAssertionVersion({
        ...current,
        revision: current.revision + 1,
        status: verdict.promote ? 'accepted' : 'retracted',
        payload: verdict.promote ? promotedPayload(current, verdict.independentConversations) : current.payload,
        time: { ...current.time, interpretedAt: now },
        evidence: supporting.slice(0, 16).map((item) => ({ eventId: item.event_id, span: null, relation: 'supports' })),
        dependencies: [{ type: 'assertion', id: current.id, revision: revisionId(current.id, current.revision) }],
        producer: { name: PROMOTION_EXTRACTOR.id, version: PROMOTION_EXTRACTOR.version, model: null },
        supersedes: { assertionId: current.id, revision: current.revision },
      })
      if (!next.ok) return 'skip' as const
      const committed = await tx.commitAssertion({ assertion: next.value, expectedRevision: current.revision, slot: null, canonicalKey: null })
      if (!committed.ok) return 'skip' as const
      if (verdict.promote) await publishAccepted(tx, job, next.value, 'promoted', latest.event_id)
      await recordDecision(tx, job, PROMOTION_EXTRACTOR, -1, verdict.promote ? 'promote' : 'retire', verdict.promote ? 'independent_support' : verdict.reason, { assertionId: next.value.id, revision: next.value.revision })
      return verdict.promote ? 'promoted' as const : 'retired' as const
    }).catch(() => 'skip' as const)
    if (outcome === 'promoted') result.promoted += 1
    if (outcome === 'retired') result.retired += 1
  }
  return result
}

const TASK_SCOPE_KEY = 'scope'

/** The promoted text says it is inferred and how widely; the per-task marker is dropped. */
function promotedPayload(version: AssertionVersion, conversations: number): AssertionPayload {
  const payload = version.payload
  const said = textOfVersion(version).replace(/^User said:\s*/u, '')
  const text = `Inferred from requests in ${conversations} separate conversations: ${said}`.slice(0, 1_000)
  if (payload.kind === 'preference' || payload.kind === 'constraint') {
    return { ...payload, text, conditions: payload.conditions.filter((condition) => condition.key !== TASK_SCOPE_KEY) }
  }
  if (payload.kind === 'fact' && payload.proposition.type === 'free_form') {
    return { ...payload, proposition: { ...payload.proposition, text, conditions: payload.proposition.conditions.filter((condition) => condition.key !== TASK_SCOPE_KEY) } }
  }
  return payload
}

// ---------------------------------------------------------------------------
// Shadow re-extraction
// ---------------------------------------------------------------------------

export interface ShadowReextractionOptions {
  scopeId: ScopeId
  principalId: PrincipalId
  policyEpoch: number
  /** The earlier extractor id whose output is compared. */
  previousExtractorId: string
  limit?: number
  signal?: AbortSignal
}

/**
 * Runs a new extractor over recent committed user turns that earlier learning
 * produced memories from, and returns a diff. It never writes: accepted edits,
 * corrections and deletions stay canonical, and suppressed events are skipped
 * so re-extraction cannot resurrect deleted content.
 */
export async function shadowReextract(store: PostgresMemoryStore, extractor: MemoryExtractor, options: ShadowReextractionOptions): Promise<ShadowDiff> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const context = { principalId: options.principalId, scopeId: options.scopeId, policyEpoch: options.policyEpoch }
  const { events, learned } = await store.forContext(context).runTransaction(async (tx) => {
    const eventRows = await tx.query<{ envelope: unknown }>(
      `
        SELECT e.envelope FROM ${SQL.events} e
        WHERE e.scope_id = $1 AND e.source_kind = 'user_statement' AND e.committed_phase = 'committed'
          AND NOT EXISTS (SELECT 1 FROM ${SQL.suppressions} s WHERE s.scope_id = e.scope_id AND s.event_id = e.event_id)
          AND EXISTS (SELECT 1 FROM ${SQL.decisions} d WHERE d.scope_id = e.scope_id AND d.event_id = e.event_id AND d.extractor_id = $2)
        ORDER BY e.event_sequence DESC
        LIMIT $3
      `,
      [options.scopeId, options.previousExtractorId, limit],
    )
    const versions = await tx.query<{ version: unknown; event_id: string }>(
      `
        SELECT v.version, ee.event_id
        FROM ${SQL.assertions} a
        JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
        JOIN ${SQL.evidence} ee ON ee.scope_id = a.scope_id AND ee.assertion_id = a.assertion_id AND ee.relation = 'supports'
        WHERE a.scope_id = $1 AND a.current_status IN ('candidate', 'accepted', 'disputed')
      `,
      [options.scopeId],
    )
    const learnedViews: LearnedMemoryView[] = []
    for (const row of versions.rows) {
      const parsed = parseAssertionVersion(row.version)
      if (!parsed.ok || parsed.value.kind === 'episode_checkpoint') continue
      if (await tx.isVersionSuppressed({ assertionId: parsed.value.id, revision: parsed.value.revision }, parsed.value.evidence.map((edge) => edge.eventId))) continue
      learnedViews.push({ assertionId: parsed.value.id, text: textOfVersion(parsed.value), polarity: parsed.value.polarity, basis: parsed.value.attribution.basis, producer: parsed.value.producer.name, eventId: row.event_id })
    }
    return { events: eventRows.rows, learned: learnedViews }
  })
  const proposals: { eventId: string; candidate: ExtractionCandidate }[] = []
  for (const row of events) {
    if (options.signal?.aborted) break
    const parsed = parseEventEnvelope(row.envelope)
    if (!parsed.ok) continue
    const window: ExtractionWindow = {
      schemaVersion: LEARNING_SCHEMA_VERSION, scopeId: options.scopeId, eventId: parsed.value.id, conversationId: parsed.value.conversationId,
      sourceRevision: parsed.value.sourceAuthority.revision, receivedAt: parsed.value.receivedAt, text: payloadText(parsed.value), priorTurns: [],
    }
    if (!screenWindow(window).ok) continue
    const { output } = await extractor.extract(window, options.signal ?? new AbortController().signal)
    for (const candidate of validateExtractorOutput(window, output).candidates) proposals.push({ eventId: window.eventId, candidate })
  }
  const eventIds = new Set(events.map((row) => (row.envelope as { id?: string }).id))
  return diffShadowExtraction(learned.filter((item) => eventIds.has(item.eventId)), proposals, { from: options.previousExtractorId, to: extractor.id })
}

