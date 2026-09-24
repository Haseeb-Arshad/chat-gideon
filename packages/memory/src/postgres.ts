import {
  assertionIdFor,
  assertionText,
  captureCommittedEvent,
  checkRunningJob,
  claimJobs,
  executeExplicitCommand,
  executeForgetCommand,
  finishCheckedJob,
  readAssertionAsOf,
  type PostgresMemoryStore,
} from '../../../backend/memory/src/index.ts'
import { MEMORY_CONTRACT_VERSION, type AssertionVersion, type ConsentId, type EventEnvelope, type MemorySession, type RevisionId } from '../../../src/lib/memory/contracts.ts'
import { EphemeralMemoryStore } from '../../../src/lib/tools/memory.ts'
import { createServerMemorySession } from '../../../src/server/memory-session.ts'
import {
  LIMITS,
  MemoryError,
  STORED_SCHEMA_VERSION,
  type CallOptions,
  type Capabilities,
  type ClaimedJob,
  type MemoryBackend,
  type MemoryItem,
  type MemoryKind,
  type MemoryRevision,
  type Page,
  type Scope,
  type WriteResult,
} from './contract.ts'
import { sha256, terms } from './text.ts'

/**
 * The PostgreSQL backend: the ChatGideon memory authority behind the portable
 * contract. Writes go through the proven Stage 04/05 commands (canonical
 * slots, revision checks, suppression, ledger); reads are narrow queries over
 * the same tables. One principal owns one scope here, so a scope whose id is
 * not its principal is unsupported rather than approximated.
 */

const S = 'gideon_memory'

interface Bound extends MemorySession { store: PostgresMemoryStore }

const BASIS: Record<string, MemoryItem['basis']> = {
  explicit_user_statement: 'explicit',
  user_correction: 'correction',
  imported_legacy: 'imported',
}

function failure(code: string, message: string): MemoryError {
  const known = ['validation', 'unauthorized', 'conflict', 'not_found', 'suppressed', 'unavailable'] as const
  if (code === 'budget_exhausted') return new MemoryError('quota', message)
  if (code === 'ambiguous') return new MemoryError('conflict', message)
  return new MemoryError((known as readonly string[]).includes(code) ? code as typeof known[number] : 'unavailable', message, code === 'unavailable')
}

export class PostgresMemoryBackend implements MemoryBackend {
  readonly capabilities: Capabilities = Object.freeze({
    backend: 'postgres',
    storedSchemaVersion: STORED_SCHEMA_VERSION,
    atomicWrites: true,
    optimisticRevisions: true,
    idempotentCommands: true,
    temporal: 'valid_at',
    suppression: 'content_removed',
    crossProcessWriters: 'database_locking',
    fencedJobLeases: true,
    lexicalSearch: 'full_text',
    semanticSearch: false,
  } as const)

  private readonly provisioned = new Set<string>()

  constructor(private readonly store: PostgresMemoryStore) {}

  private async session(scope: Scope, provision: boolean): Promise<Bound> {
    if (scope.scopeId !== scope.principalId) throw new MemoryError('unsupported', 'The PostgreSQL backend binds one scope to its own principal.')
    const session = { ...createServerMemorySession({ owner: scope.scopeId, store: new EphemeralMemoryStore(), channel: 'worker_http', authority: 'worker_internal_owner' }), store: this.store } as Bound
    if (provision && !this.provisioned.has(scope.scopeId)) {
      await this.store.provisionTrustedContext(session)
      this.provisioned.add(scope.scopeId)
    }
    return session
  }

  private item(row: { assertion_id: string; version: AssertionVersion; created_at: Date | string }): MemoryItem {
    const version = row.version
    return {
      id: row.assertion_id,
      revision: version.revision,
      kind: version.kind as MemoryKind,
      text: assertionText(version),
      validFrom: version.time.validTime.from,
      validUntil: version.time.validTime.until,
      basis: BASIS[version.attribution.basis] ?? 'explicit',
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: version.time.receivedAt,
    }
  }

