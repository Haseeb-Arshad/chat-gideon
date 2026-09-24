/**
 * PostgreSQL retrieval authority for Stage 08. Candidate selection is scoped
 * in SQL, every candidate is authoritatively hydrated, and no result from this
 * module is a permission to perform an action or dispatch a stale response.
 */

import {
  parseAssertionVersion,
  parseEventEnvelope,
  type AssertionVersion,
  type Condition,
  type EventEnvelope,
  type ExactVersionRef,
  type MemoryFailure,
  type MemorySession,
} from '../../../src/lib/memory/contracts.ts'
import {
  buildRetrievalQueryPlan,
  composeContextPack,
  createRetrievalRequest,
  exactVectorSearch,
  fuseRetrievalBranches,
  rankLexicalDocuments,
  retrievalRequestMatchesSession,
  runBoundedDeepRecall,
  selectApplicableConstraints,
  type CandidateBranch,
  type ContextPack,
  type EmbeddingQuery,
  type RetrievalBranchCoverage,
  type RetrievalDocument,
  type RetrievalRequest,
  type RetrievalSourceKind,
  type TokenCounter,
  type VersionedEmbedding,
} from '../../../src/lib/memory/retrieval.ts'
import type { WarmSnapshot } from '../../../src/lib/memory/projections.ts'
import { containsSecretLikeMaterial } from '../../../src/lib/memory/screening.ts'
import { MEMORY_SCHEMA } from './config.ts'
import { PostgresMemoryOperationError, PostgresMemoryStore, isPostgresMemoryStore, type PostgresMemoryTransaction } from './postgres.ts'
import { readWarmSnapshot } from './projections.ts'
import { sha256 } from './serialization.ts'

const SQL = {
  assertions: `${MEMORY_SCHEMA}.assertions`,
  versions: `${MEMORY_SCHEMA}.assertion_versions`,
  events: `${MEMORY_SCHEMA}.events`,
  suppressions: `${MEMORY_SCHEMA}.deletion_suppressions`,
  epochs: `${MEMORY_SCHEMA}.policy_epochs`,
  dependencies: `${MEMORY_SCHEMA}.dependency_edges`,
  embeddings: `${MEMORY_SCHEMA}.retrieval_embeddings`,
  evidence: `${MEMORY_SCHEMA}.evidence_edges`,
} as const

export const MAX_RETRIEVAL_BRANCH_CANDIDATES = 64
export const MAX_RETRIEVAL_CONSTRAINTS = 96
export const MAX_RETRIEVAL_VECTOR_SCAN = 512
export const MAX_RETRIEVAL_SOURCE_EVENTS = 12
export const MAX_RETRIEVAL_SOURCE_SPANS = 24
export const MAX_RETRIEVAL_INDEX_REFERENCES = 16
export const MAX_EMBEDDING_DOCUMENT_CHARS = 8_192

export interface RetrievalEmbeddingProvider {
  modelId: string
  modelVersion: string
  dimensions: number
  placement: 'local' | 'remote'
  embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]>
}

export type RemoteEmbeddingAuthorizer = (
  session: MemorySession,
  request: { purpose: 'query_embedding' | 'accepted_memory_index'; scopeId: string; documentCount: number },
) => boolean | Promise<boolean>

export interface RetrieveMemoryOptions {
  now?: string
  tokenizer?: TokenCounter
  embeddingProvider?: RetrievalEmbeddingProvider
  authorizeRemoteEmbedding?: RemoteEmbeddingAuthorizer
  signal?: AbortSignal
  maxExpansionEdges?: number
  maxEvidenceFetches?: number
  /**
   * Stage 13 evaluation only: switch one mechanism off to measure what it
   * contributes. Never set by the application. Each switch removes a branch;
   * none can widen what is retrieved.
   */
  ablate?: {
    /** No permitted source-evidence fallback. */
    sourceEvidence?: boolean
    /** No constraint applicability index; constraints compete lexically like any fact. */
    applicability?: boolean
    /** No bounded dependency-edge expansion. */
    relationships?: boolean
  }
}

export interface RetrieveMemorySuccess {
  ok: true
  request: RetrievalRequest
  pack: ContextPack
  diagnostics: {
    lexicalCandidates: number
    semanticCandidates: number
    exactCandidates: number
    warmCandidates: number
    sourceEvidenceCandidates: number
    hydratedCandidates: number
    filteredCandidates: number
    expansionEdges: number
    evidenceFetches: number
  }
}

export interface RetrieveMemoryFailure {
  ok: false
  request: RetrievalRequest | null
  pack: ContextPack | null
  failure: MemoryFailure
}

export type RetrieveMemoryResult = RetrieveMemorySuccess | RetrieveMemoryFailure

export type IndexEmbeddingsResult =
  | { status: 'indexed'; indexed: number; skippedSensitive: number; skippedStale: number; modelId: string; modelVersion: string; dimension: number }
  | { status: 'unavailable' | 'unauthorized' | 'cancelled'; indexed: 0; reason: string }

interface AssertionRow {
  assertion_id: string
  revision: string | number
  current_revision: string | number
  current_status: string
  slot_id: string | null
  subject_key: string
  version: unknown
}

interface EventRow {
  event_id: string
  envelope: unknown
}

interface EpochRow {
  policy_epoch: string | number
  deletion_epoch: string | number
}

interface BranchResult {
  status: RetrievalBranchCoverage['status']
  documents: readonly RetrievalDocument[]
  reason: string | null
  candidates: number
  filtered: number
}

interface WarmResult {
  status: RetrievalBranchCoverage['status']
  snapshot: WarmSnapshot | null
  documents: readonly RetrievalDocument[]
  reason: string | null
  candidates: number
}

interface EmbeddableDocument {
  scopeId: string
  reference: ExactVersionRef
  sourceKind: 'assertion' | 'episode' | 'evidence'
  sourceRef: string
  sourceEventId: string | null
  text: string
  contentHash: string
}

function opFailure(code: MemoryFailure['code'], message: string, retryable = false): PostgresMemoryOperationError {
  return new PostgresMemoryOperationError({ code, message, retryable })
}

function requirePostgresSession(session: MemorySession): asserts session is MemorySession<PostgresMemoryStore> {
  if (!isPostgresMemoryStore(session.store)) throw opFailure('unavailable', 'Retrieval requires the PostgreSQL memory authority.')
  if (session.trust !== 'authenticated') throw opFailure('unauthorized', 'Durable retrieval requires an authenticated session.')
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new RetrievalAbortError()
}

class RetrievalAbortError extends Error {
  readonly name = 'AbortError'
}

class RetrievalTimeoutError extends Error {
  readonly name = 'TimeoutError'
}

function queryTimeoutMs(request: RetrievalRequest, signal: AbortSignal): number {
  checkSignal(signal)
  const remaining = Date.parse(request.deadlineAt) - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) throw new RetrievalTimeoutError()
  return Math.max(1, Math.floor(remaining))
}

async function beginAuthorizedRead<T>(
  session: MemorySession<PostgresMemoryStore>,
  request: RetrievalRequest,
  signal: AbortSignal,
  work: (transaction: PostgresMemoryTransaction) => Promise<T>,
): Promise<T> {
  return session.store.forSession(session).runTransaction(async (transaction) => {
    checkSignal(signal)
    const timeoutMs = queryTimeoutMs(request, signal)
    await transaction.query(`SELECT set_config('statement_timeout', $1, true)`, [`${timeoutMs}ms`])
    await transaction.assertAuthorizedContext(session, 'recall')
    return work(transaction)
  })
}

async function readEpoch(transaction: PostgresMemoryTransaction, session: MemorySession): Promise<EpochRow> {
  const result = await transaction.query<EpochRow>(
    `SELECT policy_epoch, deletion_epoch FROM ${SQL.epochs} WHERE scope_id = $1`,
    [session.scope.id],
  )
  const row = result.rows[0]
  if (!row || Number(row.policy_epoch) !== session.policyEpoch) throw opFailure('conflict', 'Memory authorization changed during retrieval; retry with a fresh session.', true)
  return row
}

function validRef(value: ExactVersionRef): boolean {
  return typeof value.assertionId === 'string' && value.assertionId.length <= 160 && Number.isSafeInteger(value.revision) && value.revision > 0
}

function subjectIdOf(version: AssertionVersion): string | null {
  return version.subject.kind === 'known' ? version.subject.subjectId : null
}

function conditionsOf(version: AssertionVersion): readonly Condition[] {
  if (version.payload.kind === 'preference' || version.payload.kind === 'constraint') return version.payload.conditions
  if (version.payload.kind === 'fact' && version.payload.proposition.type === 'free_form') return version.payload.proposition.conditions
  return []
}

function exceptionsOf(version: AssertionVersion): readonly Condition[] {
  return version.payload.kind === 'preference' || version.payload.kind === 'constraint' ? version.payload.exceptions : []
}

function textOf(version: AssertionVersion): string {
  const payload = version.payload
  switch (payload.kind) {
    case 'fact':
      return payload.proposition.type === 'free_form'
        ? payload.proposition.text
        : `${payload.proposition.slot.slotId}: ${typeof payload.proposition.value === 'string' ? payload.proposition.value : JSON.stringify(payload.proposition.value)}`
    case 'preference':
    case 'constraint': return payload.text
    case 'decision': return [payload.topic, payload.decision, ...payload.alternatives.map((value) => `alternative ${value}`), ...payload.reasons.map((value) => `reason ${value}`)].filter(Boolean).join('; ')
    case 'episode_checkpoint': return [payload.topic, ...payload.decisions, ...payload.alternatives, ...payload.reasons, ...payload.openItems, ...payload.meaningfulOutcomes].filter(Boolean).join('; ')
  }
}

