import {
  bindMemoryCommand,
  parseAssertionVersion,
  parsePublicMemoryCommand,
  parseReceipt,
  type AssertionCommit,
  type AssertionKind,
  type AssertionVersion,
  type BoundedJson,
  type CanonicalSlot,
  type Condition,
  type ExactVersionRef,
  type MemoryFailure,
  type MemoryReceipt,
  type MemorySession,
  type SourceSpan,
  type PublicMemoryCommand,
  type PublicRememberCommand,
  type PublicCorrectCommand,
  type TemporalRelation,
  type ValidTime,
  type RevisionId,
} from '../../../src/lib/memory/contracts.ts'
import { DEFAULT_MEMORY_ACCEPTED_ASSERTION_QUOTA, MEMORY_SCHEMA } from './config.ts'
import { PostgresMemoryOperationError, PostgresMemoryStore, type PostgresMemoryTransaction } from './postgres.ts'
import { assertionVersionHash, canonicalJson, isoNow, revisionId, sha256 } from './serialization.ts'

const SQL = {
  assertions: `${MEMORY_SCHEMA}.assertions`,
  commands: `${MEMORY_SCHEMA}.command_receipts`,
  counters: `${MEMORY_SCHEMA}.change_counters`,
  changes: `${MEMORY_SCHEMA}.change_feed`,
  events: `${MEMORY_SCHEMA}.events`,
  quotas: `${MEMORY_SCHEMA}.quota_limits`,
} as const

type PostgresSession = MemorySession<unknown> & { readonly store: PostgresMemoryStore }

export interface ExplicitCommandOptions {
  now?: string
  interpretedAt?: string
  slot?: CanonicalSlot | null
  /** Server-built evidence for the committed user turn; never a model argument. */
  sourceSpan?: SourceSpan | null
  /** Test-only failure injection before the transaction commits. */
  injectFailureAfterAssertion?: boolean
  /** Test-only simulation of a lost response after the transaction commits. */
  injectResponseFailureAfterCommit?: boolean
}

export interface AcceptedChangeOverlay {
  scopeId: string
  changeWatermark: string
  operation: 'remember' | 'correct'
  assertion: ExactVersionRef
  version: AssertionVersion
}

export interface ExplicitCommandSuccess {
  ok: true
  commandId: string
  operation: 'remember' | 'correct'
  outcome: 'accepted' | 'duplicate'
  receipt: MemoryReceipt
  canonicalRevision: RevisionId
  changeWatermark: string | null
  overlay: AcceptedChangeOverlay | null
  assertion: AssertionVersion
}

export interface ExplicitCommandFailure {
  ok: false
  commandId: string | null
  receipt: MemoryReceipt
  failure: MemoryFailure
}

export type ExplicitCommandResult = ExplicitCommandSuccess | ExplicitCommandFailure

export interface CurrentAssertionRead {
  mode: 'current'
  asOf: null
  version: AssertionVersion | null
}

export interface HistoricalAssertionRead {
  mode: 'known_at' | 'valid_at'
  asOf: string
  version: AssertionVersion | null
}

export interface ResolveTargetCandidate {
  assertionId: string
  revision: number
  kind: AssertionKind
}

export type ResolveTargetResult =
  | { ok: true; target: ExactVersionRef }
  | { ok: false; failure: MemoryFailure; candidates?: readonly ResolveTargetCandidate[] }

interface CommandRecord {
  command_hash: string
  result: unknown
}

function failure(code: MemoryFailure['code'], message: string, retryable = false, details?: MemoryFailure['details']): PostgresMemoryOperationError {
  return new PostgresMemoryOperationError({ code, message, retryable, ...(details ? { details } : {}) })
}

function storeFor(session: MemorySession): PostgresMemoryStore {
  const store = session.store
  if (!(store instanceof PostgresMemoryStore)) {
    throw failure('unavailable', 'Explicit durable commands require the PostgreSQL memory authority.', false)
  }
  return store
}

