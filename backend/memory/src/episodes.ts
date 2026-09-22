import type {
  AssertionVersion,
  ConsentRef,
  EventEnvelope,
  MemoryFailure,
  MemoryReceipt,
  MemorySession,
  RevisionId,
} from '../../../src/lib/memory/contracts.ts'
import {
  checkpointConversationState,
  episodeCheckpointPayload,
  expireConversationState,
  readConversationState,
  serializeConversationState,
  type ConversationState,
} from '../../../src/lib/conversation-state.ts'
import { PostgresMemoryOperationError, PostgresMemoryStore } from './postgres.ts'
import { eventContentHash, isoNow } from './serialization.ts'

const EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

export type DurableEpisodeSession = MemorySession<PostgresMemoryStore>

export interface PersistEpisodeCheckpointInput {
  episodeId: string
  state: ConversationState
  sourceEventIds?: readonly EventEnvelope['id'][]
  consent: ConsentRef
  now?: string
}

export type PersistEpisodeCheckpointResult =
  | {
      ok: true
      state: ConversationState
      assertion: AssertionVersion
      receipt: MemoryReceipt
    }
  | {
      ok: false
      state: null
      assertion: null
      receipt: MemoryReceipt | null
      failure: MemoryFailure
    }

export type ResumeEpisodeCheckpointResult =
  | {
      ok: true
      status: 'resumed'
      state: ConversationState
      assertion: AssertionVersion
    }
  | {
      ok: true
      status: 'not_found' | 'expired'
      state: null
      assertion: AssertionVersion | null
    }
  | {
      ok: false
      status: 'failed'
      state: null
      assertion: null
      failure: MemoryFailure
    }

function operationFailure(code: MemoryFailure['code'], message: string, retryable = false, details?: MemoryFailure['details']): MemoryFailure {
  return { code, message, retryable, ...(details ? { details } : {}) }
}

function failureResult(failure: MemoryFailure, receipt: MemoryReceipt | null = null): PersistEpisodeCheckpointResult {
  return { ok: false, state: null, assertion: null, receipt, failure }
}

function resumeFailure(failure: MemoryFailure): ResumeEpisodeCheckpointResult {
  return { ok: false, status: 'failed', state: null, assertion: null, failure }
}