function topicCondition(conditions: readonly Condition[], key: 'topic' | 'project'): string | null {
  const condition = conditions.find((entry) => entry.key.toLocaleLowerCase('und') === key && typeof entry.value === 'string')
  return condition && typeof condition.value === 'string' ? condition.value : null
}

function volatileFact(kind: string, text: string): boolean {
  return kind === 'fact' && /\b(?:current\s+)?(?:price|cost|rate|availability|opening hours|stock price|exchange rate|weather)\b/iu.test(text)
}

function sourceRefForEvidence(eventId: string, span: { document: { sourceId: string }; start: number; end: number; textHash: string } | null): string {
  return span ? `${span.document.sourceId}/${span.start}-${span.end}/${span.textHash}` : eventId
}

function documentFromAssertion(row: AssertionRow, version: AssertionVersion, historical: boolean): RetrievalDocument {
  const text = textOf(version).normalize('NFKC').trim()
  const conditionTopic = topicCondition(conditionsOf(version), 'topic')
  const conditionProject = topicCondition(conditionsOf(version), 'project')
  const topicLabel = version.payload.kind === 'decision' || version.payload.kind === 'episode_checkpoint'
    ? version.payload.topic
    : conditionTopic
  const evidence = version.evidence.map((entry) => ({
    eventId: entry.eventId,
    relation: entry.relation,
    sourceRef: sourceRefForEvidence(entry.eventId, entry.span),
  }))
  const isDisputed = !historical && row.current_status === 'disputed'
  const conflict = row.slot_id ? `slot:${row.subject_key}:${row.slot_id}` : isDisputed || evidence.some((entry) => entry.relation === 'contradicts') ? `assertion:${version.id}` : null
  const kind = version.kind
  const retrievalKind = kind === 'episode_checkpoint' ? 'episode_checkpoint' : kind
  return {
    id: `assertion:${version.id}:${version.revision}`,
    scopeId: version.scopeId,
    reference: { assertionId: version.id, revision: version.revision },
    sourceKind: kind === 'episode_checkpoint' ? 'episode' : 'assertion',
    kind: retrievalKind,
    text,
    status: isDisputed ? 'disputed' : 'accepted',
    polarity: version.polarity,
    subjectId: subjectIdOf(version),
    topicId: topicLabel && /^topic\//u.test(topicLabel) ? topicLabel : null,
    topicLabel,
    projectId: conditionProject,
    artifactIds: [],
    slotId: row.slot_id,
    conflictGroupId: conflict,
    conditions: conditionsOf(version),
    exceptions: exceptionsOf(version),
    validFrom: version.time.validTime.from,
    validUntil: version.time.validTime.until,
    temporalRelation: version.time.relation,
    historical,
    interpretedAt: version.time.interpretedAt,
    receivedAt: version.time.receivedAt,
    basis: version.attribution.basis,
    evidence,
    sourceEventId: null,
    requiresCurrentVerification: volatileFact(kind, text),
  }
}

function parseAssertionRow(row: AssertionRow, historical: boolean): RetrievalDocument | null {
  const parsed = parseAssertionVersion(row.version)
  if (!parsed.ok || parsed.value.scopeId.length === 0 || !validRef({ assertionId: parsed.value.id, revision: parsed.value.revision })) return null
  return documentFromAssertion(row, parsed.value, historical)
}

function temporalPredicate(request: RetrievalRequest, alias = 'v', instantParameter = 2): string {
  const at = `$${instantParameter}::timestamptz`
  const validFrom = `NULLIF(${alias}.version #>> '{time,validTime,from}', '')::timestamptz`
  const validUntil = `NULLIF(${alias}.version #>> '{time,validTime,until}', '')::timestamptz`
  if (request.requestedTime.mode === 'current') {
    return `a.current_revision = ${alias}.revision
      AND a.current_status IN ('accepted', 'disputed')
      AND ${alias}.status IN ('accepted', 'disputed')
      AND (${validFrom} IS NULL OR ${validFrom} <= ${at})
      AND (${validUntil} IS NULL OR ${validUntil} > ${at})`
  }
  if (request.requestedTime.mode === 'known_at') {
    return `a.current_status <> 'deleted'
      AND ${alias}.status IN ('accepted', 'superseded', 'disputed')
      AND (${alias}.version #>> '{time,interpretedAt}')::timestamptz <= ${at}`
  }
  return `a.current_status <> 'deleted'
    AND ${alias}.status IN ('accepted', 'superseded', 'disputed')
    AND (${validFrom} IS NULL OR ${validFrom} <= ${at})
    AND (${validUntil} IS NULL OR ${validUntil} > ${at})`
}

function visibilityPredicate(alias = 'v'): string {
  return `NOT EXISTS (
      SELECT 1 FROM ${SQL.suppressions} suppressed
      WHERE suppressed.scope_id = ${alias}.scope_id
        AND suppressed.assertion_id = ${alias}.assertion_id
        AND suppressed.assertion_revision = ${alias}.revision
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(${alias}.version->'evidence', '[]'::jsonb)) evidence
      JOIN ${SQL.suppressions} source_suppressed
        ON source_suppressed.scope_id = ${alias}.scope_id
       AND source_suppressed.event_id = evidence->>'eventId'
    )`
}

function retrievalInstant(request: RetrievalRequest): string {
  return request.requestedTime.mode === 'current' ? request.createdAt : request.requestedTime.instant as string
}

/** A conservative singular stem: meetings → meeting, boxes → box, cities → city. */
function singularStem(term: string): string {
  if (term.length > 5 && term.endsWith('ies')) return `${term.slice(0, -3)}y`
  if (term.length > 4 && /(?:ch|sh|x|z|ss)es$/u.test(term)) return term.slice(0, -2)
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1)
  return term
}

/**
 * The 'simple' text configuration keeps English and Roman Urdu alike (there
 * is no Roman Urdu stemmer), but it does no stemming, so "meeting" never
 * matched "meetings". Each term is kept exactly and, when long enough, its
 * singular stem is also matched as a prefix.
 */
