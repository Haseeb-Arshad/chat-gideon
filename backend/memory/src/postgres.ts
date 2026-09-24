import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg'
import {
  evaluateGrant,
  parseAssertionVersion,
  parseEventEnvelope,
  parseReceipt,
  type AssertionCommit,
  type AssertionVersion,
  type CanonicalSlot,
  type DependencyRef,
  type EventEnvelope,
  type ExactVersionRef,
  type MemoryFailure,
  type MemoryAction,
  type MemoryReceipt,
  type MemorySession,
  type MemoryStorageCapabilities,
  type MemoryStorageTransaction,
  type OutboxLease,
  type ScopeId,
  type ScopedCandidateQuery,
  type PrincipalId,
} from '../../../src/lib/memory/contracts.ts'
import { DEFAULT_MEMORY_ACCEPTED_ASSERTION_QUOTA, MEMORY_SCHEMA, memoryPostgresConfig } from './config.ts'
import { assertionVersionHash, canonicalJson, eventContentHash, isoNow, subjectKey } from './serialization.ts'

const SQL = {
  principals: `${MEMORY_SCHEMA}.principals`,
  scopes: `${MEMORY_SCHEMA}.scopes`,
  grants: `${MEMORY_SCHEMA}.grants`,
  policyEpochs: `${MEMORY_SCHEMA}.policy_epochs`,
  events: `${MEMORY_SCHEMA}.events`,
  receipts: `${MEMORY_SCHEMA}.receipts`,
  assertions: `${MEMORY_SCHEMA}.assertions`,
  versions: `${MEMORY_SCHEMA}.assertion_versions`,
  evidence: `${MEMORY_SCHEMA}.evidence_edges`,
  dependencies: `${MEMORY_SCHEMA}.dependency_edges`,
  jobs: `${MEMORY_SCHEMA}.jobs`,
  slots: `${MEMORY_SCHEMA}.slot_locks`,
  suppressions: `${MEMORY_SCHEMA}.deletion_suppressions`,
  quotas: `${MEMORY_SCHEMA}.quota_limits`,
  commandReceipts: `${MEMORY_SCHEMA}.command_receipts`,
  changeCounters: `${MEMORY_SCHEMA}.change_counters`,
  changeFeed: `${MEMORY_SCHEMA}.change_feed`,
} as const

export interface PostgresMemoryContext {
  principalId: PrincipalId
  scopeId: ScopeId
  policyEpoch: number
}

export class PostgresMemoryOperationError extends Error {
  readonly name = 'PostgresMemoryOperationError'

  constructor(readonly failure: MemoryFailure) {
    super(failure.message)
  }
}

function failure(code: MemoryFailure['code'], message: string, retryable = false, details?: MemoryFailure['details']): PostgresMemoryOperationError {
  return new PostgresMemoryOperationError({ code, message, retryable, ...(details ? { details } : {}) })
}

function requireContext(context: PostgresMemoryContext | null): PostgresMemoryContext {
  if (!context) throw failure('unauthorized', 'A scope-bound server memory context is required.')
  return context
}

function parseStoredEvent(value: unknown): EventEnvelope {
  const parsed = parseEventEnvelope(value)
  if (!parsed.ok) throw failure('unavailable', 'Canonical memory data failed validation.', false)
  return parsed.value
}

function parseStoredAssertion(value: unknown): AssertionVersion {
  const parsed = parseAssertionVersion(value)
  if (!parsed.ok) throw failure('unavailable', 'Canonical memory data failed validation.', false)
  return parsed.value
}

function parseStoredReceipt(value: unknown): MemoryReceipt {
  const parsed = parseReceipt(value)
  if (!parsed.ok) throw failure('unavailable', 'A stored memory receipt failed validation.', false)
  return parsed.value
}

function subjectParts(subject: EventEnvelope['subject']): { kind: string; id: string | null; label: string | null } {
  return subject.kind === 'known'
    ? { kind: 'known', id: subject.subjectId, label: null }
    : { kind: 'unresolved', id: null, label: subject.label }
}

function receiptCaptured(eventId: EventEnvelope['id'], receivedAt: string): MemoryReceipt {
  return {
    schemaVersion: 1,
    receiptId: `receipt/${eventId}`,
    eventId,
    receivedAt,
    ok: true,
    state: 'captured',
    canonicalRevision: null,
    indexWatermark: null,
  }
}

function receiptFailure(eventId: EventEnvelope['id'] | null, receivedAt: string, operationFailure: MemoryFailure): MemoryReceipt {
  return {
    schemaVersion: 1,
    receiptId: `receipt/failure/${crypto.randomUUID()}`,
    eventId,
    receivedAt,
    ok: false,
    state: 'failed',
    canonicalRevision: null,
    indexWatermark: null,
    failure: operationFailure,
  }
}

interface EventRow {
  event_id: string
  content_hash: string
  envelope: unknown
}