function ensureIso(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) throw failure('validation', `${label} must be an ISO instant.`, false)
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function normalizedConditions(conditions: readonly Condition[]): readonly Condition[] {
  return [...conditions]
    .map((condition) => ({ ...condition }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
}

function emptyValidTime(): ValidTime {
  return { from: null, until: null, precision: 'unknown', sourceTimeZone: null }
}

function commandRelation(command: PublicRememberCommand | PublicCorrectCommand): TemporalRelation {
  if (command.kind === 'remember') return command.relation ?? 'ordinary'
  return command.relation ?? 'correction'
}

function commandValidTime(command: PublicRememberCommand | PublicCorrectCommand): ValidTime {
  return command.validTime ?? emptyValidTime()
}

function assertCommandTime(command: PublicRememberCommand | PublicCorrectCommand, now: string, interpretedAt: string): void {
  ensureIso(now, 'now')
  ensureIso(interpretedAt, 'interpretedAt')
  const relation = commandRelation(command)
  const validTime = commandValidTime(command)
  if (relation === 'temporary_exception' && !validTime.until) {
    throw failure('validation', 'A temporary exception requires an expiry time.', false)
  }
  if (relation === 'transition' && !validTime.from) {
    throw failure('validation', 'A real-world transition requires an effective start time.', false)
  }
}

function slotFromVersion(version: AssertionVersion): CanonicalSlot | null {
  return version.payload.kind === 'fact' && version.payload.proposition.type === 'slot'
    ? version.payload.proposition.slot
    : null
}

function normalizedCommand(command: PublicMemoryCommand): Record<string, unknown> {
  if (command.kind === 'remember') {
    return {
      kind: command.kind,
      text: normalizeText(command.text),
      assertionKind: command.assertionKind,
      conditions: normalizedConditions(command.conditions),
      validTime: command.validTime ?? emptyValidTime(),
      relation: command.relation ?? 'ordinary',
      polarity: command.polarity ?? 'positive',
    }
  }
  if (command.kind === 'correct') {
    return {
      kind: command.kind,
      targetAssertionId: command.targetAssertionId,
      targetRevision: command.targetRevision,
      sourceRevision: command.sourceRevision ?? null,
      text: normalizeText(command.text),
      assertionKind: command.assertionKind,
      conditions: normalizedConditions(command.conditions),
      validTime: command.validTime ?? emptyValidTime(),
      relation: command.relation ?? 'correction',
      polarity: command.polarity ?? 'positive',
    }
  }
  return { ...command }
}

function commandHash(session: PostgresSession, command: PublicMemoryCommand, slot: CanonicalSlot | null, sourceSpan: SourceSpan | null): string {
  return sha256({ scopeId: session.scope.id, subject: session.subject, command: normalizedCommand(command), slot, sourceSpan })
}

function canonicalKey(session: PostgresSession, command: PublicRememberCommand | PublicCorrectCommand, slot: CanonicalSlot | null): string {
  return sha256({
    scopeId: session.scope.id,
    subject: session.subject,
    kind: command.assertionKind,
    text: normalizeText(command.text),
    conditions: normalizedConditions(command.conditions),
    relation: command.relation ?? 'ordinary',
    validTime: command.validTime ?? emptyValidTime(),
    polarity: command.polarity ?? 'positive',
    slot,
  })
}

function eventIdFor(scopeId: string, commandId: string): string {
  return `event/command/${sha256({ scopeId, commandId }).slice(0, 40)}`
}

function assertionIdFor(scopeId: string, commandId: string): string {
  return `assertion/command/${sha256({ scopeId, commandId }).slice(0, 40)}`
}

function consentIdFor(scopeId: string, commandId: string): string {
  return `consent/command/${sha256({ scopeId, commandId }).slice(0, 40)}`
}

function commandReceiptId(eventId: string): string {
  return `receipt/${eventId}`
}

function acceptedReceipt(eventId: string, receivedAt: string, assertion: AssertionVersion): MemoryReceipt {
  return {
    schemaVersion: 1,
    receiptId: commandReceiptId(eventId),
    eventId: eventId as MemoryReceipt['eventId'],
    receivedAt,
    ok: true,
    state: 'accepted',
    canonicalRevision: revisionId(assertion.id, assertion.revision),
    indexWatermark: null,
  }
}

function failedReceipt(eventId: string | null, receivedAt: string, operationFailure: MemoryFailure): MemoryReceipt {
  return {
    schemaVersion: 1,
    receiptId: `receipt/failure/${crypto.randomUUID()}`,
    eventId: eventId as MemoryReceipt['eventId'],
    receivedAt,
    ok: false,
    state: 'failed',
    canonicalRevision: null,
    indexWatermark: null,
    failure: operationFailure,
  }
}

function parsedStoredSuccess(value: unknown): ExplicitCommandSuccess | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.ok !== true || (candidate.operation !== 'remember' && candidate.operation !== 'correct')) return null
  if (candidate.outcome !== 'accepted' && candidate.outcome !== 'duplicate') return null
  const parsedReceipt = parseReceipt(candidate.receipt)
  const parsedAssertion = parseAssertionVersion(candidate.assertion)
  if (!parsedReceipt.ok || !parsedAssertion.ok || typeof candidate.commandId !== 'string' || typeof candidate.canonicalRevision !== 'string') return null
  if (candidate.changeWatermark !== null && typeof candidate.changeWatermark !== 'string') return null
  let overlay: AcceptedChangeOverlay | null = null
  if (candidate.overlay !== null) {
    if (!candidate.overlay || typeof candidate.overlay !== 'object') return null
    const overlayValue = candidate.overlay as Record<string, unknown>
    const overlayVersion = parseAssertionVersion(overlayValue.version)
    const reference = overlayValue.assertion
    if (!overlayVersion.ok || !reference || typeof reference !== 'object') return null
    const ref = reference as Record<string, unknown>
    if (typeof overlayValue.scopeId !== 'string' || typeof overlayValue.changeWatermark !== 'string' || (overlayValue.operation !== 'remember' && overlayValue.operation !== 'correct') || typeof ref.assertionId !== 'string' || typeof ref.revision !== 'number') return null
    overlay = {
      scopeId: overlayValue.scopeId,
      changeWatermark: overlayValue.changeWatermark,
      operation: overlayValue.operation,
      assertion: { assertionId: ref.assertionId as ExactVersionRef['assertionId'], revision: ref.revision },
      version: overlayVersion.value,
    }
  }
  return {
    ok: true,
    commandId: candidate.commandId,
    operation: candidate.operation,
    outcome: candidate.outcome,
    receipt: parsedReceipt.value,
    canonicalRevision: candidate.canonicalRevision as RevisionId,
    changeWatermark: candidate.changeWatermark as string | null,
    overlay,
    assertion: parsedAssertion.value,
  }
}