export function postgresOrQuery(request: RetrievalRequest): string {
  const terms = buildRetrievalQueryPlan(request).terms
  if (!terms.length) return "'__empty_memory_query__'"
  const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`
  const parts = new Set<string>()
  for (const term of terms) {
    parts.add(quote(term))
    const stem = singularStem(term)
    if (stem.length >= 4) parts.add(`${quote(stem)}:*`)
  }
  return [...parts].join(' | ')
}

function assertionSelect(): string {
  return `a.assertion_id, v.revision, a.current_revision, a.current_status, a.slot_id, a.subject_key, v.version`
}

function makeAssertionDocumentRows(rows: readonly AssertionRow[], request: RetrievalRequest): RetrievalDocument[] {
  const historical = request.requestedTime.mode !== 'current'
  const output = new Map<string, RetrievalDocument>()
  for (const row of rows) {
    const document = parseAssertionRow(row, historical)
    if (!document) continue
    output.set(document.id, document)
  }
  return [...output.values()]
}

function buildAssertionCte(request: RetrievalRequest, extraWhere: string): string {
  return `
    WITH scoped_candidates AS (
      SELECT ${assertionSelect()},
             row_number() OVER (PARTITION BY a.assertion_id ORDER BY v.revision DESC) AS version_rank
      FROM ${SQL.assertions} a
      JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id
      WHERE a.scope_id = $1
        AND ${temporalPredicate(request)}
        AND ${visibilityPredicate()}
        AND (${extraWhere})
    )
  `
}

function warmSnapshotDocuments(snapshot: WarmSnapshot): RetrievalDocument[] {
  const docs: RetrievalDocument[] = []
  const add = (reference: ExactVersionRef, kind: RetrievalDocument['kind'], text: string, conditions: readonly Condition[], validFrom: string | null, validUntil: string | null, basis: string, evidence: RetrievalDocument['evidence'] = [], topicLabel: string | null = null) => {
    docs.push({
      id: `assertion:${reference.assertionId}:${reference.revision}`,
      scopeId: snapshot.scopeId,
      reference,
      sourceKind: kind === 'episode_checkpoint' ? 'episode' : 'assertion',
      kind,
      text,
      status: 'accepted',
      polarity: 'unknown',
      subjectId: null,
      topicId: null,
      topicLabel,
      projectId: null,
      artifactIds: [],
      slotId: null,
      conflictGroupId: null,
      conditions,
      exceptions: [],
      validFrom,
      validUntil,
      temporalRelation: 'ordinary',
      historical: false,
      interpretedAt: null,
      receivedAt: snapshot.generatedAt,
      basis,
      evidence,
      sourceEventId: null,
      requiresCurrentVerification: false,
    })
  }
  for (const bullet of [...snapshot.stableProfile, ...snapshot.activeProfile]) {
    add(bullet.assertion, bullet.kind, bullet.text, bullet.conditions, null, bullet.validUntil, bullet.basis, bullet.sourceEventIds.map((eventId) => ({ eventId, relation: 'supports' as const, sourceRef: null })), bullet.topicLabel)
  }
  for (const constraint of snapshot.constraints) {
    add(constraint.assertion, constraint.kind === 'temporary_exception' ? 'preference' : 'constraint', constraint.text, constraint.conditions, constraint.validFrom, constraint.validUntil, constraint.basis, constraint.sourceEventIds.map((eventId) => ({ eventId, relation: 'supports' as const, sourceRef: null })))
  }
  for (const episode of snapshot.activeEpisodeHeads) {
    const text = [episode.topic, ...episode.decisions, ...episode.alternatives, ...episode.reasons, ...episode.openItems, ...episode.meaningfulOutcomes].join('; ')
    add(episode.assertion, 'episode_checkpoint', text, [], null, null, 'inference', episode.sourceEventIds.map((eventId) => ({ eventId, relation: 'supports' as const, sourceRef: null })), episode.topic)
  }
  for (const change of snapshot.recentAcceptedChanges) {
    const version = change.version
    const text = textOf(version)
    add(change.assertion, version.kind === 'episode_checkpoint' ? 'episode_checkpoint' : version.kind, text, conditionsOf(version), version.time.validTime.from, version.time.validTime.until, version.attribution.basis, version.evidence.map((item) => ({ eventId: item.eventId, relation: item.relation, sourceRef: sourceRefForEvidence(item.eventId, item.span) })))
  }
  return docs
}

async function searchWarmSnapshot(session: MemorySession<PostgresMemoryStore>, request: RetrievalRequest, signal: AbortSignal): Promise<WarmResult> {
  if (request.consistency !== 'warm_preferred') return { status: 'not_configured', snapshot: null, documents: [], reason: 'warm_snapshot_not_requested', candidates: 0 }
  checkSignal(signal)
  const result = await readWarmSnapshot(session, { now: request.createdAt, deadlineAt: request.deadlineAt, signal })
  if (result.status !== 'available') return { status: result.status === 'cold' || result.status === 'expired' || result.status === 'invalidated' ? 'partial' : 'unavailable', snapshot: null, documents: [], reason: result.reason, candidates: 0 }
  const snapshot = result.snapshot
  if (snapshot.scopeId !== session.scope.id || snapshot.principalId !== session.principal.id || snapshot.policyEpoch !== session.policyEpoch || snapshot.freshness !== 'fresh' || (snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= Date.now())) {
    return { status: 'partial', snapshot: null, documents: [], reason: 'warm_snapshot_identity_epoch_or_lease_mismatch', candidates: 0 }
  }
  const hints = warmSnapshotDocuments(snapshot)
  const ranked = rankLexicalDocuments(request, hints, 16)
  return { status: 'complete', snapshot, documents: ranked, reason: null, candidates: ranked.length }
}

async function searchExactAndConstraints(
  session: MemorySession<PostgresMemoryStore>,
  request: RetrievalRequest,
  signal: AbortSignal,
): Promise<{ exact: RetrievalDocument[]; constraints: RetrievalDocument[]; epoch: EpochRow; truncatedExact: boolean; truncatedConstraints: boolean }> {
  return beginAuthorizedRead(session, request, signal, async (transaction) => {
    const epoch = await readEpoch(transaction, session)
    const instant = retrievalInstant(request)
    const exactIds = [...new Set([
      ...request.resolved.assertionIds,
      ...request.taskOverrides.flatMap((override) => override.supersedesAssertionIds),
    ])].slice(0, 32)
    const subjectKeys = request.resolved.entities.map((entity) => `known:${entity.id}`)
    const topics = [request.resolved.topicId, request.resolved.topicLabel, request.activity.topicId, request.activity.topicLabel].filter((value): value is string => !!value)
    const identifiers = [...request.resolved.artifactIds]
    const exact = await transaction.query<AssertionRow>(
      `${buildAssertionCte(request, `
        a.assertion_id = ANY($3::text[])
        OR a.subject_key = ANY($4::text[])
        OR (v.version->>'kind' IN ('decision', 'episode_checkpoint') AND v.version #>> '{payload,topic}' = ANY($5::text[]))
        OR EXISTS (SELECT 1 FROM unnest($6::text[]) ref WHERE strpos(v.version::text, ref) > 0)
      `)}
       SELECT assertion_id, revision, current_revision, current_status, slot_id, subject_key, version
       FROM scoped_candidates
       WHERE version_rank = 1
       ORDER BY CASE WHEN assertion_id = ANY($3::text[]) THEN 0 ELSE 1 END,
                CASE WHEN current_status = 'disputed' THEN 0 ELSE 1 END,
                assertion_id
       LIMIT $7`,
      [session.scope.id, instant, exactIds, subjectKeys, topics, identifiers, MAX_RETRIEVAL_BRANCH_CANDIDATES + 1],
    )
    const constraint = await transaction.query<AssertionRow>(
      `${buildAssertionCte(request, `
        v.version->>'kind' = 'constraint'
        OR (v.version->>'kind' = 'preference' AND v.version #>> '{time,relation}' = 'temporary_exception')
      `)}
       SELECT assertion_id, revision, current_revision, current_status, slot_id, subject_key, version
       FROM scoped_candidates
       WHERE version_rank = 1
       ORDER BY CASE WHEN current_status = 'disputed' THEN 0 ELSE 1 END, assertion_id
       LIMIT $3`,
      [session.scope.id, instant, MAX_RETRIEVAL_CONSTRAINTS + 1],
    )
    return {
      exact: makeAssertionDocumentRows(exact.rows.slice(0, MAX_RETRIEVAL_BRANCH_CANDIDATES), request),
      constraints: makeAssertionDocumentRows(constraint.rows.slice(0, MAX_RETRIEVAL_CONSTRAINTS), request),
      epoch,
      truncatedExact: exact.rows.length > MAX_RETRIEVAL_BRANCH_CANDIDATES,
      truncatedConstraints: constraint.rows.length > MAX_RETRIEVAL_CONSTRAINTS,
    }
  })
}

async function searchLexical(
  session: MemorySession<PostgresMemoryStore>,
  request: RetrievalRequest,
  signal: AbortSignal,
): Promise<{ documents: RetrievalDocument[]; epoch: EpochRow; truncated: boolean }> {
  const query = postgresOrQuery(request)
  return beginAuthorizedRead(session, request, signal, async (transaction) => {
    const epoch = await readEpoch(transaction, session)
    const result = await transaction.query<AssertionRow>(
      `${buildAssertionCte(request, `to_tsvector('simple', COALESCE(v.version->'payload', '{}'::jsonb)::text) @@ to_tsquery('simple', $3)`)}
       SELECT assertion_id, revision, current_revision, current_status, slot_id, subject_key, version
       FROM scoped_candidates
       WHERE version_rank = 1
       ORDER BY ts_rank_cd(to_tsvector('simple', COALESCE(version->'payload', '{}'::jsonb)::text), to_tsquery('simple', $3)) DESC,
                assertion_id
       LIMIT $4`,
      [session.scope.id, retrievalInstant(request), query, MAX_RETRIEVAL_BRANCH_CANDIDATES + 1],
    )
    return { documents: makeAssertionDocumentRows(result.rows.slice(0, MAX_RETRIEVAL_BRANCH_CANDIDATES), request), epoch, truncated: result.rows.length > MAX_RETRIEVAL_BRANCH_CANDIDATES }
  })
}

function permittedUserEvent(event: EventEnvelope, session: MemorySession): boolean {
  return event.committedPhase !== 'retracted'
    && (event.sourceKind === 'user_statement' || event.sourceKind === 'user_correction')
    && event.actor.kind === 'principal'
    && event.actor.principalId === session.principal.id
    && event.consent !== null
    && (event.consent.purpose === 'memory_capture' || event.consent.purpose === 'memory_retention')
    && !['hypothetical', 'role_play', 'quotation'].includes(String(event.payload.mode ?? ''))
}

function sourceTextParts(event: EventEnvelope): readonly { text: string; sourceRef: string }[] {
  const payloadText = ['text', 'transcript', 'utterance'].map((key) => event.payload[key]).find((value): value is string => typeof value === 'string')
  const spans = event.sourceSpans.filter((span) => typeof span.quote === 'string' && span.quote.trim())
    .map((span) => ({ text: span.quote!.trim(), sourceRef: sourceRefForEvidence(event.id, span) }))
  if (spans.length) return spans
  return payloadText?.trim() ? [{ text: payloadText.trim(), sourceRef: `${event.id}/payload` }] : []
}

function sourceDocuments(events: readonly EventRow[], session: MemorySession): RetrievalDocument[] {
  const result: RetrievalDocument[] = []
  for (const row of events) {
    const parsed = parseEventEnvelope(row.envelope)
    if (!parsed.ok || parsed.value.id !== row.event_id || !permittedUserEvent(parsed.value, session)) continue
    for (const [index, part] of sourceTextParts(parsed.value).entries()) {
      const text = part.text.normalize('NFKC').trim()
      if (!text || text.length > MAX_EMBEDDING_DOCUMENT_CHARS || containsSecretLikeMaterial(text)) continue
      result.push({
        id: `evidence:${parsed.value.id}:${index}`,
        scopeId: session.scope.id,
        reference: null,
        sourceKind: 'evidence',
        kind: 'evidence',
        text,
        status: 'source_evidence',
        polarity: 'unknown',
        subjectId: parsed.value.subject.kind === 'known' ? parsed.value.subject.subjectId : null,
        topicId: null,
        topicLabel: null,
        projectId: null,
        artifactIds: [],
        slotId: null,
        conflictGroupId: null,
        conditions: [],
        exceptions: [],
        validFrom: parsed.value.sourceTime,
        validUntil: null,
        temporalRelation: 'ordinary',
        historical: false,
        interpretedAt: parsed.value.receivedAt,
        receivedAt: parsed.value.receivedAt,
        basis: parsed.value.sourceKind === 'user_correction' ? 'user_correction' : 'explicit_user_statement',
        evidence: [{ eventId: parsed.value.id, relation: 'supports', sourceRef: part.sourceRef }],
        sourceEventId: parsed.value.id,
        requiresCurrentVerification: false,
      })
    }
  }
  return result.slice(0, MAX_RETRIEVAL_SOURCE_SPANS)
}

async function searchSourceEvidence(
  session: MemorySession<PostgresMemoryStore>,
  request: RetrievalRequest,
  signal: AbortSignal,
): Promise<{ documents: RetrievalDocument[]; epoch: EpochRow; truncated: boolean }> {
  const query = postgresOrQuery(request)
  return beginAuthorizedRead(session, request, signal, async (transaction) => {
    const epoch = await readEpoch(transaction, session)
    const rows = await transaction.query<EventRow>(
      `SELECT e.event_id, e.envelope
       FROM ${SQL.events} e
       WHERE e.scope_id = $1
         AND e.source_kind IN ('user_statement', 'user_correction')
         AND e.committed_phase IN ('committed', 'corrected')
         AND e.envelope #>> '{actor,kind}' = 'principal'
         AND e.envelope #>> '{actor,principalId}' = $2
         AND e.envelope #>> '{consent,purpose}' IN ('memory_capture', 'memory_retention')
         AND COALESCE(e.envelope #>> '{payload,mode}', '') NOT IN ('hypothetical', 'role_play', 'quotation')
         AND e.received_at <= $4::timestamptz
         AND to_tsvector('simple', COALESCE(e.envelope->'payload', '{}'::jsonb)::text || ' ' || COALESCE(e.envelope->'sourceSpans', '[]'::jsonb)::text)
             @@ to_tsquery('simple', $3)
         AND NOT EXISTS (
           SELECT 1 FROM ${SQL.suppressions} s WHERE s.scope_id = e.scope_id AND s.event_id = e.event_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM ${SQL.assertions} represented
           JOIN ${SQL.versions} represented_v
             ON represented_v.scope_id = represented.scope_id
            AND represented_v.assertion_id = represented.assertion_id
            AND represented_v.revision = represented.current_revision
           WHERE represented.scope_id = e.scope_id
             AND represented.current_status = 'accepted'
             AND represented_v.status = 'accepted'
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(represented_v.version->'evidence', '[]'::jsonb)) linked
               WHERE linked->>'eventId' = e.event_id
             )
             AND ${visibilityPredicate('represented_v')}
         )
         -- A statement behind an earlier revision of a memory that was since
         -- corrected or changed is represented by that memory's history; shown
         -- as free-standing evidence it would bring the corrected text back.
         AND NOT EXISTS (
           SELECT 1
           FROM ${SQL.evidence} superseded
           JOIN ${SQL.assertions} lineage
             ON lineage.scope_id = superseded.scope_id AND lineage.assertion_id = superseded.assertion_id
           WHERE superseded.scope_id = e.scope_id
             AND superseded.event_id = e.event_id
             AND superseded.relation = 'supports'
             AND superseded.assertion_revision < lineage.current_revision
             AND lineage.current_status IN ('accepted', 'disputed')
         )
       ORDER BY ts_rank_cd(
         to_tsvector('simple', COALESCE(e.envelope->'payload', '{}'::jsonb)::text || ' ' || COALESCE(e.envelope->'sourceSpans', '[]'::jsonb)::text),
         to_tsquery('simple', $3)
       ) DESC, e.received_at DESC, e.event_id
       LIMIT $5`,
      [session.scope.id, session.principal.id, query, retrievalInstant(request), MAX_RETRIEVAL_SOURCE_EVENTS + 1],
    )
    const visible = rows.rows.slice(0, MAX_RETRIEVAL_SOURCE_EVENTS)
    return { documents: sourceDocuments(visible, session), epoch, truncated: rows.rows.length > MAX_RETRIEVAL_SOURCE_EVENTS }
  })
}

function validateProvider(provider: RetrievalEmbeddingProvider): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(provider.modelId)
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u.test(provider.modelVersion)
    && Number.isSafeInteger(provider.dimensions)
    && provider.dimensions >= 1
    && provider.dimensions <= 4_096
    && (provider.placement === 'local' || provider.placement === 'remote')
}

async function authorizeEmbeddingUse(
  session: MemorySession,
  provider: RetrievalEmbeddingProvider,
  authorizer: RemoteEmbeddingAuthorizer | undefined,
  purpose: 'query_embedding' | 'accepted_memory_index',
  documentCount: number,
): Promise<boolean> {
  if (provider.placement === 'local') return true
  if (!authorizer) return false
  return authorizer(session, { purpose, scopeId: session.scope.id, documentCount })
}

interface EmbeddingRow {
  assertion_id: string
  assertion_revision: string | number
  source_kind: RetrievalSourceKind
  source_ref: string
  source_event_id: string | null
  model_id: string
  model_version: string
  dimensions: number
  content_hash: string
  embedding: unknown
  version: unknown
  current_status: string
  current_revision: string | number
  slot_id: string | null
  subject_key: string
}

function embeddingVector(value: unknown, dimensions: number): number[] | null {
  if (!Array.isArray(value) || value.length !== dimensions || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) return null
  return value as number[]
}

async function searchSemantic(
  session: MemorySession<PostgresMemoryStore>,
  request: RetrievalRequest,
  signal: AbortSignal,
  provider: RetrievalEmbeddingProvider | undefined,
  authorizeRemote: RemoteEmbeddingAuthorizer | undefined,
): Promise<{ documents: RetrievalDocument[]; epoch: EpochRow; truncated: boolean; filtered: number; reason: string | null }> {
  if (!provider) throw opFailure('unavailable', 'No semantic embedding provider is configured for this retrieval turn.')
  if (!validateProvider(provider)) throw opFailure('validation', 'The semantic embedding provider metadata is invalid.')
  const queryText = buildRetrievalQueryPlan(request).text
  if (containsSecretLikeMaterial(queryText)) {
    return beginAuthorizedRead(session, request, signal, async (transaction) => ({
      documents: [], epoch: await readEpoch(transaction, session), truncated: false, filtered: 1, reason: 'sensitive_query_not_embedded',
    }))
  }
  if (!(await authorizeEmbeddingUse(session, provider, authorizeRemote, 'query_embedding', 1))) throw opFailure('unauthorized', 'Remote query embedding is disabled without current server-side authorization.')
  checkSignal(signal)
  const queryVectors = await provider.embed([queryText], signal)
  const queryVector = queryVectors.length === 1 ? queryVectors[0] : null
  if (!queryVector || queryVector.length !== provider.dimensions || !queryVector.every(Number.isFinite)) throw opFailure('unavailable', 'The semantic provider returned an invalid versioned vector.')
  const vectorQuery: EmbeddingQuery = { modelId: provider.modelId, modelVersion: provider.modelVersion, dimension: provider.dimensions, vector: queryVector }
  return beginAuthorizedRead(session, request, signal, async (transaction) => {
    const epoch = await readEpoch(transaction, session)
    const rows = await transaction.query<EmbeddingRow>(
      `SELECT e.assertion_id, e.assertion_revision, e.source_kind, e.source_ref, e.source_event_id,
              e.model_id, e.model_version, e.dimensions, e.content_hash, e.embedding,
              v.version, a.current_status, a.current_revision, a.slot_id, a.subject_key
       FROM ${SQL.embeddings} e
       JOIN ${SQL.assertions} a ON a.scope_id = e.scope_id AND a.assertion_id = e.assertion_id AND a.current_revision = e.assertion_revision
       JOIN ${SQL.versions} v ON v.scope_id = e.scope_id AND v.assertion_id = e.assertion_id AND v.revision = e.assertion_revision
       WHERE e.scope_id = $1
         AND e.model_id = $2 AND e.model_version = $3 AND e.dimensions = $4
         AND a.current_status = 'accepted' AND v.status = 'accepted'
         AND ${visibilityPredicate()}
         AND (e.source_event_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM ${SQL.suppressions} se WHERE se.scope_id = e.scope_id AND se.event_id = e.source_event_id
         ))
       ORDER BY e.created_at DESC, e.assertion_id, e.source_ref
       LIMIT $5`,
      [session.scope.id, provider.modelId, provider.modelVersion, provider.dimensions, MAX_RETRIEVAL_VECTOR_SCAN + 1],
    )
    const truncated = rows.rows.length > MAX_RETRIEVAL_VECTOR_SCAN
    const selectedRows = rows.rows.slice(0, MAX_RETRIEVAL_VECTOR_SCAN)
    const documents = makeAssertionDocumentRows(selectedRows.map((row) => ({
      assertion_id: row.assertion_id,
      revision: row.assertion_revision,
      current_revision: row.current_revision,
      current_status: row.current_status,
      slot_id: row.slot_id,
      subject_key: row.subject_key,
      version: row.version,
    })), request)
    const evidenceEventIds = [...new Set(selectedRows.flatMap((row) => row.source_kind === 'evidence' && row.source_event_id ? [row.source_event_id] : []))]
    const evidenceEvents = evidenceEventIds.length
      ? await transaction.query<EventRow>(
          `SELECT e.event_id, e.envelope
           FROM ${SQL.events} e
           WHERE e.scope_id = $1 AND e.event_id = ANY($2::text[])
             AND e.source_kind IN ('user_statement', 'user_correction')
             AND e.committed_phase IN ('committed', 'corrected')
             AND e.envelope #>> '{actor,kind}' = 'principal'
             AND e.envelope #>> '{actor,principalId}' = $3
             AND e.envelope #>> '{consent,purpose}' IN ('memory_capture', 'memory_retention')
             AND COALESCE(e.envelope #>> '{payload,mode}', '') NOT IN ('hypothetical', 'role_play', 'quotation')
             AND e.received_at <= $4::timestamptz
             AND NOT EXISTS (SELECT 1 FROM ${SQL.suppressions} s WHERE s.scope_id = e.scope_id AND s.event_id = e.event_id)
           ORDER BY e.event_id`,
          [session.scope.id, evidenceEventIds.slice(0, MAX_RETRIEVAL_SOURCE_EVENTS), session.principal.id, retrievalInstant(request)],
        )
      : { rows: [] as EventRow[] }
    const permittedSourceHashes = new Map<string, string>()
    const versionByReference = new Map(selectedRows.map((row) => [`${row.assertion_id}@${Number(row.assertion_revision)}`, row]))
    for (const row of selectedRows) {
      if (row.source_kind === 'evidence' || row.source_event_id !== null) continue
      const parsed = parseAssertionVersion(row.version)
      if (!parsed.ok || parsed.value.scopeId !== session.scope.id || parsed.value.id !== row.assertion_id || parsed.value.revision !== Number(row.assertion_revision)) continue
      const expectedKind = parsed.value.kind === 'episode_checkpoint' ? 'episode' : 'assertion'
      const expectedRef = `${expectedKind}/${parsed.value.id}/${parsed.value.revision}`
      const text = textOf(parsed.value).normalize('NFKC').trim()
      if (!containsSecretLikeMaterial(text) && row.source_kind === expectedKind && row.source_ref === expectedRef) permittedSourceHashes.set(`${row.assertion_id}@${Number(row.assertion_revision)}@${row.source_kind}@${row.source_ref}`, sha256(text))
    }
    for (const eventRow of evidenceEvents.rows) {
      const parsedEvent = parseEventEnvelope(eventRow.envelope)
      if (!parsedEvent.ok || parsedEvent.value.id !== eventRow.event_id || !permittedUserEvent(parsedEvent.value, session)) continue
      for (const [index, part] of sourceTextParts(parsedEvent.value).entries()) {
        const text = part.text.normalize('NFKC').trim()
        if (!text || text.length > MAX_EMBEDDING_DOCUMENT_CHARS || containsSecretLikeMaterial(text)) continue
        const sourceRef = `evidence/${parsedEvent.value.id}/${index}/${sha256(part.sourceRef).slice(0, 16)}`
        for (const row of selectedRows) {
          if (row.source_kind !== 'evidence' || row.source_event_id !== parsedEvent.value.id) continue
          const parent = versionByReference.get(`${row.assertion_id}@${Number(row.assertion_revision)}`)
          if (!parent) continue
          const parsedVersion = parseAssertionVersion(parent.version)
          if (!parsedVersion.ok || !parsedVersion.value.evidence.some((edge) => edge.eventId === parsedEvent.value.id)) continue
          permittedSourceHashes.set(`${row.assertion_id}@${Number(row.assertion_revision)}@evidence@${sourceRef}`, sha256(text))
        }
      }
    }
    const vectors: VersionedEmbedding[] = []
    let filtered = 0
    for (const row of selectedRows) {
      const vector = embeddingVector(row.embedding, row.dimensions)
      const expectedHash = permittedSourceHashes.get(`${row.assertion_id}@${Number(row.assertion_revision)}@${row.source_kind}@${row.source_ref}`)
      if (!vector || !/^[a-f0-9]{64}$/u.test(row.content_hash) || !expectedHash || expectedHash !== row.content_hash) {
        filtered += 1
        continue
      }
      vectors.push({
        scopeId: session.scope.id,
        reference: { assertionId: row.assertion_id as ExactVersionRef['assertionId'], revision: Number(row.assertion_revision) },
        sourceKind: row.source_kind,
        sourceRef: row.source_ref,
        sourceEventId: row.source_event_id,
        modelId: row.model_id,
        modelVersion: row.model_version,
        dimension: row.dimensions,
        contentHash: row.content_hash,
        vector,
      })
    }
    const ranked = exactVectorSearch(request, vectorQuery, vectors, documents, MAX_RETRIEVAL_BRANCH_CANDIDATES)
    return { documents: ranked.documents, epoch, truncated, filtered: filtered + ranked.filteredCandidateCount, reason: null }
  })
}

function embeddableAssertionText(version: AssertionVersion): { sourceKind: 'assertion' | 'episode'; sourceRef: string; text: string } {
  const sourceKind = version.kind === 'episode_checkpoint' ? 'episode' : 'assertion'
  return {
    sourceKind,
    sourceRef: `${sourceKind}/${version.id}/${version.revision}`,
    text: textOf(version).normalize('NFKC').trim(),
  }
}

async function prepareEmbeddableDocuments(
  session: MemorySession<PostgresMemoryStore>,
  references: readonly ExactVersionRef[],
  request: RetrievalRequest,
  signal: AbortSignal,
): Promise<{ documents: EmbeddableDocument[]; skippedSensitive: number }> {
  if (references.length > MAX_RETRIEVAL_INDEX_REFERENCES || references.some((reference) => !validRef(reference))) throw opFailure('validation', 'Embedding indexing accepts at most 16 exact version references.')
  return beginAuthorizedRead(session, request, signal, async (transaction) => {
    const refs = await transaction.query<AssertionRow>(
      `SELECT ${assertionSelect()}
       FROM unnest($2::text[], $3::bigint[]) requested(assertion_id, revision)
       JOIN ${SQL.assertions} a ON a.scope_id = $1 AND a.assertion_id = requested.assertion_id
       JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = requested.revision
       WHERE a.current_revision = v.revision AND a.current_status = 'accepted' AND v.status = 'accepted'
         AND ${visibilityPredicate()}
       ORDER BY a.assertion_id`,
      [session.scope.id, references.map((reference) => reference.assertionId), references.map((reference) => reference.revision)],
    )
    const documents: EmbeddableDocument[] = []
    const eventIds = new Set<string>()
    let skippedSensitive = 0
    for (const row of refs.rows) {
      const parsed = parseAssertionVersion(row.version)
      if (!parsed.ok || parsed.value.scopeId !== session.scope.id) continue
      const normalized = embeddableAssertionText(parsed.value)
      if (!normalized.text || normalized.text.length > MAX_EMBEDDING_DOCUMENT_CHARS || containsSecretLikeMaterial(normalized.text)) {
        skippedSensitive += 1
        continue
      }
      documents.push({
        scopeId: session.scope.id,
        reference: { assertionId: parsed.value.id, revision: parsed.value.revision },
        sourceKind: normalized.sourceKind,
        sourceRef: normalized.sourceRef,
        sourceEventId: null,
        text: normalized.text,
        contentHash: sha256(normalized.text),
      })
      for (const evidence of parsed.value.evidence) eventIds.add(evidence.eventId)
    }
    const boundedEventIds = [...eventIds].slice(0, MAX_RETRIEVAL_SOURCE_EVENTS)
    if (boundedEventIds.length) {
      const events = await transaction.query<EventRow>(
        `SELECT e.event_id, e.envelope
         FROM ${SQL.events} e
         WHERE e.scope_id = $1 AND e.event_id = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM ${SQL.suppressions} s WHERE s.scope_id = e.scope_id AND s.event_id = e.event_id)
         ORDER BY e.event_id`,
        [session.scope.id, boundedEventIds],
      )
      const refsByEvent = new Map<string, ExactVersionRef[]>()
      for (const row of refs.rows) {
        const parsed = parseAssertionVersion(row.version)
        if (!parsed.ok) continue
        for (const edge of parsed.value.evidence) {
          if (!boundedEventIds.includes(edge.eventId)) continue
          const list = refsByEvent.get(edge.eventId) ?? []
          list.push({ assertionId: parsed.value.id, revision: parsed.value.revision })
          refsByEvent.set(edge.eventId, list)
        }
      }
      for (const row of events.rows) {
        const parsed = parseEventEnvelope(row.envelope)
        if (!parsed.ok || parsed.value.id !== row.event_id || !permittedUserEvent(parsed.value, session)) continue
        const linkedRefs = refsByEvent.get(parsed.value.id) ?? []
        const parts = sourceTextParts(parsed.value)
        for (const reference of linkedRefs) {
          for (const [index, part] of parts.entries()) {
            const text = part.text.normalize('NFKC').trim()
            if (!text || text.length > MAX_EMBEDDING_DOCUMENT_CHARS || containsSecretLikeMaterial(text)) {
              skippedSensitive += 1
              continue
            }
            documents.push({
              scopeId: session.scope.id,
              reference,
              sourceKind: 'evidence',
              sourceRef: `evidence/${parsed.value.id}/${index}/${sha256(part.sourceRef).slice(0, 16)}`,
              sourceEventId: parsed.value.id,
              text,
              contentHash: sha256(text),
            })
            if (documents.length >= MAX_RETRIEVAL_SOURCE_SPANS + MAX_RETRIEVAL_INDEX_REFERENCES) break
          }
        }
      }
    }
    return { documents, skippedSensitive }
  })
}

/** Indexes only current accepted text obtained from this authenticated scope. No raw text is persisted. */
export async function indexAuthorizedEmbeddings(
  session: MemorySession,
  references: readonly ExactVersionRef[],
  provider: RetrievalEmbeddingProvider,
  options: { request: RetrievalRequest; signal?: AbortSignal; authorizeRemoteEmbedding?: RemoteEmbeddingAuthorizer },
): Promise<IndexEmbeddingsResult> {
  try {
    requirePostgresSession(session)
    if (!retrievalRequestMatchesSession(options.request, session)) return { status: 'unauthorized', indexed: 0, reason: 'request_identity_mismatch' }
    if (!validateProvider(provider)) return { status: 'unavailable', indexed: 0, reason: 'invalid_embedding_provider_metadata' }
    const localAbort = new AbortController()
    const onAbort = () => localAbort.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const prepared = await prepareEmbeddableDocuments(session, references, options.request, localAbort.signal)
      if (!prepared.documents.length) return { status: 'indexed', indexed: 0, skippedSensitive: prepared.skippedSensitive, skippedStale: references.length, modelId: provider.modelId, modelVersion: provider.modelVersion, dimension: provider.dimensions }
      if (!(await authorizeEmbeddingUse(session, provider, options.authorizeRemoteEmbedding, 'accepted_memory_index', prepared.documents.length))) {
        return { status: 'unauthorized', indexed: 0, reason: 'remote_memory_embedding_requires_server_authorization' }
      }
      const vectors: number[][] = []
      for (let offset = 0; offset < prepared.documents.length; offset += 16) {
        checkSignal(localAbort.signal)
        const batch = prepared.documents.slice(offset, offset + 16)
        const output = await provider.embed(batch.map((document) => document.text), localAbort.signal)
        if (output.length !== batch.length || output.some((vector) => vector.length !== provider.dimensions || vector.some((value) => !Number.isFinite(value)))) {
          return { status: 'unavailable', indexed: 0, reason: 'embedding_provider_returned_invalid_dimensions_or_values' }
        }
        vectors.push(...output.map((vector) => [...vector]))
      }

      const indexed = await session.store.forSession(session).runTransaction(async (transaction) => {
        checkSignal(localAbort.signal)
        const timeout = queryTimeoutMs(options.request, localAbort.signal)
        await transaction.query(`SELECT set_config('statement_timeout', $1, true)`, [`${timeout}ms`])
        await transaction.assertAuthorizedContext(session, 'recall')
        await readEpoch(transaction, session)
        const dimensions = await transaction.query<{ mismatch: string }>(
          `SELECT 1 AS mismatch FROM ${SQL.embeddings}
           WHERE scope_id = $1 AND model_id = $2 AND model_version = $3 AND dimensions <> $4 LIMIT 1`,
          [session.scope.id, provider.modelId, provider.modelVersion, provider.dimensions],
        )
        if (dimensions.rows.length) throw opFailure('conflict', 'An embedding model version is already stored with a different dimension; use a new model version.')
        const current = await transaction.query<{ assertion_id: string; revision: string | number; source_event_id: string | null }>(
          `SELECT a.assertion_id, a.current_revision AS revision, e.event_id AS source_event_id
           FROM ${SQL.assertions} a
           JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
           LEFT JOIN unnest($2::text[], $3::bigint[], $4::text[]) request(assertion_id, revision, source_event_id)
             ON request.assertion_id = a.assertion_id AND request.revision = a.current_revision
           LEFT JOIN ${SQL.events} e ON e.scope_id = a.scope_id AND e.event_id = request.source_event_id
           WHERE a.scope_id = $1 AND request.assertion_id IS NOT NULL
             AND a.current_status = 'accepted' AND v.status = 'accepted'
             AND ${visibilityPredicate()}
             AND (request.source_event_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM ${SQL.suppressions} source_suppressed
               WHERE source_suppressed.scope_id = a.scope_id AND source_suppressed.event_id = request.source_event_id
             ))`,
          [session.scope.id, prepared.documents.map((document) => document.reference.assertionId), prepared.documents.map((document) => document.reference.revision), prepared.documents.map((document) => document.sourceEventId)],
        )
        const visible = new Set(current.rows.map((row) => `${row.assertion_id}@${Number(row.revision)}@${row.source_event_id ?? ''}`))
        let count = 0
        for (const [index, document] of prepared.documents.entries()) {
          const key = `${document.reference.assertionId}@${document.reference.revision}@${document.sourceEventId ?? ''}`
          if (!visible.has(key)) continue
          await transaction.query(
            `INSERT INTO ${SQL.embeddings}
              (scope_id, assertion_id, assertion_revision, source_kind, source_ref, source_event_id,
               model_id, model_version, dimensions, content_hash, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
             ON CONFLICT (scope_id, assertion_id, assertion_revision, source_kind, source_ref, model_id, model_version)
             DO UPDATE SET dimensions = EXCLUDED.dimensions, content_hash = EXCLUDED.content_hash,
                           embedding = EXCLUDED.embedding, created_at = now()`,
            [session.scope.id, document.reference.assertionId, document.reference.revision, document.sourceKind, document.sourceRef, document.sourceEventId, provider.modelId, provider.modelVersion, provider.dimensions, document.contentHash, JSON.stringify(vectors[index])],
          )
          count += 1
        }
        return count
      })
      return { status: 'indexed', indexed, skippedSensitive: prepared.skippedSensitive, skippedStale: Math.max(0, prepared.documents.length - indexed), modelId: provider.modelId, modelVersion: provider.modelVersion, dimension: provider.dimensions }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    if (error instanceof RetrievalAbortError || (error instanceof Error && error.name === 'AbortError')) return { status: 'cancelled', indexed: 0, reason: 'embedding_index_cancelled' }
    if (error instanceof PostgresMemoryOperationError && error.failure.code === 'unauthorized') return { status: 'unauthorized', indexed: 0, reason: error.failure.message }
    return { status: 'unavailable', indexed: 0, reason: error instanceof Error ? error.message : 'embedding_index_unavailable' }
  }
}

async function hydrateAssertions(
  session: MemorySession<PostgresMemoryStore>,
  request: RetrievalRequest,
  references: readonly ExactVersionRef[],
  signal: AbortSignal,
): Promise<RetrievalDocument[]> {
  const uniqueRefs = [...new Map(references.filter(validRef).map((reference) => [`${reference.assertionId}@${reference.revision}`, reference])).values()].slice(0, 192)
  if (!uniqueRefs.length) return []
  return beginAuthorizedRead(session, request, signal, async (transaction) => {
    const result = await transaction.query<AssertionRow>(
      `SELECT ${assertionSelect()}
       FROM unnest($2::text[], $3::bigint[]) requested(assertion_id, revision)
       JOIN ${SQL.assertions} a ON a.scope_id = $1 AND a.assertion_id = requested.assertion_id
       JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = requested.revision
       WHERE ${temporalPredicate(request, 'v', 4)} AND ${visibilityPredicate()}
       ORDER BY a.assertion_id, v.revision DESC`,
      [session.scope.id, uniqueRefs.map((reference) => reference.assertionId), uniqueRefs.map((reference) => reference.revision), retrievalInstant(request)],
    )
    return makeAssertionDocumentRows(result.rows, request)
  })
}

async function hydrateSourceEvents(
  session: MemorySession<PostgresMemoryStore>,
  request: RetrievalRequest,
  eventIds: readonly string[],
  signal: AbortSignal,
  maxFetches: number,
): Promise<RetrievalDocument[]> {
  const boundedIds = [...new Set(eventIds)].slice(0, Math.min(Math.max(maxFetches, 0), MAX_RETRIEVAL_SOURCE_EVENTS))
  if (!boundedIds.length) return []
  return beginAuthorizedRead(session, request, signal, async (transaction) => {
    const result = await transaction.query<EventRow>(
      `SELECT e.event_id, e.envelope
       FROM ${SQL.events} e
       WHERE e.scope_id = $1 AND e.event_id = ANY($2::text[])
         AND e.received_at <= $3::timestamptz
         AND NOT EXISTS (SELECT 1 FROM ${SQL.suppressions} s WHERE s.scope_id = e.scope_id AND s.event_id = e.event_id)
       ORDER BY e.received_at DESC, e.event_id
       LIMIT $4`,
      [session.scope.id, boundedIds, retrievalInstant(request), boundedIds.length],
    )
    return sourceDocuments(result.rows, session)
  })
}

async function expandRelatedReferences(
  session: MemorySession<PostgresMemoryStore>,
  request: RetrievalRequest,
  seedReferences: readonly ExactVersionRef[],
  maxExpansionEdges: number,
  signal: AbortSignal,
): Promise<{ references: ExactVersionRef[]; edges: number }> {
  const seeds = [...new Set(seedReferences.filter(validRef).map((reference) => reference.assertionId))].slice(0, 32)
  const limit = Math.min(Math.max(maxExpansionEdges, 0), 32)
  if (!seeds.length || !limit) return { references: [], edges: 0 }
  return beginAuthorizedRead(session, request, signal, async (transaction) => {
    const result = await transaction.query<{ assertion_id: string; assertion_revision: string | number }>(
      `SELECT DISTINCT d.assertion_id, d.assertion_revision
       FROM ${SQL.dependencies} d
       WHERE d.scope_id = $1 AND d.dependency_type = 'assertion'
         AND d.dependency_id = ANY($2::text[])
       ORDER BY d.assertion_id, d.assertion_revision
       LIMIT $3`,
      [session.scope.id, [...seeds, ...seeds.map((id) => `assertion/${id}`)], limit + 1],
    )
    const visited = new Set(seedReferences.map((reference) => `${reference.assertionId}@${reference.revision}`))
    const selected: ExactVersionRef[] = []
    for (const row of result.rows.slice(0, limit)) {
      const reference = { assertionId: row.assertion_id as ExactVersionRef['assertionId'], revision: Number(row.assertion_revision) }
      const key = `${reference.assertionId}@${reference.revision}`
      if (visited.has(key)) continue
      visited.add(key)
      selected.push(reference)
    }
    return { references: selected, edges: Math.min(result.rows.length, limit) }
  })
}

async function currentAuthorityEpoch(session: MemorySession<PostgresMemoryStore>, request: RetrievalRequest, signal: AbortSignal): Promise<EpochRow> {
  return beginAuthorizedRead(session, request, signal, (transaction) => readEpoch(transaction, session))
}

function emptyBranch(status: RetrievalBranchCoverage['status'], reason: string | null = null): BranchResult {
  return { status, documents: [], reason, candidates: 0, filtered: 0 }
}

async function captureBranch(work: () => Promise<BranchResult>, signal: AbortSignal): Promise<BranchResult> {
  try {
    checkSignal(signal)
    return await work()
  } catch (error) {
    if (signal.aborted || error instanceof RetrievalAbortError || (error instanceof Error && error.name === 'AbortError')) return emptyBranch('cancelled', 'retrieval_cancelled')
    if (error instanceof RetrievalTimeoutError || (error instanceof Error && (error.name === 'TimeoutError' || /statement timeout|canceling statement/iu.test(error.message)))) return emptyBranch('timed_out', 'shared_deadline_exceeded')
    if (error instanceof PostgresMemoryOperationError) return emptyBranch(error.failure.code === 'unauthorized' ? 'unavailable' : 'unavailable', `${error.failure.code}:${error.failure.message}`)
    return emptyBranch('unavailable', error instanceof Error ? error.message : 'retrieval_branch_unavailable')
  }
}

function toPackCoverage(
  request: RetrievalRequest,
  branches: RetrievalCoverageParts,
  epoch: EpochRow | null,
  outcome: 'complete' | 'partial' | 'unavailable' | 'exhausted',
  candidateCount: number,
  filteredCandidateCount: number,
  expansionEdges: number,
  evidenceFetches: number,
  freshness: RetrievalCoverageParts['freshness'],
  observedAt: string,
) {
  return {
    outcome,
    branches: {
      exact: branches.exact,
      warm: branches.warm,
      lexical: branches.lexical,
      semantic: branches.semantic,
      evidence: branches.evidence,
    },
    candidateCount,
    filteredCandidateCount,
    expansionEdges,
    evidenceFetches,
    noResultMeansAbsence: false as const,
    authority: {
      principalId: request.authenticatedContext.principalId,
      scopeId: request.authenticatedContext.scopeId,
      policyEpoch: epoch ? Number(epoch.policy_epoch) : request.authenticatedContext.policyEpoch,
      deletionEpoch: epoch ? Number(epoch.deletion_epoch) : null,
    },
    freshness: { state: freshness, observedAt, watermark: null },
  }
}

interface RetrievalCoverageParts {
  exact: RetrievalBranchCoverage
  warm: RetrievalBranchCoverage
  lexical: RetrievalBranchCoverage
  semantic: RetrievalBranchCoverage
  evidence: RetrievalBranchCoverage
  freshness: 'authoritative' | 'warm' | 'cold' | 'stale' | 'unavailable'
}

function branchCoverage(result: BranchResult | WarmResult): RetrievalBranchCoverage {
  return { status: result.status, candidates: result.candidates, reason: result.reason }
}

function docsById(documents: readonly RetrievalDocument[]): Map<string, RetrievalDocument> {
  return new Map(documents.map((document) => [document.id, document]))
}

function hydrateBranchDocuments(documents: readonly RetrievalDocument[], hydrated: ReadonlyMap<string, RetrievalDocument>): RetrievalDocument[] {
  return documents.flatMap((document) => {
    const authoritative = hydrated.get(document.id)
    return authoritative ? [authoritative] : []
  })
}

function refsOf(documents: readonly RetrievalDocument[]): ExactVersionRef[] {
  return documents.flatMap((document) => document.reference ? [document.reference] : [])
}

function outputFailure(error: unknown, request: RetrievalRequest | null = null): RetrieveMemoryFailure {
  if (error instanceof PostgresMemoryOperationError) return { ok: false, request, pack: null, failure: error.failure }
  if (error instanceof RetrievalAbortError || (error instanceof Error && error.name === 'AbortError')) return { ok: false, request, pack: null, failure: { code: 'unavailable', message: 'Retrieval was cancelled before a current context pack could be returned.', retryable: true } }
  if (error instanceof RetrievalTimeoutError || (error instanceof Error && error.name === 'TimeoutError')) return { ok: false, request, pack: null, failure: { code: 'unavailable', message: 'The shared retrieval deadline expired before authoritative hydration completed.', retryable: true } }
  return { ok: false, request, pack: null, failure: { code: 'unavailable', message: error instanceof Error ? error.message : 'Memory retrieval is unavailable.', retryable: true } }
}

/**
 * Executes exact/entity/decision, warm lexical, PostgreSQL lexical, semantic,
 * and original-source fallback branches under a shared deadline. No private
 * content is returned unless its exact current version/event survives an
 * authorized, suppression-aware hydration and a final epoch recheck.
 */
export async function retrieveMemory(
  session: MemorySession,
  input: unknown,
  options: RetrieveMemoryOptions = {},
): Promise<RetrieveMemoryResult> {
  let request: RetrievalRequest | null = null
  try {
    requirePostgresSession(session)
    const parsed = createRetrievalRequest(session, input, { now: options.now })
    if (!parsed.ok) return { ok: false, request: null, pack: null, failure: { code: parsed.failure.code, message: parsed.failure.message, retryable: false } }
    request = parsed.request
    if (!retrievalRequestMatchesSession(request, session)) throw opFailure('unauthorized', 'The retrieval request identity does not match its authenticated server session.')

    const deep = await runBoundedDeepRecall(request, async ({ signal, limits }) => {
      const initialEpoch = await currentAuthorityEpoch(session, request!, signal)
      const [exactRaw, lexicalRaw, semanticRaw, evidenceRaw, warmRaw] = await Promise.all([
        captureBranch(async () => {
          const result = await searchExactAndConstraints(session, request!, signal)
          const truncated = result.truncatedExact || result.truncatedConstraints
          return { status: truncated ? 'partial' : 'complete', documents: [...result.exact, ...result.constraints], reason: result.truncatedExact ? 'exact_branch_limit_reached' : result.truncatedConstraints ? 'constraint_index_limit_reached' : null, candidates: result.exact.length + result.constraints.length, filtered: 0 }
        }, signal),
        captureBranch(async () => {
          const result = await searchLexical(session, request!, signal)
          return { status: result.truncated ? 'partial' : 'complete', documents: result.documents, reason: result.truncated ? 'lexical_branch_limit_reached' : null, candidates: result.documents.length, filtered: 0 }
        }, signal),
        options.embeddingProvider
          ? captureBranch(async () => {
              const result = await searchSemantic(session, request!, signal, options.embeddingProvider, options.authorizeRemoteEmbedding)
              return { status: result.truncated ? 'partial' : 'complete', documents: result.documents, reason: result.reason, candidates: result.documents.length, filtered: result.filtered }
            }, signal)
          : Promise.resolve(emptyBranch('not_configured', 'semantic_provider_not_configured')),
        options.ablate?.sourceEvidence ? Promise.resolve(emptyBranch('not_configured', 'ablated_source_evidence')) : captureBranch(async () => {
          const result = await searchSourceEvidence(session, request!, signal)
          return { status: result.truncated ? 'partial' : 'complete', documents: result.documents, reason: result.truncated ? 'source_evidence_limit_reached' : null, candidates: result.documents.length, filtered: 0 }
        }, signal),
        (async (): Promise<WarmResult> => {
          try {
            return await searchWarmSnapshot(session, request!, signal)
          } catch (error) {
            const branch = await captureBranch(async () => { throw error }, signal)
            return { ...branch, snapshot: null }
          }
        })(),
      ])

      const exactDocuments = exactRaw.documents
      const lexicalDocuments = lexicalRaw.documents
      const semanticDocuments = semanticRaw.documents
      const evidenceDocuments = evidenceRaw.documents
      const warmDocuments = warmRaw.documents
      const constraintDocuments = options.ablate?.applicability ? [] : exactDocuments.filter((document) => document.kind === 'constraint' || (document.kind === 'preference' && document.temporalRelation === 'temporary_exception'))
      const snapshotConstraintHints = warmRaw.snapshot && !options.ablate?.applicability
        ? warmSnapshotDocuments(warmRaw.snapshot).filter((document) => document.kind === 'constraint' || (document.kind === 'preference' && document.temporalRelation === 'temporary_exception'))
        : []
      const allInitial = [...exactDocuments, ...lexicalDocuments, ...semanticDocuments, ...warmDocuments, ...snapshotConstraintHints]
      const assertionRefs = refsOf(allInitial)
      const initialEvidenceEventIds = evidenceDocuments.flatMap((document) => document.sourceEventId ? [document.sourceEventId] : [])
      const maxEvidenceFetches = Math.min(limits.maxEvidenceFetches, options.maxEvidenceFetches ?? limits.maxEvidenceFetches)
      const [hydratedAssertions, hydratedEvidence] = await Promise.all([
        hydrateAssertions(session as MemorySession<PostgresMemoryStore>, request!, assertionRefs, signal),
        hydrateSourceEvents(session as MemorySession<PostgresMemoryStore>, request!, initialEvidenceEventIds, signal, maxEvidenceFetches),
      ])
      const hydratedMap = docsById(hydratedAssertions)
      const evidenceMap = docsById(hydratedEvidence)
      const exactHydrated = hydrateBranchDocuments(exactDocuments, hydratedMap)
      const lexicalHydrated = hydrateBranchDocuments(lexicalDocuments, hydratedMap)
      const semanticHydrated = hydrateBranchDocuments(semanticDocuments, hydratedMap)
      const warmHydrated = hydrateBranchDocuments(warmDocuments, hydratedMap)
      const constraintsHydrated = hydrateBranchDocuments([...constraintDocuments, ...snapshotConstraintHints], hydratedMap)
      const sourceEvidenceHydrated = hydrateBranchDocuments(evidenceDocuments, evidenceMap)
      const assertionEvidenceHydrated = hydrateBranchDocuments(hydratedEvidence, evidenceMap)
      const evidenceById = docsById([...sourceEvidenceHydrated, ...assertionEvidenceHydrated])
      const allEvidenceHydrated = [...evidenceById.values()].slice(0, maxEvidenceFetches)

      const rankedSeeds = fuseRetrievalBranches([
        { name: 'exact', documents: exactHydrated.filter((document) => !constraintDocuments.includes(document)), reason: 'exact_key_entity_or_active_decision' },
        { name: 'lexical', documents: lexicalHydrated, reason: 'postgresql_full_text' },
        { name: 'semantic', documents: semanticHydrated, reason: 'versioned_exact_vector' },
        { name: 'warm_lexical', documents: warmHydrated, reason: 'fresh_warm_snapshot_hint' },
      ], 16)
      const expansion = await expandRelatedReferences(
        session as MemorySession<PostgresMemoryStore>,
        request!,
        rankedSeeds.map((candidate) => candidate.document).flatMap((document) => document.reference ? [document.reference] : []),
        options.ablate?.relationships ? 0 : limits.maxExpansionEdges,
        signal,
      )
      const relatedDocuments = await hydrateAssertions(session as MemorySession<PostgresMemoryStore>, request!, expansion.references, signal)
      const branchList: CandidateBranch[] = [
        { name: 'exact', documents: exactHydrated.filter((document) => !constraintDocuments.some((constraint) => constraint.id === document.id)), reason: 'exact_key_entity_or_active_decision' },
        { name: 'lexical', documents: lexicalHydrated, reason: 'postgresql_full_text' },
        ...(semanticRaw.status === 'not_configured' ? [] : [{ name: 'semantic' as const, documents: semanticHydrated, reason: 'versioned_exact_vector' }]),
        { name: 'warm_lexical', documents: warmHydrated, reason: 'fresh_warm_snapshot_hint' },
        { name: 'relationship', documents: relatedDocuments, reason: 'bounded_dependency_edge_expansion' },
        { name: 'evidence', documents: allEvidenceHydrated, reason: 'bounded_permitted_source_evidence' },
        { name: 'relationship', documents: constraintsHydrated, reason: 'constraint_applicability_index_independent_of_overlap' },
      ]
      const candidates = fuseRetrievalBranches(branchList, MAX_RETRIEVAL_BRANCH_CANDIDATES)
      const constraints = options.ablate?.applicability ? [] : selectApplicableConstraints(
        request!,
        [...candidates.map((candidate) => candidate.document), ...constraintsHydrated],
        (warmRaw.snapshot?.constraints ?? []).filter((entry) => hydratedMap.has(`assertion:${entry.assertion.assertionId}:${entry.assertion.revision}`)),
      )
      const finalEpoch = await currentAuthorityEpoch(session as MemorySession<PostgresMemoryStore>, request!, signal)
      if (Number(finalEpoch.policy_epoch) !== Number(initialEpoch.policy_epoch) || Number(finalEpoch.deletion_epoch) !== Number(initialEpoch.deletion_epoch)) {
        throw opFailure('conflict', 'Memory changed during retrieval; stale candidates were withheld.', true)
      }

      const branches: RetrievalCoverageParts = {
        exact: branchCoverage({ ...exactRaw, documents: exactHydrated }),
        warm: branchCoverage(warmRaw),
        lexical: branchCoverage(lexicalRaw),
        semantic: branchCoverage(semanticRaw),
        evidence: branchCoverage({ ...evidenceRaw, documents: allEvidenceHydrated, candidates: allEvidenceHydrated.length }),
        freshness: warmRaw.snapshot ? 'warm' : warmRaw.status === 'unavailable' ? 'unavailable' : 'authoritative',
      }
      const anyTimedOut = Object.values(branches).some((branch) => typeof branch === 'object' && 'status' in branch && ['timed_out', 'cancelled'].includes(branch.status))
      const anyUnavailable = [exactRaw, lexicalRaw, semanticRaw, evidenceRaw, warmRaw].some((branch) => branch.status === 'unavailable')
      const anyPartial = [exactRaw, lexicalRaw, semanticRaw, evidenceRaw, warmRaw].some((branch) => branch.status === 'partial')
      const allUnavailable = [exactRaw, lexicalRaw, semanticRaw, evidenceRaw].every((branch) => ['unavailable', 'timed_out', 'cancelled'].includes(branch.status))
      const outcome = allUnavailable ? 'unavailable' : anyTimedOut || anyUnavailable || anyPartial || semanticRaw.status === 'unavailable' ? 'partial' : 'complete'
      const candidateCount = exactRaw.candidates + lexicalRaw.candidates + semanticRaw.candidates + warmRaw.candidates + evidenceRaw.candidates
      const hydrationFiltered = Math.max(0, assertionRefs.length - hydratedAssertions.length)
      const filtered = exactRaw.filtered + lexicalRaw.filtered + semanticRaw.filtered + evidenceRaw.filtered + hydrationFiltered
      const coverage = toPackCoverage(
        request!,
        branches,
        finalEpoch,
        outcome,
        candidateCount,
        filtered,
        expansion.edges,
        allEvidenceHydrated.length,
        branches.freshness,
        new Date().toISOString(),
      )
      const unavailableReason = allUnavailable
        ? 'All authoritative retrieval branches were unavailable; no search result can establish absence.'
        : [exactRaw, lexicalRaw, semanticRaw, evidenceRaw, warmRaw].map((branch) => branch.reason).filter(Boolean).join('; ') || null
      const pack = composeContextPack({ request: request!, coverage, candidates, constraints, unavailableReason }, options.tokenizer)
      return {
        pack,
        diagnostics: {
          lexicalCandidates: lexicalRaw.candidates,
          semanticCandidates: semanticRaw.candidates,
          exactCandidates: exactRaw.candidates,
          warmCandidates: warmRaw.candidates,
          sourceEvidenceCandidates: evidenceRaw.candidates,
          hydratedCandidates: hydratedAssertions.length + allEvidenceHydrated.length,
          filteredCandidates: filtered,
          expansionEdges: expansion.edges,
          evidenceFetches: allEvidenceHydrated.length,
        },
      }
    }, {
      signal: options.signal,
      maxExpansionEdges: options.maxExpansionEdges,
      maxEvidenceFetches: options.maxEvidenceFetches,
    })

    if (deep.status === 'complete') {
      return {
        ok: true,
        request,
        pack: deep.value.pack,
        diagnostics: deep.value.diagnostics,
      }
    }
    const timedOut = deep.status === 'timed_out'
    const cancelled = deep.status === 'cancelled'
    const state: RetrievalCoverageParts = {
      exact: { status: cancelled ? 'cancelled' : 'timed_out', candidates: 0, reason: deep.status },
      warm: { status: 'not_configured', candidates: 0, reason: 'retrieval_did_not_complete' },
      lexical: { status: cancelled ? 'cancelled' : 'timed_out', candidates: 0, reason: deep.status },
      semantic: { status: 'not_configured', candidates: 0, reason: 'retrieval_did_not_complete' },
      evidence: { status: cancelled ? 'cancelled' : 'timed_out', candidates: 0, reason: deep.status },
      freshness: 'unavailable',
    }
    const coverage = toPackCoverage(request, state, null, 'exhausted', 0, 0, 0, 0, 'unavailable', new Date().toISOString())
    const pack = composeContextPack({ request, coverage, candidates: [], constraints: [], unavailableReason: timedOut ? 'Shared retrieval deadline expired; this is not evidence of absence.' : 'Retrieval was cancelled; this is not evidence of absence.' }, options.tokenizer)
    return { ok: true, request, pack, diagnostics: { lexicalCandidates: 0, semanticCandidates: 0, exactCandidates: 0, warmCandidates: 0, sourceEvidenceCandidates: 0, hydratedCandidates: 0, filteredCandidates: 0, expansionEdges: 0, evidenceFetches: 0 } }
  } catch (error) {
    return outputFailure(error, request)
  }
}
