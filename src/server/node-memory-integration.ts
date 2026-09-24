import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  captureCommittedEvent,
  executeExplicitCommand,
  executeForgetCommand,
  readMemoryMode,
  readCurrentAssertion,
  resolveExplicitTarget,
  retrieveMemory,
  createPostgresMemoryStore,
  createModelExtractor,
  createSubstituteClassifier,
  createTypeSafeClassifier,
  startMemoryBackground,
  CutoverFenceError,
  cutoverScope,
  legacyCompatibilityView,
  parseLegacyMemories,
  readAuthority,
  withWriterLock,
  type LegacySource,
  type MemoryBackgroundHandle,
  type PostgresMemoryStore,
} from '../../backend/memory/src/index.ts'
import type { Memory, MemoryStore } from '../lib/tools/memory'
import { resolveNodeMemorySession } from './node-memory-session'
import type { MemoryExtractor } from '../lib/memory/learning'
import type { MemoryClassifier } from '../lib/memory/classification'
import { createClassifiedExtractor } from '../lib/memory/classified-extractor'
import { RULE_EXTRACTOR } from '../lib/memory/rule-extractor'
import { anyMemoryFeatureEnabled, memoryBackgroundEnabled, memoryClassifierPlan, memoryFeatureFlags, memoryLearningEnabled } from '../lib/memory/rollout'
import { correctShape, recallFieldsFromConversation, rememberShape } from '../lib/memory/recall-context'
import type { ConversationState } from '../lib/conversation-state'
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
import { legacyMemoryFile, nodeOwner, uncachedLegacyStore } from './identity'
import { createServerMemorySession } from './memory-session'

const PG_RUNTIME = Symbol.for('gideon.node.memory-postgres-runtime.v1')
const BACKGROUND = Symbol.for('gideon.node.memory-background.v1')
type PgGlobal = typeof globalThis & { [PG_RUNTIME]?: PostgresMemoryStore; [BACKGROUND]?: MemoryBackgroundHandle }

/** The process-wide PostgreSQL memory store; also used by the Stage 12 controls API. */
export function postgresStore(): PostgresMemoryStore {
  const globals = globalThis as PgGlobal
  const store = globals[PG_RUNTIME] ??= createPostgresMemoryStore()
  ensureBackground(store)
  return store
}

/**
 * The model extractor is paid remote inference over private text, so it needs
 * both an explicit selection and a separate spend switch; otherwise the local
 * rule extractor is used.
 */
function extractorFromEnv(env: NodeJS.ProcessEnv): MemoryExtractor {
  const apiKey = env.OPENROUTER_API_KEY?.trim()
  if (env.GIDEON_MEMORY_EXTRACTOR === 'model' && env.GIDEON_MEMORY_EXTRACTOR_REMOTE_ALLOWED === '1' && apiKey) {
    return createModelExtractor({ apiKey, model: env.GIDEON_MEMORY_EXTRACTOR_MODEL, siteUrl: env.OPENROUTER_SITE_URL })
  }
  return RULE_EXTRACTOR
}

/**
 * Stage 11: an optional classifier around the extractor. Default off; see
 * docs/memory/decisions/0001-jev-classification.md for why. In `shadow` the
 * classified workflow only records disagreement codes; in `enforce` it
 * reviews what the base extractor writes. It never runs on a voice turn.
 */