async function existingCommand(transaction: PostgresMemoryTransaction, scopeId: string, commandId: string): Promise<CommandRecord | null> {
  const result = await transaction.query<CommandRecord>(
    `SELECT command_hash, result FROM ${SQL.commands} WHERE scope_id = $1 AND command_id = $2 FOR UPDATE`,
    [scopeId, commandId],
  )
  return result.rows[0] ?? null
}

export async function acceptedAssertionCount(transaction: PostgresMemoryTransaction, scopeId: string): Promise<{ count: number; limit: number }> {
  const [countResult, limitResult] = await Promise.all([
    transaction.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${SQL.assertions} WHERE scope_id = $1 AND current_status IN ('candidate', 'accepted', 'disputed')`,
      [scopeId],
    ),
    transaction.query<{ max_accepted_assertions: number }>(
      `SELECT max_accepted_assertions FROM ${SQL.quotas} WHERE scope_id = $1`,
      [scopeId],
    ),
  ])
  return {
    count: Number(countResult.rows[0]?.count ?? 0),
    limit: Number(limitResult.rows[0]?.max_accepted_assertions ?? DEFAULT_MEMORY_ACCEPTED_ASSERTION_QUOTA),
  }
}

export async function allocateWatermark(transaction: PostgresMemoryTransaction, scopeId: string): Promise<number> {
  const result = await transaction.query<{ next_watermark: string }>(
    `
      UPDATE ${SQL.counters}
      SET next_watermark = next_watermark + 1, updated_at = now()
      WHERE scope_id = $1
      RETURNING next_watermark
    `,
    [scopeId],
  )
  if (!result.rows[0]) throw failure('unavailable', 'The change-feed watermark is unavailable.', true)
  return Number(result.rows[0].next_watermark)
}

export function watermarkId(scopeId: string, watermark: number): string {
  return `watermark/${scopeId}/${watermark}`
}

function assertionPayload(command: PublicRememberCommand | PublicCorrectCommand, subject: PostgresSession['subject'], slot: CanonicalSlot | null) {
  if (command.assertionKind === 'fact') {
    return slot
      ? { kind: 'fact' as const, proposition: { type: 'slot' as const, slot, value: command.text.trim() as BoundedJson } }
      : {
          kind: 'fact' as const,
          proposition: {
            type: 'free_form' as const,
            text: command.text,
            subject,
            conditions: normalizedConditions(command.conditions),
          },
        }
  }
  if (command.assertionKind === 'preference' || command.assertionKind === 'constraint') {
    return {
      kind: command.assertionKind,
      text: command.text,
      conditions: normalizedConditions(command.conditions),
      exceptions: [],
    }
  }
  return {
    kind: 'decision' as const,
    topic: command.text,
    decision: command.text,
    alternatives: [],
    reasons: [],
  }
}

function buildEvent(
  session: PostgresSession,
  command: PublicRememberCommand | PublicCorrectCommand,
  eventId: string,
  sequence: number,
  now: string,
  validTime: ValidTime,
  relation: TemporalRelation,
  sourceSpan: SourceSpan | null,
): import('../../../src/lib/memory/contracts.ts').EventEnvelope {
  const isCorrection = command.kind === 'correct'
  return {
    schemaVersion: 1,
    id: eventId as import('../../../src/lib/memory/contracts.ts').EventId,
    idempotencyKey: `command/${command.commandId}`,
    conversationId: `conversation/memory-command/${sha256(session.scope.id).slice(0, 24)}` as import('../../../src/lib/memory/contracts.ts').ConversationId,
    turnId: `turn/memory-command/${sha256({ scopeId: session.scope.id, commandId: command.commandId }).slice(0, 24)}` as import('../../../src/lib/memory/contracts.ts').TurnId,
    actor: { kind: 'principal', principalId: session.principal.id },
    subject: session.subject,
    sourceKind: isCorrection ? 'user_correction' : 'user_statement',
    sourceAuthority: { kind: 'authenticated_user', revision: `policy/${session.policyEpoch}` as RevisionId },
    committedPhase: 'committed',
    sequence,
    sourceTime: validTime.from,
    sourceTimePrecision: validTime.precision,
    receivedAt: now,
    consent: {
      id: consentIdFor(session.scope.id, command.commandId) as import('../../../src/lib/memory/contracts.ts').ConsentId,
      policyVersion: `policy/${session.policyEpoch}` as RevisionId,
      purpose: 'memory_capture',
    },
    sourceSpans: sourceSpan ? [sourceSpan] : [],
    payload: {
      commandId: command.commandId,
      ...(sourceSpan ? { sourceRevision: sourceSpan.document.revision } : {}),
      text: command.text,
      assertionKind: command.assertionKind,
      conditions: normalizedConditions(command.conditions).map((condition) => ({
        key: condition.key,
        operator: condition.operator,
        value: condition.value,
      })) as unknown as BoundedJson,
      relation,
      ...(isCorrection ? { targetAssertionId: command.targetAssertionId, targetRevision: command.targetRevision } : {}),
    },
  }
}

function buildAssertion(
  session: PostgresSession,
  command: PublicRememberCommand | PublicCorrectCommand,
  eventId: string,
  now: string,
  interpretedAt: string,
  validTime: ValidTime,
  relation: TemporalRelation,
  assertionId: string,
  revision: number,
  prior: AssertionVersion | null,
  slot: CanonicalSlot | null,
  sourceSpan: SourceSpan | null,
): AssertionVersion {
  return {
    schemaVersion: 1,
    id: assertionId as AssertionVersion['id'],
    revision,
    scopeId: session.scope.id,
    subject: session.subject,
    kind: command.assertionKind,
    payload: assertionPayload(command, session.subject, slot),
    attribution: {
      actor: { kind: 'principal', principalId: session.principal.id },
      basis: command.kind === 'correct' ? 'user_correction' : 'explicit_user_statement',
    },
    polarity: command.polarity ?? 'positive',
    status: 'accepted',
    time: { validTime, receivedAt: now, interpretedAt, relation },
    evidence: [{ eventId: eventId as import('../../../src/lib/memory/contracts.ts').EventId, span: sourceSpan, relation: 'supports' }],
    dependencies: prior
      ? [{ type: 'assertion', id: prior.id, revision: revisionId(prior.id, prior.revision) }]
      : [],
    producer: { name: 'explicit-command', version: 'stage-04.1', model: null },
    ...(prior ? { supersedes: { assertionId: prior.id, revision: prior.revision } } : {}),
  }
}

async function persistCommand(
  session: PostgresSession,
  command: PublicRememberCommand | PublicCorrectCommand,
  options: ExplicitCommandOptions,
): Promise<ExplicitCommandResult> {
  const now = options.now ?? isoNow()
  const interpretedAt = options.interpretedAt ?? now
  const slot = options.slot ?? null
  assertCommandTime(command, now, interpretedAt)
  const validTime = commandValidTime(command)
  const relation = commandRelation(command)
  const sourceSpan = options.sourceSpan ?? null
  if (sourceSpan) {
    const quote = sourceSpan.quote
    const validSource = quote !== null
      && sourceSpan.start === 0
      && sourceSpan.end === quote.length
      && sourceSpan.textHash === sha256(quote)
      && sourceSpan.document.contentHash === sha256(quote)
    if (!validSource) {
      const operationFailure: MemoryFailure = { code: 'validation', message: 'The committed source revision failed validation.', retryable: false }
      return { ok: false, commandId: command.commandId, receipt: failedReceipt(eventIdFor(session.scope.id, command.commandId) as import('../../../src/lib/memory/contracts.ts').EventId, now, operationFailure), failure: operationFailure }
    }
  }
  const eventId = eventIdFor(session.scope.id, command.commandId)
  const hash = commandHash(session, command, slot, sourceSpan)
  const canonical = canonicalKey(session, command, slot)

  let result: ExplicitCommandResult
  try {
    const store = storeFor(session)
    result = await store.forSession(session).runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(session, command.kind)
      await transaction.query(`SELECT scope_id FROM ${MEMORY_SCHEMA}.policy_epochs WHERE scope_id = $1 FOR UPDATE`, [session.scope.id])

      const priorCommand = await existingCommand(transaction, session.scope.id, command.commandId)
      if (priorCommand) {
        if (priorCommand.command_hash !== hash) {
          throw failure('conflict', 'This command ID is already bound to different content.', false, { reason: 'command_id_content_conflict' })
        }
        const stored = parsedStoredSuccess(priorCommand.result)
        if (!stored) throw failure('unavailable', 'The stored command receipt failed validation.', false)
        if (await transaction.isVersionSuppressed({ assertionId: stored.assertion.id, revision: stored.assertion.revision }, stored.assertion.evidence.map((edge) => edge.eventId))) {
          throw failure('suppressed', 'The command result was privacy-deleted and cannot be reused.', false)
        }
        return stored
      }

      let prior: AssertionVersion | null = null
      let assertionId = assertionIdFor(session.scope.id, command.commandId)
      let revision = 1
      let targetSlot = slot

      if (command.kind === 'correct') {
        prior = await transaction.exactVersion({ assertionId: command.targetAssertionId, revision: command.targetRevision })
        if (!prior) throw failure('not_found', 'The exact correction target is not available in this scope.', false)
        const current = await transaction.currentVersion(command.targetAssertionId)
        if (!current) throw failure('suppressed', 'The correction target is suppressed or unavailable.', false)
        if (current.revision !== command.targetRevision) {
          throw failure('conflict', 'The correction target changed; refresh before editing it.', true, { currentRevision: current.revision })
        }
        if (current.kind !== command.assertionKind) {
          throw failure('conflict', 'A correction must retain the target assertion kind.', false)
        }
        if (command.sourceRevision !== undefined && command.sourceRevision !== null) {
          const sourceRevisions = await transaction.sourceRevisionsFor({ assertionId: current.id, revision: current.revision })
          if (!sourceRevisions.includes(command.sourceRevision)) {
            throw failure('conflict', 'The correction source changed; refresh the source before editing it.', true, { reason: 'source_revision_changed' })
          }
        }
        assertionId = current.id
        revision = current.revision + 1
        targetSlot = slotFromVersion(current)
        if (slot && (!targetSlot || slot.slotId !== targetSlot.slotId || slot.cardinality !== targetSlot.cardinality)) {
          throw failure('conflict', 'A correction cannot change the target slot cardinality.', false)
        }
        if (relation === 'temporary_exception') throw failure('validation', 'Use remember for a new scoped exception; do not rewrite the global assertion.', false)
        const conflictingCanonical = await transaction.findCanonicalAssertion(canonical)
        if (conflictingCanonical && conflictingCanonical.id !== current.id) {
          throw failure('conflict', 'The corrected value already has a distinct canonical assertion.', false)
        }
      } else if (slot && command.assertionKind !== 'fact') {
        throw failure('validation', 'Canonical slots can only be used with fact assertions.', false)
      }

      if (command.kind === 'remember' && canonical) {
        const duplicate = await transaction.findCanonicalAssertion(canonical)
        if (duplicate) {
          const duplicateReceipt = acceptedReceipt(eventId, now, duplicate)
          const duplicateResult: ExplicitCommandSuccess = {
            ok: true,
            commandId: command.commandId,
            operation: 'remember',
            outcome: 'duplicate',
            receipt: duplicateReceipt,
            canonicalRevision: revisionId(duplicate.id, duplicate.revision),
            changeWatermark: null,
            overlay: null,
            assertion: duplicate,
          }
          const sequence = await transaction.nextEventSequence()
          const event = buildEvent(session, command, eventId, sequence, now, validTime, relation, sourceSpan)
          if (await transaction.insertEvent(event) !== 'inserted') throw failure('conflict', 'The command event was concurrently claimed; retry the same command.', true)
          await transaction.query(
            `INSERT INTO ${SQL.commands} (scope_id, command_id, command_hash, operation, event_id, assertion_id, assertion_revision, outcome, change_watermark, receipt, result)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'duplicate', NULL, $8::jsonb, $9::jsonb)`,
            [session.scope.id, command.commandId, hash, command.kind, event.id, duplicate.id, duplicate.revision, canonicalJson(duplicateReceipt), canonicalJson(duplicateResult)],
          )
          return duplicateResult
        }
      }

      if (command.kind === 'remember') {
        const quota = await acceptedAssertionCount(transaction, session.scope.id)
        if (quota.count >= quota.limit) {
          throw failure('budget_exhausted', 'The durable assertion quota is full; no acknowledged memory was written.', false, { limit: quota.limit, current: quota.count })
        }
      }

      const sequence = await transaction.nextEventSequence()
      const event = buildEvent(session, command, eventId, sequence, now, validTime, relation, sourceSpan)
      if (await transaction.insertEvent(event) !== 'inserted') throw failure('conflict', 'The command event was concurrently claimed; retry the same command.', true)
      const assertion = buildAssertion(session, command, event.id, now, interpretedAt, validTime, relation, assertionId, revision, prior, targetSlot, sourceSpan)
      const commit: AssertionCommit = {
        assertion,
        expectedRevision: prior ? prior.revision : null,
        slot: targetSlot,
        canonicalKey: canonical,
      }
      const committed = targetSlot
        ? await transaction.withSlotLock(session.scope.id, targetSlot, () => transaction.commitAssertion(commit))
        : await transaction.commitAssertion(commit)
      if (!committed.ok) throw new PostgresMemoryOperationError(committed.failure)
      if (options.injectFailureAfterAssertion) throw new Error('injected command crash after assertion commit')

      const watermark = await allocateWatermark(transaction, session.scope.id)
      const change = {
        scopeId: session.scope.id,
        changeWatermark: watermarkId(session.scope.id, watermark),
        operation: command.kind,
        assertion: { assertionId: assertion.id, revision: assertion.revision },
        version: assertion,
      } satisfies AcceptedChangeOverlay
      await transaction.query(
        `INSERT INTO ${SQL.changes} (scope_id, watermark, command_id, event_id, assertion_id, assertion_revision, change_kind, change)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [session.scope.id, watermark, command.commandId, event.id, assertion.id, assertion.revision, relation === 'temporary_exception' ? 'temporary_exception' : command.kind === 'correct' ? 'corrected' : 'remembered', canonicalJson(change)],
      )
      await transaction.insertProjectionJob(event)
      const receipt = acceptedReceipt(event.id, now, assertion)
      const accepted: ExplicitCommandSuccess = {
        ok: true,
        commandId: command.commandId,
        operation: command.kind,
        outcome: 'accepted',
        receipt,
        canonicalRevision: revisionId(assertion.id, assertion.revision),
        changeWatermark: change.changeWatermark,
        overlay: change,
        assertion,
      }
      await transaction.query(
        `INSERT INTO ${SQL.commands} (scope_id, command_id, command_hash, operation, event_id, assertion_id, assertion_revision, outcome, change_watermark, receipt, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'accepted', $8, $9::jsonb, $10::jsonb)`,
        [session.scope.id, command.commandId, hash, command.kind, event.id, assertion.id, assertion.revision, watermark, canonicalJson(receipt), canonicalJson(accepted)],
      )
      return accepted
    })
  } catch (error) {
    if (options.injectFailureAfterAssertion) throw error
    const operationFailure = error instanceof PostgresMemoryOperationError
      ? error.failure
      : { code: 'unavailable' as const, message: 'Memory authority is unavailable; no durable command receipt was committed.', retryable: true }
    return { ok: false, commandId: command.commandId, receipt: failedReceipt(eventId, now, operationFailure), failure: operationFailure }
  }

  if (options.injectResponseFailureAfterCommit) throw new Error('injected ambiguous command response')
  return result
}

