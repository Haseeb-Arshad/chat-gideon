import { readFile } from 'node:fs/promises'
import {
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
import {
  type MemorySession,
} from '../lib/memory/contracts'
import type { MemoryTurnRuntime } from '../lib/memory/turn-runtime'
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

import { createRuntime, unavailableOutcome } from './memory-turn-runtime'
export { buildCommittedUserEvent, createRecallInput, createRuntime } from './memory-turn-runtime'

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