export function learningExtractorsFromEnv(env: NodeJS.ProcessEnv): { extractor: MemoryExtractor; shadowExtractor?: MemoryExtractor; includeKnownMemories: boolean } {
  const base = extractorFromEnv(env)
  const plan = memoryClassifierPlan(env)
  let classifier: MemoryClassifier | null = null
  if (plan?.provider === 'jev' && env.TYPESAFE_API_KEY?.trim()) {
    classifier = createTypeSafeClassifier({ apiKey: env.TYPESAFE_API_KEY.trim(), model: env.GIDEON_MEMORY_JEV_MODEL })
  } else if (plan?.provider === 'substitute' && env.OPENROUTER_API_KEY?.trim()) {
    classifier = createSubstituteClassifier({ apiKey: env.OPENROUTER_API_KEY.trim(), model: env.GIDEON_MEMORY_CLASSIFIER_MODEL, siteUrl: env.OPENROUTER_SITE_URL })
  }
  if (!plan || !classifier) return { extractor: base, includeKnownMemories: false }
  const classified = createClassifiedExtractor({ base, classifier, mode: plan.workflow })
  return plan.mode === 'enforce'
    ? { extractor: classified, includeKnownMemories: plan.workflow === 'verify' }
    : { extractor: base, shadowExtractor: classified, includeKnownMemories: plan.workflow === 'verify' }
}