/** Execute a parsed or JSON-shaped explicit remember/correct command. */
export async function executeExplicitCommand(
  session: MemorySession,
  input: PublicMemoryCommand | unknown,
  options: ExplicitCommandOptions = {},
): Promise<ExplicitCommandResult> {
  const parsed = parsePublicMemoryCommand(input)
  if (!parsed.ok) {
    const now = options.now ?? isoNow()
    const operationFailure: MemoryFailure = { code: 'validation', message: parsed.error.message, retryable: false }
    return { ok: false, commandId: null, receipt: failedReceipt(null, now, operationFailure), failure: operationFailure }
  }
  if (parsed.value.kind !== 'remember' && parsed.value.kind !== 'correct') {
    const now = options.now ?? isoNow()
    const operationFailure: MemoryFailure = { code: 'validation', message: 'Stage 04 writes accept remember or correct commands only.', retryable: false }
    return { ok: false, commandId: parsed.value.commandId, receipt: failedReceipt(null, now, operationFailure), failure: operationFailure }
  }
  const bound = bindMemoryCommand(session, parsed.value)
  if (!bound.ok) {
    const now = options.now ?? isoNow()
    const operationFailure: MemoryFailure = { code: 'unauthorized', message: bound.error.message, retryable: false }
    return { ok: false, commandId: parsed.value.commandId, receipt: failedReceipt(null, now, operationFailure), failure: operationFailure }
  }
  return persistCommand(session as PostgresSession, parsed.value, options)
}