function validNow(value: string | undefined): string | null {
  if (!value) return isoNow()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

function canonicalEpisodeId(value: string): string | null {
  const trimmed = value.trim()
  return EPISODE_ID.test(trimmed) ? trimmed : null
}

function canonicalEventIds(values: readonly EventEnvelope['id'][] | undefined): EventEnvelope['id'][] | null {
  const unique = [...new Set(values ?? [])]
  if (unique.length > 16 || unique.some((value) => !EVENT_ID.test(value))) return null
  return unique
}

function checkpointAssertionId(episodeId: string): AssertionVersion['id'] {
  return `assertion/episode/${episodeId}` as AssertionVersion['id']
}

function checkpointCanonicalKey(episodeId: string): string {
  return `episode/${episodeId}`
}

function checkpointIdempotencyKey(episodeId: string, sourceWatermark: string): string {
  return `episode-checkpoint/${episodeId}/${sourceWatermark}`.slice(0, 160)
}

function revisionFromReceipt(receipt: MemoryReceipt): number | null {
  if (!receipt.ok || receipt.state !== 'accepted') return null
  const match = receipt.canonicalRevision.match(/\/(\d+)$/)
  return match ? Number(match[1]) : null
}

function restoredStateFromAssertion(assertion: AssertionVersion | null): ConversationState | null {
  if (!assertion || assertion.kind !== 'episode_checkpoint' || assertion.payload.kind !== 'episode_checkpoint') return null
  return readConversationState(assertion.payload.state)
}

function acceptedReceipt(event: EventEnvelope, assertion: AssertionVersion): MemoryReceipt {
  return {
    schemaVersion: 1,
    receiptId: `receipt/${event.id}`,
    eventId: event.id,
    receivedAt: event.receivedAt,
    ok: true,
    state: 'accepted',
    canonicalRevision: `revision/${assertion.id}/${assertion.revision}` as RevisionId,
    indexWatermark: null,
  }
}

function checkpointEvent(
  session: DurableEpisodeSession,
  episodeId: string,
  state: ConversationState,
  consent: ConsentRef,
  sourceEventIds: readonly EventEnvelope['id'][],
  now: string,
  sequence: number,
): EventEnvelope {
  const sourceWatermark = state.sourceWatermark
  const id = `event/episode/${episodeId}/${sourceWatermark.replace(/[^A-Za-z0-9._:/-]/g, '_')}` as EventEnvelope['id']
  return {
    schemaVersion: 1,
    id,
    idempotencyKey: checkpointIdempotencyKey(episodeId, sourceWatermark),
    conversationId: state.conversationId as EventEnvelope['conversationId'],
    turnId: `turn/episode/${episodeId}/${sourceWatermark.replace(/[^A-Za-z0-9._:/-]/g, '_')}` as EventEnvelope['turnId'],
    actor: { kind: 'assistant', assistantId: 'gideon' },
    subject: session.subject,
    sourceKind: 'assistant_generated',
    sourceAuthority: { kind: 'server_generated', revision: `revision/episode/${episodeId}/${sourceWatermark}` as EventEnvelope['sourceAuthority']['revision'] },
    committedPhase: 'committed',
    sequence,
    sourceTime: null,
    sourceTimePrecision: 'unknown',
    receivedAt: now,
    consent,
    sourceSpans: [],
    payload: {
      kind: 'episode_checkpoint',
      episodeId,
      sourceEventIds,
      sourceWatermark,
      state: serializeConversationState(state),
    },
  }
}

export async function persistEpisodeCheckpoint(
  session: DurableEpisodeSession,
  input: PersistEpisodeCheckpointInput,
): Promise<PersistEpisodeCheckpointResult> {
  const episodeId = canonicalEpisodeId(input.episodeId)
  const sourceEventIds = canonicalEventIds(input.sourceEventIds)
  const now = validNow(input.now)
  if (!episodeId) return failureResult(operationFailure('validation', 'The episode id is invalid.'))
  if (!sourceEventIds) return failureResult(operationFailure('validation', 'Episode source events must contain at most 16 valid event ids.'))
  if (!now) return failureResult(operationFailure('validation', 'The checkpoint timestamp is invalid.'))
  if (!['memory_capture', 'memory_retention'].includes(input.consent.purpose)) {
    return failureResult(operationFailure('validation', 'Episode checkpoints require memory capture or retention consent.'))
  }
  const validated = readConversationState(serializeConversationState(input.state))
  if (!validated) return failureResult(operationFailure('validation', 'The conversation state is invalid or exceeds the bounded snapshot limit.'))
  if (validated.conversationId !== input.state.conversationId) return failureResult(operationFailure('validation', 'The conversation state identity could not be normalized.'))

  const state = checkpointConversationState(validated, { now })
  const assertionId = checkpointAssertionId(episodeId)
  const store = session.store.forSession(session)
  try {
    return await store.runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(session, 'remember')
      const idempotencyKey = checkpointIdempotencyKey(episodeId, state.sourceWatermark)
      const existing = await transaction.findEventRecordByIdempotency(idempotencyKey)
      if (existing) {
        const existingEvent = await transaction.findEventByIdempotency(idempotencyKey)
        const retryEvent = existingEvent ? checkpointEvent(session, episodeId, state, input.consent, sourceEventIds, now, existingEvent.sequence) : null
        const incomingHash = retryEvent ? eventContentHash(session.scope.id, retryEvent) : null
        if (!incomingHash || existing.content_hash !== incomingHash) {
          return failureResult(operationFailure('conflict', 'This episode checkpoint idempotency key is already bound to different content.'))
        }
        const existingReceipt = await transaction.readReceiptByEvent(existing.event_id)
        if (existingReceipt?.ok) {
          const existingRevision = revisionFromReceipt(existingReceipt)
          const existingAssertion = existingRevision ? await transaction.exactVersion({ assertionId, revision: existingRevision }) : null
          const existingState = restoredStateFromAssertion(existingAssertion)
          if (existingAssertion && existingState) return { ok: true, state: existingState, assertion: existingAssertion, receipt: existingReceipt }
        }
        return failureResult(operationFailure('unavailable', 'The stored episode checkpoint is incomplete and cannot be resumed.', true), existingReceipt)
      }

      const eventSequence = await transaction.nextEventSequence()
      const event = checkpointEvent(session, episodeId, state, input.consent, sourceEventIds, now, eventSequence)
      if (await transaction.insertEvent(event) !== 'inserted') {
        return failureResult(operationFailure('conflict', 'The episode checkpoint was concurrently claimed; retry the same state.', true))
      }
      const prior = await transaction.currentVersion(assertionId)
      const assertion: AssertionVersion = {
        schemaVersion: 1,
        id: assertionId,
        revision: (prior?.revision ?? 0) + 1,
        scopeId: session.scope.id,
        subject: session.subject,
        kind: 'episode_checkpoint',
        payload: episodeCheckpointPayload(state),
        attribution: { actor: { kind: 'assistant', assistantId: 'gideon' }, basis: 'inference' },
        polarity: 'unknown',
        status: 'accepted',
        time: {
          validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null },
          receivedAt: now,
          interpretedAt: now,
          relation: 'ordinary',
        },
        evidence: [
          ...sourceEventIds.map((eventId) => ({ eventId, span: null, relation: 'supports' as const })),
          { eventId: event.id, span: null, relation: 'derived_from' as const },
        ],
        dependencies: [],
        producer: { name: 'conversation-state', version: '1', model: null },
        supersedes: prior ? { assertionId: prior.id, revision: prior.revision } : null,
      }
      const committed = await transaction.commitAssertion({
        assertion,
        expectedRevision: prior?.revision ?? null,
        slot: null,
        canonicalKey: checkpointCanonicalKey(episodeId),
      })
      if (!committed.ok) return failureResult(committed.failure)
      const receipt = acceptedReceipt(event, assertion)
      await transaction.insertCapturedReceipt(receipt, event.id)
      return { ok: true, state, assertion, receipt }
    })
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return failureResult(error.failure)
    return failureResult(operationFailure('unavailable', 'Memory authority is unavailable; no episode checkpoint receipt was committed.', true))
  }
}