/** Starts the bounded maintenance runner once per process when enabled. */
function ensureBackground(store: PostgresMemoryStore): void {
  const globals = globalThis as PgGlobal
  if (globals[BACKGROUND] || !memoryBackgroundEnabled(process.env)) return
  const env = process.env
  globals[BACKGROUND] = startMemoryBackground(store, {
    workerId: `node/${process.pid}`,
    ...learningExtractorsFromEnv(env),
    learning: env.GIDEON_MEMORY_LEARNING_ENABLED === '1',
    learningEnabledFor: (scopeId) => memoryLearningEnabled(process.env, scopeId),
    intervalMs: Number(env.GIDEON_MEMORY_BACKGROUND_INTERVAL_MS) || undefined,
    // Counts only: no content, identifiers or connection details reach the log.
    onError: (count) => { if (count === 1 || count % 50 === 0) console.warn(`[memory] background maintenance failed ${count} time(s)`) },
  })
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

/**
 * The retrieval request the app sends on every turn (exported for tests).
 * The reserves come out of the memory tier's own token budget, so they must
 * leave room: 512 + 256 once consumed all 768 tokens of `standard`, and every
 * automatic recall was rejected as invalid before it ran.
 *
 * Without a provider tokenizer the pack is measured in UTF-8 bytes (a safe
 * upper bound), and the fixed pack header alone is several hundred bytes. At
 * `standard` (576 bytes left after reserves) not even one remembered
 * constraint fit, so every pack collapsed to "budget exhausted" and the model
 * was shown no memory at all. The largest tier leaves about 2,900 bytes, which
 * is roughly 700 real tokens of English; a deep lookup drops the reserves.
 */
export function createRecallInput(query: string, timezone: string, conversationState: ConversationState | null, latestUserText: string, depth?: 'deep') {
  return {
    query,
    // Topic, recent committed turns and local instructions come from the
    // bounded conversation state; the activity kind stays unknown until an
    // interpreter supplies it.
    ...recallFieldsFromConversation(conversationState, latestUserText),
    conversationState,
    requestedTime: { mode: 'current', instant: null, timeZone: timezone || 'UTC' },
    consistency: 'warm_preferred',
    budget: depth
      ? { tier: 'maximum', reserveAnswerTokens: 0, reserveToolTokens: 0 }
      : { tier: 'maximum', reserveAnswerTokens: 128, reserveToolTokens: 64 },
    deadlineAt: new Date(Date.now() + 1_500).toISOString(),
  }
}

/** The per-request memory runtime for an already bound session (exported for tests). */
export function createRuntime(session: MemorySession<PostgresMemoryStore>, flags: ReturnType<typeof memoryFeatureFlags>): MemoryTurnRuntime {
  // The owner's temporary-conversation setting, read once per request. An
  // unreadable setting is not treated as "temporary off": capture and recall
  // then fail the same way the authority itself would.
  let modeRead: Promise<Awaited<ReturnType<typeof readMemoryMode>>> | null = null
  const temporary = async () => {
    modeRead ??= readMemoryMode(session)
    return (await modeRead)?.temporary === true
  }
  const retrieve = async (query: string, context: MemoryRecallTurnContext, signal: AbortSignal) => {
    if (!flags.recall || session.trust !== 'authenticated') return { status: 'unavailable' as const, reason: 'unauthorized' as const }
    if (await temporary()) return { status: 'unavailable' as const, reason: 'temporary' as const }
    if (signal.aborted) return { status: 'unavailable' as const, reason: 'stale' as const }
    if (context.principalId !== session.principal.id || context.scopeId !== session.scope.id || context.policyEpoch !== session.policyEpoch) {
      return { status: 'unavailable' as const, reason: 'stale' as const }
    }
    const result = await retrieveMemory(session, createRecallInput(query, context.timezone, context.conversationState, context.latestUserText, context.depth), { signal })
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
      // A temporary conversation leaves no durable evidence at all.
      if (await temporary()) return { status: 'unavailable', reason: 'temporary_mode' }
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
      const ambiguousTarget = async (candidates: readonly { assertionId: string; revision: number }[], summary: string, question: string): Promise<ToolOutcome> => {
        const labels = await candidateLabels(session, candidates)
        return { ok: true, pending: true, receiptState: 'pending', summary, content: `${question}${labels.length ? `\n${labels.join('\n')}` : ''}` }
      }
      const correctTarget = async (target: { assertionId: string; revision: number }, text: string, shapeArgs: Record<string, unknown>, summary: string): Promise<ToolOutcome> => {
        const shape = correctShape(shapeArgs, context.timezone, new Date())
        if (!shape.ok) return { ok: false, content: `${shape.message} Nothing was changed.`, summary: 'Correction was not applied', receiptState: 'failed' }
        const current = await readCurrentAssertion(session, target.assertionId as AssertionVersion['id'])
        if (!current.version || current.version.revision !== target.revision) return { ok: false, content: 'That memory changed before I could correct it. Nothing was changed.', summary: 'Correction target changed', receiptState: 'failed' }
        const result = await executeExplicitCommand(session, {
          schemaVersion: MEMORY_CONTRACT_VERSION,
          commandId: id,
          kind: 'correct',
          targetAssertionId: target.assertionId,
          targetRevision: target.revision,
          text,
          assertionKind: current.version.kind === 'episode_checkpoint' ? 'fact' : current.version.kind,
          conditions: [],
          ...shape.value,
        }, {
          sourceSpan: flags.capture ? committedSourceSpan(session, context.turnId, context.latestUserText) : null,
        })
        if (!result.ok) return { ok: false, content: 'I could not apply that correction. Nothing was confirmed changed.', summary: 'Correction was not applied', receiptState: 'failed', receiptId: result.receipt.receiptId }
        return { ok: true, content: shape.value.relation === 'transition' ? 'I updated that memory and kept what was true before.' : 'I updated that memory.', summary, receiptState: result.receipt.state, receiptId: result.receipt.receiptId }
      }
      try {
        // Forgetting always works; saving, correcting and looking up do not in a temporary conversation.
        if (name !== 'forget' && await temporary()) {
          return {
            ok: false,
            content: 'A temporary conversation is on, so memory is off: nothing was saved or looked up. It can be turned off in Memory.',
            summary: 'Temporary conversation: memory off',
            receiptState: name === 'recall' ? undefined : 'failed',
          }
        }
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
          const replaces = typeof args.replaces === 'string' ? args.replaces.trim() : ''
          // "Remember X, it replaces Y" is a real-world change to one exact
          // memory, not a second independent fact beside the old one.
          if (replaces) {
            const target = await resolveExplicitTarget(session, replaces)
            if (target.ok) return correctTarget(target.target, text, { change: 'changed', since: args.since }, 'Memory accepted')
            if (target.failure.code === 'ambiguous' && target.candidates?.length) return ambiguousTarget(target.candidates, 'Choose the memory this replaces', 'More than one memory matches what this replaces. Which one changed?')
          }
          const shape = rememberShape(args, context.conversationState, context.timezone, new Date())
          if (!shape.ok) return { ok: false, content: `${shape.message} Nothing was saved.`, summary: 'Memory was not stored', receiptState: 'failed' }
          const result = await executeExplicitCommand(session, {
            schemaVersion: MEMORY_CONTRACT_VERSION,
            commandId: id,
            kind: 'remember',
            text,
            assertionKind: assertionKind(args.kind),
            ...shape.value,
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
            if (target.failure.code === 'ambiguous' && target.candidates?.length) return ambiguousTarget(target.candidates, 'Choose the memory to correct', 'More than one memory matches. Which one do you mean?')
            return { ok: false, content: 'I could not find one exact memory to correct. Nothing was changed.', summary: 'Correction target not found', receiptState: 'failed' }
          }
          return correctTarget(target.target, text, args, 'Correction accepted')
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
        }, {
          // The captured text of this very turn quotes what is being forgotten.
          requestSourceIds: [committedSourceSpan(session, context.turnId, context.latestUserText)?.document.sourceId].filter((sourceId): sourceId is SourceSpan['document']['sourceId'] => Boolean(sourceId)),
        })
        if (!result.ok) {
          if (result.failure.code === 'ambiguous' && result.candidates?.length) return ambiguousTarget(result.candidates, 'Choose the memory to forget', 'More than one memory matches. Which one should I remove?')
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

// ---------------------------------------------------------------------------
// Stage 15: per-owner writer fence between the legacy file and PostgreSQL
// ---------------------------------------------------------------------------

/** Off unless explicitly enabled; with it off every owner behaves exactly as before. */
export function memoryCutoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GIDEON_MEMORY_CUTOVER_ENABLED === '1'
}

/**
 * The legacy JSON file of a signed Node owner, as the cutover reads and (on
 * rollback) rewrites it. Reading is raw: the legacy store refuses a whole
 * file for one bad row, while the cutover must see every row to quarantine
 * the bad ones by name. Unparseable text is returned as text, so the cutover
 * stops with a reason instead of importing nothing.
 */
export function legacySourceFor(owner: string): LegacySource {
  const store = uncachedLegacyStore(owner)
  return {
    async read() {
      let text: string
      try {
        text = await readFile(legacyMemoryFile(owner), 'utf8')
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return null
        throw error
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    },
    write: (memories) => store.mutate(() => ({ memories, result: undefined })),
  }
}

/**
 * The legacy store the old memory tools see during and after a cutover.
 * Writes happen only while the file is the owner's writer, under the shared
 * writer lock; once PostgreSQL is active, reads come from the projection of
 * the new authority, so a stale socket sees current memory and cannot write.
 */
export class FencedLegacyStore implements MemoryStore {
  constructor(private readonly legacy: MemoryStore, private readonly session: MemorySession<PostgresMemoryStore>) {}

  async all(): Promise<Memory[]> {
    const { state } = await readAuthority(this.session.store, this.session.scope.id)
    return state === 'active' ? legacyCompatibilityView(this.session) : this.legacy.all()
  }

  save(): Promise<void> {
    return Promise.reject(new Error('Use a fenced mutation'))
  }

  mutate<T>(change: (memories: Memory[]) => { memories: Memory[]; result: T }): Promise<T> {
    return withWriterLock(this.session.store, this.session.scope.id, ['legacy', 'rolled_back'], () => this.legacy.mutate(change))
  }
}

const PAUSED: ToolOutcome = {
  ok: false,
  content: 'Your memory is being moved to its new home right now, so nothing was saved, changed or forgotten. Please try again in a moment.',
  summary: 'Memory paused while it is moved',
  receiptState: 'failed',
}

/** While fenced: nothing is written to or read from the new authority, and every receipt says so. */
function pausedRuntime(flags: ReturnType<typeof memoryFeatureFlags>): MemoryTurnRuntime {
  return {
    flags,
    captureUserTurn: async () => ({ status: 'unavailable', reason: 'cutover_fenced' }),
    retrieve: async () => ({ status: 'unavailable', reason: 'failure' }),
    execute: async () => PAUSED,
  }
}

/**
 * The PostgreSQL runtime, rechecking the writer on every call: a socket that
 * connected while PostgreSQL was active keeps writing only while it still is.
 */
function guardedRuntime(runtime: MemoryTurnRuntime, store: PostgresMemoryStore, scopeId: string): MemoryTurnRuntime {
  const guard = <T>(work: () => Promise<T>) => withWriterLock(store, scopeId, ['active'], work)
  const active = async () => (await readAuthority(store, scopeId).catch(() => null))?.state === 'active'
  return {
    flags: runtime.flags,
    async captureUserTurn(context, signal) {
      try {
        return await guard(() => runtime.captureUserTurn!(context, signal))
      } catch (error) {
        if (error instanceof CutoverFenceError) return { status: 'unavailable', reason: 'cutover_fenced' }
        throw error
      }
    },
    async retrieve(query, context, signal) {
      if (!(await active())) return { status: 'unavailable', reason: 'stale' }
      return runtime.retrieve(query, context, signal)
    },
    async execute(name, args, context) {
      if (name === 'recall') return (await active()) ? runtime.execute(name, args, context) : PAUSED
      try {
        return await guard(() => runtime.execute(name, args, context))
      } catch (error) {
        if (error instanceof CutoverFenceError) return PAUSED
        throw error
      }
    },
  }
}

/**
 * The memory session and runtime for one HTTP turn or one socket. Without
 * the cutover switch this is exactly the pre-Stage-15 pair. With it, the
 * owner's recorded writer decides: the legacy file (fenced store, no
 * runtime), PostgreSQL (guarded runtime), or neither while fenced. An owner
 * with no legacy memory is moved at once; anyone else waits for an operator
 * cutover.
 */
export async function resolveNodeMemoryForTurn(
  request: { headers: { get(name: string): string | null } },
  channel: 'http' | 'websocket',
): Promise<{ memorySession: ReturnType<typeof resolveNodeMemorySession>; memoryRuntime: MemoryTurnRuntime | undefined }> {
  const memorySession = resolveNodeMemorySession(request, channel)
  if (!memoryCutoverEnabled()) return { memorySession, memoryRuntime: resolveNodeMemoryIntegration(request, channel) }
  const owner = nodeOwner(request.headers)
  const flags = memoryFeatureFlags(process.env, owner, Boolean(owner))
  if (!owner || !anyMemoryFeatureEnabled(flags)) return { memorySession, memoryRuntime: undefined }

  let store: PostgresMemoryStore
  try {
    store = postgresStore()
  } catch {
    return { memorySession, memoryRuntime: { flags, retrieve: async () => ({ status: 'unavailable', reason: 'not_configured' }), execute: async () => unavailableOutcome() } }
  }
  const session = createServerMemorySession({ owner, store, channel, authority: 'node_signed_cookie' })
  const legacy = legacySourceFor(owner)
  const fencedSession = createServerMemorySession({ owner, store: new FencedLegacyStore(uncachedLegacyStore(owner), session), channel, authority: 'node_signed_cookie' })
  try {
    let { state } = await readAuthority(store, session.scope.id)
    if (state === 'legacy') {
      const parsed = parseLegacyMemories(await legacy.read())
      if (!parsed.valid.length && !parsed.quarantined.length) {
        const report = await cutoverScope(session, legacy)
        if (report.outcome === 'activated' || report.outcome === 'already_active') state = 'active'
      }
    }
    if (state === 'active') return { memorySession: fencedSession, memoryRuntime: guardedRuntime(createRuntime(session, flags), store, session.scope.id) }
    if (state === 'fenced') return { memorySession: fencedSession, memoryRuntime: pausedRuntime(flags) }
    return { memorySession: fencedSession, memoryRuntime: undefined }
  } catch {
    // The writer cannot be read: nothing may be written anywhere.
    return { memorySession: fencedSession, memoryRuntime: pausedRuntime(flags) }
  }
}