export async function executeScopedException(
  session: MemorySession,
  input: Omit<PublicRememberCommand, 'kind' | 'relation'>,
  options: ExplicitCommandOptions = {},
): Promise<ExplicitCommandResult> {
  return executeExplicitCommand(session, { ...input, kind: 'remember', relation: 'temporary_exception' }, options)
}

export async function readCurrentAssertion(
  session: MemorySession,
  assertionId: AssertionVersion['id'],
  options: { now?: string } = {},
): Promise<CurrentAssertionRead> {
  const store = storeFor(session)
  const now = options.now ?? isoNow()
  ensureIso(now, 'now')
  const version = await store.forSession(session).runTransaction(async (transaction) => {
    await transaction.assertAuthorizedContext(session, 'recall')
    const versions = await transaction.allVersions(assertionId)
    return versions.filter((item) => validAt(item, now)).sort((left, right) => right.revision - left.revision)[0] ?? null
  })
  return { mode: 'current', asOf: null, version }
}

function validAt(version: AssertionVersion, asOf: string): boolean {
  const from = version.time.validTime.from
  const until = version.time.validTime.until
  return (!from || Date.parse(from) <= Date.parse(asOf)) && (!until || Date.parse(asOf) < Date.parse(until))
}

export async function readAssertionAsOf(
  session: MemorySession,
  request: { assertionId: AssertionVersion['id']; mode: 'known_at' | 'valid_at'; asOf: string },
): Promise<HistoricalAssertionRead> {
  ensureIso(request.asOf, 'asOf')
  const store = storeFor(session)
  const version = await store.forSession(session).runTransaction(async (transaction) => {
    await transaction.assertAuthorizedContext(session, 'recall')
    const versions = await transaction.allVersions(request.assertionId)
    const candidates = request.mode === 'known_at'
      ? versions.filter((item) => Date.parse(item.time.interpretedAt) <= Date.parse(request.asOf))
      : versions.filter((item) => validAt(item, request.asOf))
    return candidates.sort((left, right) => right.revision - left.revision)[0] ?? null
  })
  return { mode: request.mode, asOf: request.asOf, version }
}