export async function resumeEpisodeCheckpoint(
  session: DurableEpisodeSession,
  episodeIdInput: string,
  options: { now?: string } = {},
): Promise<ResumeEpisodeCheckpointResult> {
  const episodeId = canonicalEpisodeId(episodeIdInput)
  const now = validNow(options.now)
  if (!episodeId) return resumeFailure(operationFailure('validation', 'The episode id is invalid.'))
  if (!now) return resumeFailure(operationFailure('validation', 'The resume timestamp is invalid.'))
  const store = session.store.forSession(session)
  try {
    return await store.runTransaction(async (transaction) => {
      await transaction.assertAuthorizedContext(session, 'recall')
      const assertion = await transaction.currentVersion(checkpointAssertionId(episodeId))
      const state = restoredStateFromAssertion(assertion)
      if (!assertion || !state) return { ok: true, status: 'not_found', state: null, assertion: null }
      const expired = expireConversationState(state, now)
      if (expired.expiresAt && Date.parse(expired.expiresAt) <= Date.parse(now)) return { ok: true, status: 'expired', state: null, assertion }
      if (state.checkpoint && !expired.checkpoint) return { ok: true, status: 'expired', state: null, assertion }
      return { ok: true, status: 'resumed', state: expired, assertion }
    })
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return resumeFailure(error.failure)
    return resumeFailure(operationFailure('unavailable', 'Memory authority is unavailable; the episode could not be resumed.', true))
  }
}