  private async currentRow(scope: Scope, id: string): Promise<MemoryItem | null> {
    const result = await this.store.pool.query<{ assertion_id: string; version: AssertionVersion; created_at: Date }>(
      `SELECT a.assertion_id, v.version, a.created_at FROM ${S}.assertions a
       JOIN ${S}.assertion_versions v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
       WHERE a.scope_id = $1 AND a.assertion_id = $2 AND a.current_status = 'accepted'
         AND NOT EXISTS (SELECT 1 FROM ${S}.deletion_suppressions s WHERE s.scope_id = a.scope_id AND s.assertion_id = a.assertion_id)`,
      [scope.scopeId, id],
    )
    return result.rows[0] ? this.item(result.rows[0]) : null
  }

  private async commandSeen(scope: Scope, commandId: string): Promise<boolean> {
    const result = await this.store.pool.query(`SELECT 1 FROM ${S}.command_receipts WHERE scope_id = $1 AND command_id = $2`, [scope.scopeId, commandId])
    return result.rows.length > 0
  }

  /** A command whose memory was forgotten is refused, not replayed into a new one (its receipt may already be purged). */
  private async assertNotForgotten(scope: Scope, commandId: string): Promise<void> {
    const assertionId = assertionIdFor(scope.scopeId, commandId)
    const result = await this.store.pool.query<{ gone: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${S}.deletion_suppressions WHERE scope_id = $1 AND assertion_id = $2)
           OR EXISTS (SELECT 1 FROM ${S}.assertions WHERE scope_id = $1 AND assertion_id = $2 AND current_status = 'deleted') AS gone`,
      [scope.scopeId, assertionId],
    )
    if (result.rows[0]?.gone) throw new MemoryError('suppressed', 'This command created a memory that was forgotten; it is not replayed.')
  }

  async remember(scope: Scope, input: { commandId: string; text: string; kind: MemoryKind; validFrom?: string | null; basis?: 'explicit' | 'imported'; sourceId?: string }, options: CallOptions = {}): Promise<WriteResult> {
    const session = await this.session(scope, true)
    await this.assertNotForgotten(scope, input.commandId)
    if (input.sourceId) {
      const source = await this.store.pool.query<{ gone: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${S}.deletion_suppressions WHERE scope_id = $1 AND assertion_id = $2)
             OR EXISTS (SELECT 1 FROM ${S}.assertions WHERE scope_id = $1 AND assertion_id = $2 AND current_status = 'deleted') AS gone`,
        [scope.scopeId, input.sourceId],
      )
      if (source.rows[0]?.gone) throw new MemoryError('suppressed', 'This memory was forgotten; an older export cannot bring it back.')
    }
    const seen = await this.commandSeen(scope, input.commandId)
    const result = await executeExplicitCommand(session, {
      schemaVersion: 1, commandId: input.commandId, kind: 'remember', text: input.text, assertionKind: input.kind, conditions: [],
      ...(input.validFrom ? { validTime: { from: input.validFrom, until: null, precision: 'second', sourceTimeZone: null } } : {}),
    }, { now: options.now, ...(input.basis === 'imported' ? { origin: { kind: 'import', importId: 'import/portable', exportedAt: null } } : {}) })
    if (!result.ok) throw failure(result.failure.code, result.failure.message)
    const item = await this.currentRow(scope, result.assertion.id)
    if (!item) throw new MemoryError('suppressed', 'The memory this command names is no longer available.')
    return { outcome: seen ? 'replayed' : result.outcome === 'duplicate' ? 'duplicate' : 'created', item }
  }

  async correct(scope: Scope, input: { commandId: string; id: string; expectedRevision: number; text: string; change: 'mistake' | 'changed'; since?: string | null }, options: CallOptions = {}): Promise<WriteResult> {
    const session = await this.session(scope, true)
    await this.assertNotForgotten(scope, input.commandId)
    const seen = await this.commandSeen(scope, input.commandId)
    const current = seen ? null : await this.currentRow(scope, input.id)
    if (!seen && !current) throw new MemoryError('not_found', 'There is no such memory to correct.')
    const since = input.since ?? options.now ?? new Date().toISOString()
    const result = await executeExplicitCommand(session, {
      schemaVersion: 1, commandId: input.commandId, kind: 'correct', targetAssertionId: input.id, targetRevision: input.expectedRevision,
      text: input.text, assertionKind: current?.kind ?? 'fact', conditions: [],
      ...(input.change === 'changed'
        ? { relation: 'transition', validTime: { from: new Date(since).toISOString(), until: null, precision: 'second', sourceTimeZone: null } }
        : { relation: 'correction' }),
    }, { now: options.now })
    if (!result.ok) throw failure(result.failure.code, result.failure.message)
    const item = await this.currentRow(scope, result.assertion.id)
    if (!item) throw new MemoryError('suppressed', 'The memory this command names is no longer available.')
    return { outcome: seen ? 'replayed' : 'created', item }
  }

  async forget(scope: Scope, input: { commandId: string; id: string; expectedRevision: number }, options: CallOptions = {}): Promise<{ id: string; forgotten: true }> {
    const session = await this.session(scope, true)
    const status = await this.store.pool.query<{ current_status: string; current_revision: string }>(`SELECT current_status, current_revision FROM ${S}.assertions WHERE scope_id = $1 AND assertion_id = $2`, [scope.scopeId, input.id])
    const row = status.rows[0]
    if (!row) throw new MemoryError('not_found', 'There is no such memory to forget.')
    if (row.current_status === 'deleted') return { id: input.id, forgotten: true }
    if (Number(row.current_revision) !== input.expectedRevision) throw new MemoryError('conflict', 'The memory changed since it was read; read it again before forgetting.')
    const result = await executeForgetCommand(session, { schemaVersion: 1, commandId: input.commandId, kind: 'forget', targetAssertionId: input.id, targetRevision: input.expectedRevision, query: null }, { now: options.now })
    if (!result.ok) throw failure(result.failure.code, result.failure.message)
    return { id: input.id, forgotten: true }
  }

  async get(scope: Scope, id: string): Promise<MemoryItem | null> {
    await this.session(scope, false)
    return this.currentRow(scope, id)
  }

  async getAt(scope: Scope, id: string, validAt: string): Promise<MemoryItem | null> {
    const session = await this.session(scope, false)
    if (!(await this.currentRow(scope, id))) return null
    const read = await readAssertionAsOf(session, { assertionId: id as AssertionVersion['id'], mode: 'valid_at', asOf: validAt })
    const version = (read as { version?: AssertionVersion | null }).version
    if (!version) return null
    const created = await this.store.pool.query<{ created_at: Date }>(`SELECT created_at FROM ${S}.assertions WHERE scope_id = $1 AND assertion_id = $2`, [scope.scopeId, id])
    return this.item({ assertion_id: id, version, created_at: created.rows[0]!.created_at })
  }

  async history(scope: Scope, id: string): Promise<MemoryRevision[]> {
    await this.session(scope, false)
    const result = await this.store.pool.query<{ version: AssertionVersion; current_status: string; suppressed: boolean; created_at: Date }>(
      `SELECT v.version, a.current_status, v.created_at,
              EXISTS (SELECT 1 FROM ${S}.deletion_suppressions s WHERE s.scope_id = a.scope_id AND s.assertion_id = a.assertion_id) AS suppressed
       FROM ${S}.assertion_versions v JOIN ${S}.assertions a ON a.scope_id = v.scope_id AND a.assertion_id = v.assertion_id
       WHERE v.scope_id = $1 AND v.assertion_id = $2 ORDER BY v.revision`,
      [scope.scopeId, id],
    )
    return result.rows.map((row, index, rows) => {
      const forgotten = row.current_status === 'deleted' || row.suppressed
      const next = rows[index + 1]?.version
      return {
        revision: row.version.revision,
        basis: BASIS[row.version.attribution.basis] ?? 'explicit',
        text: forgotten ? null : assertionText(row.version),
        validFrom: row.version.time.validTime.from,
        validUntil: row.version.time.validTime.until,
        supersededAsMistake: next?.time.relation === 'correction',
        createdAt: new Date(row.created_at).toISOString(),
      }
    })
  }

  async list(scope: Scope, page: { limit: number; cursor: string | null }): Promise<Page<MemoryItem>> {
    await this.session(scope, false)
    const limit = Math.max(1, Math.min(page.limit, LIMITS.pageSize))
    const after = page.cursor ? decodeCursor(scope, page.cursor) : null
    // The cursor keeps PostgreSQL's own microsecond timestamp text: a JavaScript
    // date would round to milliseconds and repeat rows written in the same one.
    const result = await this.store.pool.query<{ assertion_id: string; version: AssertionVersion; created_at: Date; created_exact: string }>(
      `SELECT a.assertion_id, v.version, a.created_at, a.created_at::text AS created_exact FROM ${S}.assertions a
       JOIN ${S}.assertion_versions v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
       WHERE a.scope_id = $1 AND a.current_status = 'accepted'
         AND NOT EXISTS (SELECT 1 FROM ${S}.deletion_suppressions s WHERE s.scope_id = a.scope_id AND s.assertion_id = a.assertion_id)
         AND ($2::timestamptz IS NULL OR (a.created_at, a.assertion_id) > ($2::timestamptz, $3::text))
       ORDER BY a.created_at, a.assertion_id LIMIT $4`,
      [scope.scopeId, after?.createdAt ?? null, after?.id ?? '', limit + 1],
    )
    const items = result.rows.slice(0, limit).map((row) => this.item(row))
    const last = result.rows[Math.min(limit, result.rows.length) - 1]
    return { items, nextCursor: result.rows.length > limit && last ? encodeCursor(scope, last.created_exact, last.assertion_id) : null }
  }

  async search(scope: Scope, query: string, limit: number): Promise<MemoryItem[]> {
    await this.session(scope, false)
    const wanted = terms(query)
    if (!wanted.length) return []
    const tsquery = wanted.map((term) => `'${term.replace(/'/gu, "''")}':*`).join(' | ')
    const result = await this.store.pool.query<{ assertion_id: string; version: AssertionVersion; created_at: Date }>(
      `SELECT a.assertion_id, v.version, a.created_at FROM ${S}.assertions a
       JOIN ${S}.assertion_versions v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
       WHERE a.scope_id = $1 AND a.current_status = 'accepted'
         AND to_tsvector('simple', COALESCE(v.version->'payload', '{}'::jsonb)::text) @@ to_tsquery('simple', $2)
         AND NOT EXISTS (SELECT 1 FROM ${S}.deletion_suppressions s WHERE s.scope_id = a.scope_id AND s.assertion_id = a.assertion_id)
       ORDER BY ts_rank_cd(to_tsvector('simple', COALESCE(v.version->'payload', '{}'::jsonb)::text), to_tsquery('simple', $2)) DESC, a.updated_at DESC, a.assertion_id
       LIMIT $3`,
      [scope.scopeId, tsquery, Math.max(1, Math.min(limit, LIMITS.searchResults))],
    )
    return result.rows.map((row) => this.item(row))
  }

  async capture(scope: Scope, input: { idempotencyKey: string; text: string }, options: CallOptions = {}) {
    const session = await this.session(scope, true)
    const key = sha256(`${scope.scopeId}\0${input.idempotencyKey}`)
    const idempotencyKey = `portable/${key.slice(0, 64)}`
    const prior = await this.store.pool.query(`SELECT 1 FROM ${S}.events WHERE scope_id = $1 AND idempotency_key = $2`, [scope.scopeId, idempotencyKey])
    const event: EventEnvelope = {
      schemaVersion: MEMORY_CONTRACT_VERSION,
      id: `event/portable/${key.slice(0, 48)}` as EventEnvelope['id'],
      idempotencyKey,
      conversationId: `conversation/portable/${sha256(scope.scopeId).slice(0, 32)}` as EventEnvelope['conversationId'],
      turnId: `turn/portable/${key.slice(0, 48)}` as EventEnvelope['turnId'],
      actor: { kind: 'principal', principalId: session.principal.id },
      subject: session.subject,
      sourceKind: 'user_statement',
      sourceAuthority: { kind: 'authenticated_user', revision: `revision/source/${sha256(input.text).slice(0, 40)}` as RevisionId },
      committedPhase: 'committed',
      sequence: 1,
      sourceTime: null,
      sourceTimePrecision: 'unknown',
      receivedAt: options.now ?? new Date().toISOString(),
      consent: { id: `consent/portable/${key.slice(0, 48)}` as ConsentId, policyVersion: `revision/policy/${session.policyEpoch}` as RevisionId, purpose: 'memory_capture' },
      sourceSpans: [],
      payload: { text: input.text },
    }
    const receipt = await captureCommittedEvent(this.store, session, event, { now: options.now, assignSequence: true })
    if (!receipt.ok) throw failure(receipt.failure.code, receipt.failure.message)
    return { eventId: event.id, outcome: prior.rows.length ? 'replayed' as const : 'captured' as const }
  }

  async claimJobs(scope: Scope, input: { workerId: string; limit: number; leaseMs: number }, options: CallOptions = {}): Promise<ClaimedJob[]> {
    await this.session(scope, true)
    const jobs = await claimJobs(this.store, { workerId: input.workerId, scopeId: scope.scopeId as never, kinds: ['interpret_event'], limit: input.limit, leaseMs: input.leaseMs, now: options.now })
    return jobs.map((job) => ({ jobId: job.jobId, eventId: job.inputEventId, fence: job.fence, attempt: job.attempt, leaseUntil: job.leasedUntil }))
  }

  async completeJob(scope: Scope, input: { jobId: string; fence: number }, options: CallOptions = {}): Promise<'completed' | 'lease_lost'> {
    await this.session(scope, false)
    const now = options.now ?? new Date().toISOString()
    const row = await this.store.pool.query<{ principal_id: string; input_event_id: string; attempts: number; lease_until: Date | null; policy_epoch: string; deletion_epoch: string }>(
      `SELECT principal_id, input_event_id, attempts, lease_until, policy_epoch, deletion_epoch FROM ${S}.jobs WHERE job_id = $1 AND scope_id = $2`,
      [input.jobId, scope.scopeId],
    )
    const job = row.rows[0]
    if (!job) return 'lease_lost'
    const claimed = {
      jobId: input.jobId, kind: 'interpret_event' as const, scopeId: scope.scopeId, principalId: job.principal_id, inputEventId: job.input_event_id,
      event: null as never, attempt: job.attempts, fence: input.fence, leasedUntil: job.lease_until ? new Date(job.lease_until).toISOString() : now,
      policyEpoch: Number(job.policy_epoch), deletionEpoch: Number(job.deletion_epoch),
    }
    return this.store.forContext({ principalId: job.principal_id as never, scopeId: scope.scopeId as never, policyEpoch: Number(job.policy_epoch) }).runTransaction(async (tx) => {
      const check = await checkRunningJob(tx, claimed as never, now)
      if (check.status !== 'ok') return 'lease_lost' as const
      await finishCheckedJob(tx, claimed as never, now)
      return 'completed' as const
    })
  }

  async close(): Promise<void> {
    await this.store.close()
  }
}

function encodeCursor(scope: Scope, createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: sha256(scope.scopeId).slice(0, 16), c: createdAt, i: id })).toString('base64url')
}

function decodeCursor(scope: Scope, cursor: string): { createdAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: string; c?: string; i?: string }
    if (value.s !== sha256(scope.scopeId).slice(0, 16) || typeof value.c !== 'string' || typeof value.i !== 'string') throw new Error('mismatch')
    return { createdAt: value.c, id: value.i }
  } catch {
    throw new MemoryError('validation', 'This cursor does not belong to this memory.')
  }
}