export async function readAcceptedChangeOverlay(
  session: MemorySession,
  options: { afterWatermark?: number; limit?: number } = {},
): Promise<readonly AcceptedChangeOverlay[]> {
  const store = storeFor(session)
  const after = Number.isSafeInteger(options.afterWatermark ?? 0) && (options.afterWatermark ?? 0) >= 0 ? options.afterWatermark ?? 0 : 0
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  return store.forSession(session).runTransaction(async (transaction) => {
    await transaction.assertAuthorizedContext(session, 'recall')
    const rows = await transaction.query<{ watermark: string; change: unknown }>(
      `SELECT watermark, change FROM ${SQL.changes} WHERE scope_id = $1 AND watermark > $2 ORDER BY watermark LIMIT $3`,
      [session.scope.id, after, limit],
    )
    const overlays: AcceptedChangeOverlay[] = []
    for (const row of rows.rows) {
      if (!row.change || typeof row.change !== 'object') continue
      const change = row.change as Record<string, unknown>
      const version = parseAssertionVersion(change.version)
      const reference = change.assertion
      if (!version.ok || !reference || typeof reference !== 'object') continue
      const ref = reference as Record<string, unknown>
      if (typeof ref.assertionId !== 'string' || typeof ref.revision !== 'number' || (change.operation !== 'remember' && change.operation !== 'correct')) continue
      if (await transaction.isVersionSuppressed(
        { assertionId: ref.assertionId as ExactVersionRef['assertionId'], revision: ref.revision },
        version.value.evidence.map((edge) => edge.eventId),
      )) continue
      overlays.push({
        scopeId: session.scope.id,
        changeWatermark: watermarkId(session.scope.id, Number(row.watermark)),
        operation: change.operation,
        assertion: { assertionId: ref.assertionId as ExactVersionRef['assertionId'], revision: ref.revision },
        version: version.value,
      })
    }
    return overlays
  })
}

