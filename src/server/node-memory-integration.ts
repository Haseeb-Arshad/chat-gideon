import { createHash } from 'node:crypto'
import {
  captureCommittedEvent,
  executeExplicitCommand,
  executeForgetCommand,
  readCurrentAssertion,
  resolveExplicitTarget,
  retrieveMemory,
  createPostgresMemoryStore,
  type PostgresMemoryStore,
} from '../../backend/memory/src/index.ts'
import { memoryFeatureFlags } from '../lib/memory/rollout'
import {
  MEMORY_CONTRACT_VERSION,
  parsePublicMemoryCommand,
  type AssertionVersion,
  type ConsentId,
  type EventEnvelope,
  type MemorySession,
  type SourceSpan,
} from '../lib/memory/contracts'
import type { MemoryCaptureTurnContext, MemoryRecallTurnContext, MemoryTurnRuntime } from '../lib/memory/turn-runtime'
import type { ToolOutcome } from '../lib/tools/registry'
import { nodeOwner } from './identity'
import { createServerMemorySession } from './memory-session'

const PG_RUNTIME = Symbol.for('gideon.node.memory-postgres-runtime.v1')
type PgGlobal = typeof globalThis & { [PG_RUNTIME]?: PostgresMemoryStore }

function postgresStore(): PostgresMemoryStore {
  const globals = globalThis as PgGlobal
  return globals[PG_RUNTIME] ??= createPostgresMemoryStore()
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function commandId(scopeId: string, turnId: string, callId: string): string {
  return `memory/${hash(`${scopeId}\0${turnId}\0${callId}`).slice(0, 48)}`
}

function committedSourceSpan(session: MemorySession, turnId: string, raw: string): SourceSpan | null {
  const text = raw.normalize('NFKC').trim()
  if (!text || text.length > 8_192) return null
  const contentHash = hash(text)
  const sourceId = `source/turn/${hash(`${session.scope.id}\0${turnId}`).slice(0, 40)}`
  const revision = `revision/source/${contentHash.slice(0, 40)}`
  return {
    document: { sourceId: sourceId as SourceSpan['document']['sourceId'], revision: revision as SourceSpan['document']['revision'], contentHash },
    start: 0,
    end: text.length,
    textHash: contentHash,
    quote: text,
  }
}

/** Builds one idempotent, user-only source event; assistant history never enters it. */
export function buildCommittedUserEvent(
  session: MemorySession,
  context: MemoryCaptureTurnContext,
): EventEnvelope | null {
  const sourceSpan = committedSourceSpan(session, context.turnId, context.latestUserText)
  if (!sourceSpan) return null
  const eventKey = hash(`${session.scope.id}\0${context.turnId}`)
  const conversationKey = hash(`${session.scope.id}\0${context.conversationId}`)
  const turnKey = hash(`${session.scope.id}\0${context.turnId}`)
  const policyRevision = `revision/policy/${session.policyEpoch}` as EventEnvelope['sourceAuthority']['revision']
  return {
    schemaVersion: MEMORY_CONTRACT_VERSION,
    id: `event/user/${eventKey.slice(0, 48)}` as EventEnvelope['id'],
    idempotencyKey: `capture/user/${eventKey.slice(0, 64)}`,
    conversationId: `conversation/${conversationKey.slice(0, 48)}` as EventEnvelope['conversationId'],
    turnId: `turn/${turnKey.slice(0, 48)}` as EventEnvelope['turnId'],
    actor: { kind: 'principal', principalId: session.principal.id },
    subject: session.subject,
    sourceKind: 'user_statement',
    sourceAuthority: { kind: 'authenticated_user', revision: sourceSpan.document.revision },
    committedPhase: 'committed',
    sequence: 1,
    sourceTime: null,
    sourceTimePrecision: 'unknown',
    receivedAt: new Date().toISOString(),
    consent: {
      id: `consent/${eventKey.slice(0, 48)}` as ConsentId,
      policyVersion: policyRevision,
      purpose: 'memory_capture',
    },
    sourceSpans: [sourceSpan],
    payload: { text: sourceSpan.quote ?? context.latestUserText },
  }
}

function textOf(version: AssertionVersion): string {
  const payload = version.payload
  if (payload.kind === 'fact') return payload.proposition.type === 'free_form'
    ? payload.proposition.text
    : `${payload.proposition.slot.slotId}: ${String(payload.proposition.value)}`
  if (payload.kind === 'preference' || payload.kind === 'constraint') return payload.text
  if (payload.kind === 'decision') return `${payload.topic}: ${payload.decision}`
  return `${payload.topic}: ${payload.decisions.join('; ')}`
}

async function candidateLabels(session: MemorySession, candidates: readonly { assertionId: string; revision: number }[]): Promise<string[]> {
  const labels: string[] = []
  for (const candidate of candidates.slice(0, 5)) {
    const result = await readCurrentAssertion(session, candidate.assertionId as AssertionVersion['id'])
    if (result.version && result.version.revision === candidate.revision) labels.push(`- ${textOf(result.version).slice(0, 240)}`)
  }
  return labels
}

function unavailableOutcome(): ToolOutcome {
  return { ok: false, content: 'Stored memory is unavailable right now. Nothing was confirmed changed.', summary: 'Memory operation unavailable', receiptState: 'failed' }
}

function assertionKind(value: unknown): 'fact' | 'preference' | 'constraint' | 'decision' {
  if (value === 'preference' || value === 'constraint' || value === 'decision') return value
  if (value === 'plan') return 'decision'
  return 'fact'
}

function createRecallInput(query: string, timezone: string, depth?: 'deep') {
  return {
    query,
    resolved: { topicId: null, topicLabel: null, entities: [], assertionIds: [], artifactIds: [], unknownReferents: [] },
    activity: { kind: null, topicId: null, topicLabel: null, projectId: null, format: null, attributes: {} },
    requestedTime: { mode: 'current', instant: null, timeZone: timezone || 'UTC' },
    consistency: 'warm_preferred',
    budget: { tier: depth ? 'expanded' : 'standard', reserveAnswerTokens: 512, reserveToolTokens: 256 },
    deadlineAt: new Date(Date.now() + 1_500).toISOString(),
  }
}

function createRuntime(session: MemorySession<PostgresMemoryStore>, flags: ReturnType<typeof memoryFeatureFlags>): MemoryTurnRuntime {
  const retrieve = async (query: string, context: MemoryRecallTurnContext, signal: AbortSignal) => {
    if (!flags.recall || session.trust !== 'authenticated') return { status: 'unavailable' as const, reason: 'unauthorized' as const }
    if (signal.aborted) return { status: 'unavailable' as const, reason: 'stale' as const }
    if (context.principalId !== session.principal.id || context.scopeId !== session.scope.id || context.policyEpoch !== session.policyEpoch) {
      return { status: 'unavailable' as const, reason: 'stale' as const }
    }
    const result = await retrieveMemory(session, createRecallInput(query, context.timezone, context.depth), { signal })
    if (signal.aborted) return { status: 'unavailable' as const, reason: 'stale' as const }
    if (!result.ok) {
      return { status: 'unavailable' as const, reason: result.failure.code === 'unauthorized' ? 'unauthorized' as const : 'failure' as const }
    }
    if (!result.pack || result.pack.status === 'unavailable') {
      return { status: 'unavailable' as const, reason: 'failure' as const }
    }
    if (result.pack.authenticatedContext.principalId !== session.principal.id
      || result.pack.authenticatedContext.scopeId !== session.scope.id
      || result.pack.authenticatedContext.policyEpoch !== session.policyEpoch) {
      return { status: 'unavailable' as const, reason: 'stale' as const }
    }
    return { status: 'ready' as const, binding: context, pack: result.pack }
  }

  return {
    flags,
    async captureUserTurn(context, signal) {
      if (!flags.capture || session.trust !== 'authenticated') return { status: 'unavailable', reason: 'unauthorized' }
      if (signal.aborted) return { status: 'unavailable', reason: 'stale' }
      const event = buildCommittedUserEvent(session, context)
      if (!event) return { status: 'failed', reason: 'empty_or_oversized_user_turn' }
      const receipt = await captureCommittedEvent(session.store, session, event, { assignSequence: true })
      if (receipt.ok) return { status: 'captured', receiptState: receipt.state === 'pending' ? 'captured' : receipt.state }
      return { status: receipt.failure.code === 'unavailable' ? 'unavailable' : 'failed', reason: receipt.failure.code }
    },
    retrieve,
    async execute(name, args, context) {
      if (context.signal.aborted || session.trust !== 'authenticated') return unavailableOutcome()
      const id = commandId(session.scope.id, context.turnId, context.callId)
      try {
        if (name === 'recall') {
          const query = typeof args.query === 'string' ? args.query.trim() : ''
          if (!query) return { ok: false, content: 'Nothing was given to look up in memory.', summary: 'Memory lookup was not run' }
          const command = parsePublicMemoryCommand({ schemaVersion: MEMORY_CONTRACT_VERSION, commandId: id, kind: 'recall', query, limit: args.depth === 'deep' ? 12 : 5 })
          if (!command.ok) return { ok: false, content: 'That memory question could not be read safely.', summary: 'Memory lookup was not run' }
          const recalled = await retrieve(query, { ...context, depth: args.depth === 'deep' ? 'deep' : undefined }, context.signal)
          if (context.signal.aborted) return { ok: false, content: 'The memory lookup was interrupted.', summary: 'Memory lookup interrupted' }
          if (recalled.status !== 'ready') return unavailableOutcome()
          if (!recalled.pack.text.trim()) return { ok: true, content: 'The bounded search did not find a relevant memory; that does not prove the detail was never shared.', summary: 'Memory search complete' }
          return { ok: true, content: recalled.pack.text, summary: 'Memory search complete' }
        }

        if (name === 'remember') {
          const text = typeof args.text === 'string' ? args.text.trim() : ''
          if (!text) return { ok: false, content: 'Nothing was given to remember.', summary: 'Memory was not stored', receiptState: 'failed' }
          const result = await executeExplicitCommand(session, {
            schemaVersion: MEMORY_CONTRACT_VERSION,
            commandId: id,
            kind: 'remember',
            text,
            assertionKind: assertionKind(args.kind),
            conditions: [],
          }, {
            sourceSpan: flags.capture ? committedSourceSpan(session, context.turnId, context.latestUserText) : null,
          })
          if (!result.ok) return { ok: false, content: 'I could not store that. Nothing was confirmed saved.', summary: 'Memory was not stored', receiptState: 'failed', receiptId: result.receipt.receiptId }
          return {
            ok: true,
            content: result.outcome === 'duplicate' ? 'I already have that.' : 'I saved that.',
            summary: result.outcome === 'duplicate' ? 'Memory already recorded' : 'Memory accepted',
            receiptState: result.receipt.state,
            receiptId: result.receipt.receiptId,
          }
        }

        if (name === 'correct') {
          const query = typeof args.query === 'string' ? args.query.trim() : ''
          const text = typeof args.text === 'string' ? args.text.trim() : ''
          if (!query || !text) return { ok: false, content: 'I need the exact memory and its corrected wording before changing it.', summary: 'Correction not applied', receiptState: 'failed' }
          const target = await resolveExplicitTarget(session, query)
          if (!target.ok) {
            if (target.failure.code === 'ambiguous' && target.candidates?.length) {
              const labels = await candidateLabels(session, target.candidates)
              return { ok: true, pending: true, receiptState: 'pending', summary: 'Choose the memory to correct', content: `More than one memory matches. Which one do you mean?${labels.length ? `\n${labels.join('\n')}` : ''}` }
            }
            return { ok: false, content: 'I could not find one exact memory to correct. Nothing was changed.', summary: 'Correction target not found', receiptState: 'failed' }
          }
          const current = await readCurrentAssertion(session, target.target.assertionId)
          if (!current.version) return { ok: false, content: 'That memory changed before I could correct it. Nothing was changed.', summary: 'Correction target changed', receiptState: 'failed' }
          const result = await executeExplicitCommand(session, {
            schemaVersion: MEMORY_CONTRACT_VERSION,
            commandId: id,
            kind: 'correct',
            targetAssertionId: target.target.assertionId,
            targetRevision: target.target.revision,
            text,
            assertionKind: current.version.kind === 'episode_checkpoint' ? 'fact' : current.version.kind,
            conditions: [],
          }, {
            sourceSpan: flags.capture ? committedSourceSpan(session, context.turnId, context.latestUserText) : null,
          })
          if (!result.ok) return { ok: false, content: 'I could not apply that correction. Nothing was confirmed changed.', summary: 'Correction was not applied', receiptState: 'failed', receiptId: result.receipt.receiptId }
          return { ok: true, content: 'I updated that memory.', summary: 'Correction accepted', receiptState: result.receipt.state, receiptId: result.receipt.receiptId }
        }

        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (!query) return { ok: false, content: 'Nothing was given to forget.', summary: 'Memory was not forgotten', receiptState: 'failed' }
        const result = await executeForgetCommand(session, {
          schemaVersion: MEMORY_CONTRACT_VERSION,
          commandId: id,
          kind: 'forget',
          targetAssertionId: null,
          targetRevision: null,
          query,
        })
        if (!result.ok) {
          if (result.failure.code === 'ambiguous' && result.candidates?.length) {
            const labels = await candidateLabels(session, result.candidates)
            return { ok: true, pending: true, receiptState: 'pending', summary: 'Choose the memory to forget', content: `More than one memory matches. Which one should I remove?${labels.length ? `\n${labels.join('\n')}` : ''}` }
          }
          return { ok: false, content: 'I could not confirm that memory removal. Nothing was reported as forgotten.', summary: 'Memory was not forgotten', receiptState: 'failed' }
        }
        const cleanup = result.receipt.physical.status === 'complete' ? 'Physical cleanup is complete.' : 'Physical cleanup is still pending.'
        return { ok: true, content: `That memory is no longer available to recall. ${cleanup}`, summary: result.receipt.physical.status === 'complete' ? 'Memory removal complete' : 'Memory removal accepted; cleanup pending', receiptState: 'accepted', receiptId: result.receipt.receiptId }
      } catch {
        return unavailableOutcome()
      }
    },
  }
}

/**
 * Shared Node adapter used by HTTP and realtime. The signed owner cookie is
 * resolved before flags/session/store selection; unverified callers never
 * receive a PostgreSQL session. This does not migrate or provision accounts.
 */
export function resolveNodeMemoryIntegration(
  request: { headers: { get(name: string): string | null } },
  channel: 'http' | 'websocket',
): MemoryTurnRuntime | undefined {
  const owner = nodeOwner(request.headers)
  const flags = memoryFeatureFlags(process.env, owner, Boolean(owner))
  if (!flags.capture && !flags.commandWrites && !flags.recall) return undefined
  if (!owner) return undefined

  let store: PostgresMemoryStore
  try {
    store = postgresStore()
  } catch {
    return {
      flags,
      retrieve: async () => ({ status: 'unavailable', reason: 'not_configured' }),
      execute: async () => unavailableOutcome(),
    }
  }
  const session = createServerMemorySession({ owner, store, channel, authority: 'node_signed_cookie' })
  return createRuntime(session, flags)
}