export class PostgresMemoryTransaction implements MemoryStorageTransaction {
  constructor(
    readonly client: PoolClient,
    readonly context: PostgresMemoryContext | null,
  ) {}

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    return this.client.query<T>(text, [...values])
  }

  private scope(): PostgresMemoryContext {
    return requireContext(this.context)
  }

  /**
   * A restore guard is a control-plane fail-closed switch. An absent row is
   * treated as ready for scopes created before Stage 05; once a guard exists,
   * no durable read or write proceeds until its ledger watermark is caught up.
   */
  async assertRecoveryReady(): Promise<void> {
    const context = this.scope()
    const result = await this.query<{ status: 'ready' | 'blocked'; required_ledger_sequence: string; reconciled_ledger_sequence: string }>(
      `SELECT status, required_ledger_sequence, reconciled_ledger_sequence
       FROM ${MEMORY_SCHEMA}.recovery_guards
       WHERE scope_id = $1
       FOR SHARE`,
      [context.scopeId],
    )
    const guard = result.rows[0]
    if (guard && (guard.status === 'blocked' || Number(guard.reconciled_ledger_sequence) < Number(guard.required_ledger_sequence))) {
      throw failure('unavailable', 'Memory authority is unavailable until the deletion and revocation ledger is reconciled.', true, { reason: 'restore_reconciliation_pending' })
    }
  }

  async isVersionSuppressed(reference: ExactVersionRef, evidenceEventIds: readonly string[] = []): Promise<boolean> {
    if (await this.isSuppressed(reference)) return true
    for (const eventId of evidenceEventIds) {
      if (await this.isSuppressed({ eventId: eventId as EventEnvelope['id'] })) return true
    }
    return false
  }

  async assertAuthorizedContext(
    session: Pick<MemorySession, 'trust' | 'principal' | 'scope' | 'policyEpoch' | 'grants'>,
    action: MemoryAction,
  ): Promise<void> {
    const context = this.scope()
    if (session.trust !== 'authenticated' || session.principal.id !== context.principalId || session.scope.id !== context.scopeId) {
      throw failure('unauthorized', 'This memory session is not authorized for the requested scope.')
    }
    const decision = evaluateGrant(session, action, context.scopeId)
    if (!decision.allowed) throw new PostgresMemoryOperationError(decision.failure)
    const result = await this.query<{ policy_epoch: string; principal_trust: string; recovery_status: string; required_ledger_sequence: string; reconciled_ledger_sequence: string }>(
      `
        SELECT p.trust AS principal_trust, e.policy_epoch,
               COALESCE(r.status, 'ready') AS recovery_status,
               COALESCE(r.required_ledger_sequence, 0) AS required_ledger_sequence,
               COALESCE(r.reconciled_ledger_sequence, 0) AS reconciled_ledger_sequence
        FROM ${SQL.principals} p
        JOIN ${SQL.grants} g ON g.principal_id = p.principal_id AND g.scope_id = $2
        JOIN ${SQL.policyEpochs} e ON e.scope_id = g.scope_id
        LEFT JOIN ${MEMORY_SCHEMA}.recovery_guards r ON r.scope_id = g.scope_id
        WHERE p.principal_id = $1
          AND p.trust = 'authenticated'
          AND g.issued_by = 'server_policy'
          AND g.revoked_at IS NULL
          AND g.actions @> $3::jsonb
          AND (g.expires_at IS NULL OR g.expires_at > now())
        LIMIT 1
      `,
      [context.principalId, context.scopeId, JSON.stringify([action])],
    )
    if (!result.rows[0]) throw failure('unauthorized', 'The database has no active grant for this memory scope.')
    if (result.rows[0].recovery_status === 'blocked' || Number(result.rows[0].reconciled_ledger_sequence) < Number(result.rows[0].required_ledger_sequence)) {
      throw failure('unavailable', 'Memory authority is unavailable until the deletion and revocation ledger is reconciled.', true, { reason: 'restore_reconciliation_pending' })
    }
    if (Number(result.rows[0].policy_epoch) !== context.policyEpoch || Number(result.rows[0].policy_epoch) !== session.policyEpoch) {
      throw failure('conflict', 'The memory policy changed; retry with a fresh session.', true)
    }
  }

  async assertTrustedContext(session: Pick<MemorySession, 'trust' | 'principal' | 'scope' | 'policyEpoch' | 'grants'>): Promise<void> {
    return this.assertAuthorizedContext(session, 'capture')
  }

  async findEventByIdempotency(idempotencyKey: string): Promise<EventEnvelope | null> {
    const context = this.scope()
    const result = await this.query<EventRow>(
      `SELECT event_id, content_hash, envelope FROM ${SQL.events} WHERE scope_id = $1 AND idempotency_key = $2`,
      [context.scopeId, idempotencyKey],
    )
    return result.rows[0] ? parseStoredEvent(result.rows[0].envelope) : null
  }

  async findEventRecordByIdempotency(idempotencyKey: string): Promise<EventRow | null> {
    const context = this.scope()
    const result = await this.query<EventRow>(
      `SELECT event_id, content_hash, envelope FROM ${SQL.events} WHERE scope_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [context.scopeId, idempotencyKey],
    )
    return result.rows[0] ?? null
  }

  async insertEvent(event: EventEnvelope): Promise<'inserted' | 'duplicate'> {
    const context = this.scope()
    const parts = subjectParts(event.subject)
    const result = await this.query(
      `
        INSERT INTO ${SQL.events}
          (event_id, scope_id, principal_id, idempotency_key, content_hash, subject_kind, subject_id, subject_label,
           source_kind, source_authority_kind, committed_phase, event_sequence, received_at, envelope)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::jsonb)
        -- No arbiter: a racing duplicate can collide on the event_id primary key
        -- or the sequence before the idempotency key, and a targeted ON CONFLICT
        -- turned that into an error reported as "unavailable". The caller
        -- re-reads by idempotency key and resolves real conflicts itself.
        ON CONFLICT DO NOTHING
      `,
      [
        event.id,
        context.scopeId,
        context.principalId,
        event.idempotencyKey,
        eventContentHash(context.scopeId, event),
        parts.kind,
        parts.id,
        parts.label,
        event.sourceKind,
        event.sourceAuthority.kind,
        event.committedPhase,
        event.sequence,
        event.receivedAt,
        canonicalJson(event),
      ],
    )
    return result.rowCount === 1 ? 'inserted' : 'duplicate'
  }

  async exactVersion(reference: ExactVersionRef): Promise<AssertionVersion | null> {
    const context = this.scope()
    const result = await this.query<{ version: unknown }>(
      `
        SELECT v.version
        FROM ${SQL.versions} v
        WHERE v.scope_id = $1 AND v.assertion_id = $2 AND v.revision = $3
      `,
      [context.scopeId, reference.assertionId, reference.revision],
    )
    if (!result.rows[0]) return null
    const version = parseStoredAssertion(result.rows[0].version)
    return await this.isVersionSuppressed(reference, version.evidence.map((edge) => edge.eventId)) ? null : version
  }

  async scopedCandidates(query: ScopedCandidateQuery): Promise<readonly AssertionVersion[]> {
    const context = this.scope()
    if (query.scopeId !== context.scopeId) throw failure('unauthorized', 'That scope is not available to this transaction.')
    const limit = Math.min(Math.max(query.limit, 1), 100)
    const queryText = query.query.trim()
    const requestedSubject = subjectKey(query.subject)
    const result = await this.query<{ version: unknown }>(
      `
        SELECT v.version
        FROM ${SQL.assertions} a
        JOIN ${SQL.versions} v ON v.assertion_id = a.assertion_id AND v.revision = a.current_revision
        WHERE a.scope_id = $1
          AND a.subject_key = $2
          AND a.current_status IN ('candidate', 'accepted', 'disputed')
          AND ($3 = '' OR v.version::text ILIKE ('%' || replace(replace(replace($3, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%') ESCAPE '\\')
        ORDER BY a.updated_at DESC
        LIMIT $4
      `,
      [context.scopeId, requestedSubject, queryText, limit],
    )
    const visible: AssertionVersion[] = []
    for (const row of result.rows) {
      const version = parseStoredAssertion(row.version)
      if (!await this.isVersionSuppressed({ assertionId: version.id, revision: version.revision }, version.evidence.map((edge) => edge.eventId))) {
        visible.push(version)
      }
    }
    return visible
  }

  async currentVersion(assertionId: AssertionVersion['id']): Promise<AssertionVersion | null> {
    const context = this.scope()
    const result = await this.query<{ version: unknown }>(
      `
        SELECT v.version
        FROM ${SQL.assertions} a
        JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
        WHERE a.scope_id = $1 AND a.assertion_id = $2
      `,
      [context.scopeId, assertionId],
    )
    if (!result.rows[0]) return null
    const version = parseStoredAssertion(result.rows[0].version)
    return await this.isVersionSuppressed({ assertionId: version.id, revision: version.revision }, version.evidence.map((edge) => edge.eventId)) ? null : version
  }

  async allVersions(assertionId: AssertionVersion['id']): Promise<readonly AssertionVersion[]> {
    const context = this.scope()
    const result = await this.query<{ version: unknown }>(
      `SELECT version FROM ${SQL.versions} WHERE scope_id = $1 AND assertion_id = $2 ORDER BY revision`,
      [context.scopeId, assertionId],
    )
    const visible: AssertionVersion[] = []
    for (const row of result.rows) {
      const version = parseStoredAssertion(row.version)
      if (!await this.isVersionSuppressed({ assertionId: version.id, revision: version.revision }, version.evidence.map((edge) => edge.eventId))) {
        visible.push(version)
      }
    }
    return visible
  }

  async findCanonicalAssertion(canonicalKey: string): Promise<AssertionVersion | null> {
    const context = this.scope()
    const result = await this.query<{ version: unknown }>(
      `
        SELECT v.version
        FROM ${SQL.assertions} a
        JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
        WHERE a.scope_id = $1 AND a.canonical_key = $2
          AND a.current_status IN ('candidate', 'accepted', 'disputed')
        LIMIT 1
      `,
      [context.scopeId, canonicalKey],
    )
    if (!result.rows[0]) return null
    const version = parseStoredAssertion(result.rows[0].version)
    return await this.isVersionSuppressed({ assertionId: version.id, revision: version.revision }, version.evidence.map((edge) => edge.eventId)) ? null : version
  }

  /**
   * A canonical identity whose current version is suppressed cannot be reused
   * while that suppression is in force. Privacy deletion clears the key itself
   * (it is a content hash), so a deleted command stays blocked through its
   * retained event suppression, not through this identity.
   */
  async isCanonicalKeySuppressed(canonicalKey: string): Promise<boolean> {
    const context = this.scope()
    const result = await this.query<{ assertion_id: string; current_revision: string; current_status: string; version: unknown | null }>(
      `
        SELECT a.assertion_id, a.current_revision, a.current_status, v.version
        FROM ${SQL.assertions} a
        LEFT JOIN ${SQL.versions} v
          ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
        WHERE a.scope_id = $1 AND a.canonical_key = $2
        LIMIT 1
      `,
      [context.scopeId, canonicalKey],
    )
    const row = result.rows[0]
    if (!row) return false
    if (row.current_status === 'deleted') return true
    if (!row.version) return false
    const version = parseStoredAssertion(row.version)
    return this.isVersionSuppressed({ assertionId: version.id, revision: version.revision }, version.evidence.map((edge) => edge.eventId))
  }

  async nextEventSequence(): Promise<number> {
    const context = this.scope()
    const epoch = await this.query<{ scope_id: string }>(
      `SELECT scope_id FROM ${SQL.policyEpochs} WHERE scope_id = $1 FOR UPDATE`,
      [context.scopeId],
    )
    if (!epoch.rows[0]) throw failure('unavailable', 'The memory policy epoch is unavailable.', true)
    const result = await this.query<{ next_sequence: string }>(
      `SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next_sequence FROM ${SQL.events} WHERE scope_id = $1`,
      [context.scopeId],
    )
    return Number(result.rows[0]?.next_sequence ?? 1)
  }

  async sourceRevisionsFor(reference: ExactVersionRef): Promise<readonly string[]> {
    const context = this.scope()
    const result = await this.query<{ envelope: unknown }>(
      `
        SELECT e.envelope
        FROM ${SQL.evidence} edge
        JOIN ${SQL.events} e ON e.scope_id = edge.scope_id AND e.event_id = edge.event_id
        WHERE edge.scope_id = $1 AND edge.assertion_id = $2 AND edge.assertion_revision = $3
      `,
      [context.scopeId, reference.assertionId, reference.revision],
    )
    return result.rows.flatMap((row) => {
      try {
        const event = parseStoredEvent(row.envelope)
        return [event.sourceAuthority.revision]
      } catch {
        return []
      }
    })
  }

  async withSlotLock<T>(scopeId: ScopeId, slot: CanonicalSlot, work: () => Promise<T>): Promise<T> {
    const context = this.scope()
    if (scopeId !== context.scopeId) throw failure('unauthorized', 'That slot is outside this transaction scope.')
    await this.query(
      `
        INSERT INTO ${SQL.slots} (scope_id, slot_id, cardinality)
        VALUES ($1, $2, $3)
        ON CONFLICT (scope_id, slot_id) DO NOTHING
      `,
      [scopeId, slot.slotId, slot.cardinality],
    )
    const lock = await this.query<{ cardinality: string }>(
      `SELECT cardinality FROM ${SQL.slots} WHERE scope_id = $1 AND slot_id = $2 FOR UPDATE`,
      [scopeId, slot.slotId],
    )
    if (!lock.rows[0] || lock.rows[0].cardinality !== slot.cardinality) {
      throw failure('conflict', 'The canonical slot cardinality is already registered differently.')
    }
    return work()
  }

  async commitAssertion(input: AssertionCommit): Promise<{ ok: true; revision: number } | { ok: false; failure: MemoryFailure }> {
    const context = this.scope()
    const assertion = input.assertion
    if (assertion.scopeId !== context.scopeId) return { ok: false, failure: { code: 'unauthorized', message: 'The assertion scope does not match the transaction.', retryable: false } }
    if (assertion.status === 'deleted') return { ok: false, failure: { code: 'suppressed', message: 'Deleted memory cannot be committed.', retryable: false } }
    if (input.canonicalKey && await this.isCanonicalKeySuppressed(input.canonicalKey)) {
      return { ok: false, failure: { code: 'suppressed', message: 'A privacy-deleted canonical identity cannot be reused.', retryable: false } }
    }

    const eventIds = [...new Set(assertion.evidence.map((edge) => edge.eventId))]
    if (eventIds.length) {
      const evidenceEvents = await this.query<{ event_id: string }>(
        `SELECT event_id FROM ${SQL.events} WHERE scope_id = $1 AND event_id = ANY($2::text[])`,
        [context.scopeId, eventIds],
      )
      if (evidenceEvents.rows.length !== eventIds.length) return { ok: false, failure: { code: 'not_found', message: 'An assertion source event is not available in this scope.', retryable: false } }
      for (const eventId of eventIds) {
        if (await this.isSuppressed({ eventId: eventId as EventEnvelope['id'] })) {
          return { ok: false, failure: { code: 'suppressed', message: 'A suppressed source cannot produce a durable assertion.', retryable: false } }
        }
      }
    }

    if (input.slot?.cardinality === 'scalar') {
      const occupied = await this.query<{ assertion_id: string }>(
        `
          SELECT assertion_id
          FROM ${SQL.assertions}
          WHERE scope_id = $1 AND subject_key = $2 AND slot_id = $3
            AND slot_cardinality = 'scalar' AND current_status <> 'deleted'
            AND assertion_id <> $4
          FOR UPDATE
        `,
        [context.scopeId, subjectKey(assertion.subject), input.slot.slotId, assertion.id],
      )
      if (occupied.rows[0]) return { ok: false, failure: { code: 'conflict', message: 'A scalar slot already has a canonical assertion.', retryable: false } }
    }

    let current = await this.query<{ current_revision: string; scope_id: string }>(
      `SELECT current_revision, scope_id FROM ${SQL.assertions} WHERE assertion_id = $1 FOR UPDATE`,
      [assertion.id],
    )
    if (!current.rows[0]) {
      try {
        await this.query(
          `
            INSERT INTO ${SQL.assertions}
              (assertion_id, scope_id, subject_kind, subject_key, slot_id, slot_cardinality, current_revision, current_status, canonical_key)
            VALUES ($1, $2, $3, $4, $5, $6, 0, 'candidate', $7)
            ON CONFLICT (assertion_id) DO NOTHING
          `,
          [assertion.id, context.scopeId, assertion.subject.kind, subjectKey(assertion.subject), input.slot?.slotId ?? null, input.slot?.cardinality ?? null, input.canonicalKey ?? null],
        )
      } catch (error) {
        if (input.canonicalKey && typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          return { ok: false, failure: { code: 'suppressed', message: 'A privacy-deleted canonical identity cannot be reused.', retryable: false } }
        }
        throw error
      }
      current = await this.query<{ current_revision: string; scope_id: string }>(
        `SELECT current_revision, scope_id FROM ${SQL.assertions} WHERE assertion_id = $1 FOR UPDATE`,
        [assertion.id],
      )
    }
    if (!current.rows[0]) return { ok: false, failure: { code: 'unavailable', message: 'The assertion row could not be established.', retryable: true } }
    if (current.rows[0].scope_id !== context.scopeId) return { ok: false, failure: { code: 'unauthorized', message: 'The assertion belongs to another scope.', retryable: false } }

    const currentRevision = Number(current.rows[0].current_revision)
    const incomingHash = assertionVersionHash(assertion)
    if (assertion.revision <= currentRevision) {
      const existing = await this.query<{ version_hash: string }>(
        `SELECT version_hash FROM ${SQL.versions} WHERE assertion_id = $1 AND revision = $2`,
        [assertion.id, assertion.revision],
      )
      if (existing.rows[0]?.version_hash === incomingHash) return { ok: true, revision: assertion.revision }
      return { ok: false, failure: { code: 'conflict', message: 'The assertion revision already contains different content.', retryable: false } }
    }
    if (input.expectedRevision !== null && currentRevision !== input.expectedRevision) {
      return { ok: false, failure: { code: 'conflict', message: 'The assertion changed before this result committed.', retryable: true, details: { currentRevision } } }
    }
    if (assertion.revision !== currentRevision + 1) {
      return { ok: false, failure: { code: 'conflict', message: 'Assertion revisions must advance exactly once.', retryable: false, details: { currentRevision } } }
    }

    const inserted = await this.query(
      `
        INSERT INTO ${SQL.versions} (assertion_id, revision, scope_id, version_hash, version, status)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        ON CONFLICT (assertion_id, revision) DO NOTHING
      `,
      [assertion.id, assertion.revision, context.scopeId, incomingHash, canonicalJson(assertion), assertion.status],
    )
    if (inserted.rowCount !== 1) {
      const existing = await this.query<{ version_hash: string }>(
        `SELECT version_hash FROM ${SQL.versions} WHERE assertion_id = $1 AND revision = $2`,
        [assertion.id, assertion.revision],
      )
      if (existing.rows[0]?.version_hash === incomingHash) return { ok: true, revision: assertion.revision }
      return { ok: false, failure: { code: 'conflict', message: 'The assertion revision was committed differently.', retryable: false } }
    }
    for (const edge of assertion.evidence) {
      await this.query(
        `
          INSERT INTO ${SQL.evidence} (scope_id, assertion_id, assertion_revision, event_id, relation, source_span)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          ON CONFLICT DO NOTHING
        `,
        [context.scopeId, assertion.id, assertion.revision, edge.eventId, edge.relation, edge.span ? canonicalJson(edge.span) : null],
      )
    }
    for (const dependency of assertion.dependencies) {
      await this.query(
        `
          INSERT INTO ${SQL.dependencies}
            (scope_id, assertion_id, assertion_revision, dependency_type, dependency_id, dependency_revision)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
        `,
        [context.scopeId, assertion.id, assertion.revision, dependency.type, dependency.id, dependency.revision],
      )
    }
    await this.query(
      `UPDATE ${SQL.assertions}
       SET current_revision = $2, current_status = $3,
           canonical_key = COALESCE($4, canonical_key), updated_at = now()
       WHERE assertion_id = $1`,
      [assertion.id, assertion.revision, assertion.status, input.canonicalKey ?? null],
    )
    return { ok: true, revision: assertion.revision }
  }

  async leaseOutbox(limit: number, now: string, leaseMs: number): Promise<readonly OutboxLease[]> {
    const context = this.scope()
    const boundedLimit = Math.min(Math.max(limit, 1), 100)
    const workerId = `compat/${crypto.randomUUID()}`
    const leasedUntil = new Date(Date.parse(now) + Math.max(1, leaseMs)).toISOString()
    const result = await this.query<{ job_id: string; input_event_id: string; attempts: number; fence: string | number; lease_until: string }>(
      `
        WITH picked AS (
          SELECT job_id
          FROM ${SQL.jobs}
          WHERE scope_id = $1
           AND state IN ('pending', 'retry', 'running')
             AND NOT EXISTS (
               SELECT 1 FROM ${MEMORY_SCHEMA}.recovery_guards g
               WHERE g.scope_id = ${SQL.jobs}.scope_id
                 AND (g.status = 'blocked' OR g.reconciled_ledger_sequence < g.required_ledger_sequence)
             )
            AND available_at <= $2::timestamptz
            AND (lease_until IS NULL OR lease_until <= $2::timestamptz)
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        UPDATE ${SQL.jobs} j
        SET state = 'running', attempts = j.attempts + 1, lease_until = $4::timestamptz,
            fence = j.fence + 1, worker_id = $5, updated_at = now()
        FROM picked
        WHERE j.job_id = picked.job_id
        RETURNING j.job_id, j.input_event_id, j.attempts, j.fence, j.lease_until
      `,
      [context.scopeId, now, boundedLimit, leasedUntil, workerId],
    )
    return result.rows.map((row) => ({
      id: row.job_id,
      inputEventId: row.input_event_id as EventEnvelope['id'],
      leaseRevision: `fence/${row.fence}` as OutboxLease['leaseRevision'],
      leasedUntil: row.lease_until,
      attempt: row.attempts,
    }))
  }

  async isSuppressed(target: ExactVersionRef | { eventId: EventEnvelope['id'] }): Promise<boolean> {
    const context = this.scope()
    const result = 'eventId' in target
      ? await this.query(
          `SELECT 1 FROM ${SQL.suppressions} WHERE scope_id = $1 AND event_id = $2 LIMIT 1`,
          [context.scopeId, target.eventId],
        )
      : await this.query(
          `SELECT 1 FROM ${SQL.suppressions} WHERE scope_id = $1 AND assertion_id = $2 AND assertion_revision = $3 LIMIT 1`,
          [context.scopeId, target.assertionId, target.revision],
        )
    return result.rows.length > 0
  }

  async dependenciesFor(reference: ExactVersionRef): Promise<readonly DependencyRef[]> {
    const context = this.scope()
    const result = await this.query<{ dependency_type: DependencyRef['type']; dependency_id: string; dependency_revision: string }>(
      `
        SELECT d.dependency_type, d.dependency_id, d.dependency_revision
        FROM ${SQL.dependencies} d
        JOIN ${SQL.versions} v ON v.assertion_id = d.assertion_id AND v.revision = d.assertion_revision
        WHERE v.scope_id = $1 AND d.assertion_id = $2 AND d.assertion_revision = $3
        ORDER BY d.dependency_type, d.dependency_id
      `,
      [context.scopeId, reference.assertionId, reference.revision],
    )
    return result.rows.map((row) => ({ type: row.dependency_type, id: row.dependency_id, revision: row.dependency_revision as DependencyRef['revision'] }))
  }

  async readReceiptByEvent(eventId: string): Promise<MemoryReceipt | null> {
    const context = this.scope()
    const result = await this.query<{ receipt: unknown }>(
      `
        SELECT r.receipt
        FROM ${SQL.receipts} r
        JOIN ${SQL.events} e ON e.event_id = r.event_id
        WHERE e.scope_id = $1 AND r.event_id = $2
      `,
      [context.scopeId, eventId],
    )
    return result.rows[0] ? parseStoredReceipt(result.rows[0].receipt) : null
  }

  async insertCaptureJob(event: EventEnvelope): Promise<void> {
    await this.insertJob(event, 'interpret_event')
  }

  async insertProjectionJob(event: EventEnvelope): Promise<void> {
    await this.insertJob(event, 'rebuild_projection')
  }

  private async insertJob(event: EventEnvelope, kind: 'interpret_event' | 'rebuild_projection'): Promise<void> {
    const context = this.scope()
    const epoch = await this.query<{ policy_epoch: string; deletion_epoch: string }>(
      `SELECT policy_epoch, deletion_epoch FROM ${SQL.policyEpochs} WHERE scope_id = $1 FOR SHARE`,
      [context.scopeId],
    )
    if (!epoch.rows[0]) throw failure('unavailable', 'The memory policy epoch is unavailable.', true)
    await this.query(
      `
        INSERT INTO ${SQL.jobs}
          (job_id, scope_id, principal_id, input_event_id, kind, state, attempts, max_attempts, available_at, policy_epoch, deletion_epoch)
        VALUES ($1, $2, $3, $4, $5, 'pending', 0, 5, $6::timestamptz, $7, $8)
        ON CONFLICT (input_event_id, kind) DO NOTHING
      `,
      [`job/${event.id}/${kind}`, context.scopeId, context.principalId, event.id, kind, event.receivedAt, epoch.rows[0].policy_epoch, epoch.rows[0].deletion_epoch],
    )
  }

  async insertCapturedReceipt(receipt: MemoryReceipt, eventId: string): Promise<void> {
    await this.query(
      `
        INSERT INTO ${SQL.receipts} (receipt_id, event_id, state, receipt)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (event_id) DO NOTHING
      `,
      [receipt.receiptId, eventId, receipt.state, canonicalJson(receipt)],
    )
  }

  async updateReceipt(receipt: MemoryReceipt, eventId: string): Promise<void> {
    await this.query(
      `UPDATE ${SQL.receipts} SET state = $3, receipt = $4::jsonb, updated_at = now() WHERE event_id = $1 AND receipt_id = $2`,
      [eventId, receipt.receiptId, receipt.state, canonicalJson(receipt)],
    )
  }
}

export interface CaptureOptions {
  now?: string
  /** Allocate a unique scope sequence inside the authorized transaction. */
  assignSequence?: boolean
  injectFailureAfterEventInsert?: boolean
}

/**
 * The Node host loads the SSR bundle and the realtime bundle into one process,
 * each with its own copy of this class, and they share one store through a
 * global. `instanceof` fails across those copies, so authority checks use this
 * registered brand instead.
 */
const POSTGRES_STORE_BRAND = Symbol.for('gideon.memory.postgres-store.v1')

export function isPostgresMemoryStore(value: unknown): value is PostgresMemoryStore {
  return typeof value === 'object' && value !== null && (value as { [POSTGRES_STORE_BRAND]?: unknown })[POSTGRES_STORE_BRAND] === true
}

export class PostgresMemoryStore implements MemoryStorageCapabilities {
  readonly [POSTGRES_STORE_BRAND] = true

  constructor(
    readonly pool: Pool,
    readonly context: PostgresMemoryContext | null = null,
  ) {}

  forSession(session: Pick<MemorySession, 'principal' | 'scope' | 'policyEpoch'>): PostgresMemoryStore {
    return this.forContext({ principalId: session.principal.id, scopeId: session.scope.id, policyEpoch: session.policyEpoch })
  }

  forContext(context: PostgresMemoryContext): PostgresMemoryStore {
    return new PostgresMemoryStore(this.pool, context)
  }

  async runTransaction<T>(work: (transaction: PostgresMemoryTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const transaction = new PostgresMemoryTransaction(client, this.context)
      const result = await work(transaction)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  transaction<T>(work: (transaction: PostgresMemoryTransaction) => Promise<T>): Promise<T> {
    return this.runTransaction(work)
  }

  async provisionTrustedContext(session: Pick<MemorySession, 'trust' | 'principal' | 'scope' | 'grants' | 'policyEpoch'>): Promise<void> {
    if (session.trust !== 'authenticated') throw failure('unauthorized', 'Ephemeral sessions cannot provision durable memory.')
    const store = this.forSession(session)
    await store.runTransaction(async (transaction) => {
      await transaction.query(
        `
          INSERT INTO ${SQL.principals} (principal_id, principal_kind, trust)
          VALUES ($1, $2, $3)
          ON CONFLICT (principal_id) DO UPDATE SET principal_kind = EXCLUDED.principal_kind, trust = EXCLUDED.trust
        `,
        [session.principal.id, session.principal.kind, session.trust],
      )
      await transaction.query(
        `
          INSERT INTO ${SQL.scopes} (scope_id, scope_kind, parent_scope_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (scope_id) DO NOTHING
        `,
        [session.scope.id, session.scope.kind, session.scope.parentId],
      )
      await transaction.query(
        `
          INSERT INTO ${SQL.policyEpochs} (scope_id, policy_epoch, deletion_epoch)
          VALUES ($1, $2, 0)
          ON CONFLICT (scope_id) DO NOTHING
        `,
        [session.scope.id, session.policyEpoch],
      )
      await transaction.query(
        `
          INSERT INTO ${SQL.quotas} (scope_id, max_accepted_assertions)
          VALUES ($1, $2)
          ON CONFLICT (scope_id) DO NOTHING
        `,
        [session.scope.id, DEFAULT_MEMORY_ACCEPTED_ASSERTION_QUOTA],
      )
      await transaction.query(
        `
          INSERT INTO ${SQL.changeCounters} (scope_id, next_watermark)
          VALUES ($1, 0)
          ON CONFLICT (scope_id) DO NOTHING
        `,
        [session.scope.id],
      )
      for (const grant of session.grants) {
        if (grant.scopeId !== session.scope.id) continue
        await transaction.query(
          `
            INSERT INTO ${SQL.grants} (grant_id, principal_id, scope_id, actions, issued_by, expires_at)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz)
            ON CONFLICT (grant_id) DO UPDATE SET principal_id = EXCLUDED.principal_id, scope_id = EXCLUDED.scope_id,
              actions = EXCLUDED.actions, issued_by = EXCLUDED.issued_by,
              expires_at = CASE WHEN gideon_memory.grants.revoked_at IS NULL THEN EXCLUDED.expires_at ELSE gideon_memory.grants.expires_at END,
              revoked_at = gideon_memory.grants.revoked_at
          `,
          [grant.id, session.principal.id, session.scope.id, canonicalJson(grant.actions), grant.issuedBy, grant.expiresAt],
      )
      }
      await transaction.query(
        `
          INSERT INTO ${MEMORY_SCHEMA}.recovery_guards (scope_id, status, required_ledger_sequence, reconciled_ledger_sequence)
          VALUES ($1, 'ready', 0, 0)
          ON CONFLICT (scope_id) DO NOTHING
        `,
        [session.scope.id],
      )
    })
  }

  async captureEvent(
    session: Pick<MemorySession, 'trust' | 'principal' | 'scope' | 'grants' | 'policyEpoch'>,
    event: EventEnvelope,
    options: CaptureOptions = {},
  ): Promise<MemoryReceipt> {
    const now = options.now ?? isoNow()
    const parsed = parseEventEnvelope(event)
    if (!parsed.ok) return receiptFailure(null, now, { code: 'validation', message: 'The memory event is invalid.', retryable: false })
    if (session.trust !== 'authenticated') return receiptFailure(null, now, { code: 'unauthorized', message: 'Only authenticated sessions can capture durable memory.', retryable: false })
    if (!session.grants.some((grant) => grant.scopeId === session.scope.id && grant.actions.includes('capture'))) {
      return receiptFailure(null, now, { code: 'unauthorized', message: 'This session has no capture grant.', retryable: false })
    }
    if (!event.consent || !['memory_capture', 'memory_retention'].includes(event.consent.purpose)) {
      return receiptFailure(event.id, now, { code: 'validation', message: 'Durable capture requires a memory consent reference.', retryable: false })
    }
    if (event.actor.kind === 'principal' && event.actor.principalId !== session.principal.id) {
      return receiptFailure(event.id, now, { code: 'unauthorized', message: 'The event actor does not match the authenticated session.', retryable: false })
    }

    const store = this.forSession(session)
    try {
      return await store.runTransaction(async (transaction) => {
        await transaction.assertTrustedContext(session)
        const existing = await transaction.findEventRecordByIdempotency(parsed.value.idempotencyKey)
        const incomingHash = eventContentHash(session.scope.id, parsed.value)
        if (existing) {
          if (existing.content_hash !== incomingHash) {
            return receiptFailure(existing.event_id as EventEnvelope['id'], now, {
              code: 'conflict',
              message: 'This idempotency key is already bound to different content.',
              retryable: false,
              details: { reason: 'idempotency_content_conflict' },
            })
          }
          const existingReceipt = await transaction.readReceiptByEvent(existing.event_id)
          return existingReceipt ?? receiptCaptured(existing.event_id as EventEnvelope['id'], now)
        }
        const committedEvent = options.assignSequence
          ? { ...parsed.value, sequence: await transaction.nextEventSequence() }
          : parsed.value
        const insertResult = await transaction.insertEvent(committedEvent)
        if (insertResult !== 'inserted') {
          // A concurrent capture with this key committed while this insert
          // waited on the unique index. Under READ COMMITTED the new statement
          // sees that row, so an identical duplicate gets the original receipt.
          const winner = await transaction.findEventRecordByIdempotency(parsed.value.idempotencyKey)
          if (!winner) throw failure('conflict', 'The event was concurrently claimed; retry the same idempotency key.', true)
          if (winner.content_hash !== incomingHash) {
            return receiptFailure(winner.event_id as EventEnvelope['id'], now, {
              code: 'conflict',
              message: 'This idempotency key is already bound to different content.',
              retryable: false,
              details: { reason: 'idempotency_content_conflict' },
            })
          }
          return await transaction.readReceiptByEvent(winner.event_id) ?? receiptCaptured(winner.event_id as EventEnvelope['id'], now)
        }
        if (options.injectFailureAfterEventInsert) throw new Error('injected capture crash after event insert')
        const receipt = receiptCaptured(committedEvent.id, now)
        await transaction.insertCapturedReceipt(receipt, committedEvent.id)
        await transaction.insertCaptureJob(committedEvent)
        return receipt
      })
    } catch (error) {
      if (options.injectFailureAfterEventInsert) throw error
      if (error instanceof PostgresMemoryOperationError) return receiptFailure(event.id, now, error.failure)
      return receiptFailure(event.id, now, { code: 'unavailable', message: 'Memory authority is unavailable; no durable receipt was committed.', retryable: true })
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export function createPostgresMemoryStore(config: PoolConfig = memoryPostgresConfig()): PostgresMemoryStore {
  return new PostgresMemoryStore(new Pool(config))
}