export async function resolveExplicitTarget(session: MemorySession, query: string): Promise<ResolveTargetResult> {
  const trimmed = query.trim()
  if (!trimmed) return { ok: false, failure: { code: 'validation', message: 'A target query is required.', retryable: false } }
  const store = storeFor(session)
  return store.forSession(session).runTransaction(async (transaction) => {
    await transaction.assertAuthorizedContext(session, 'correct')
    const candidates = await transaction.scopedCandidates({ scopeId: session.scope.id, subject: session.subject, query: trimmed, limit: 20, asOf: null })
    const exact = candidates.map((candidate) => ({ assertionId: candidate.id, revision: candidate.revision, kind: candidate.kind }))
    if (!exact.length) return { ok: false, failure: { code: 'not_found', message: 'No exact memory target matched this query.', retryable: false } }
    if (exact.length !== 1) {
      return {
        ok: false,
        failure: { code: 'ambiguous', message: 'More than one memory target matched; choose an exact assertion and revision.', retryable: false, details: { candidateCount: exact.length } },
        candidates: exact,
      }
    }
    return { ok: true, target: { assertionId: exact[0].assertionId as ExactVersionRef['assertionId'], revision: exact[0].revision } }
  })
}

export function commandVersionHash(assertion: AssertionVersion): string {
  return assertionVersionHash(assertion)
}
