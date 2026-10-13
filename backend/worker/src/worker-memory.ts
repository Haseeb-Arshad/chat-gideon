import { Client, Pool } from 'pg'
import {
  CutoverFenceError,
  cutoverScope,
  legacyCompatibilityView,
  parseLegacyMemories,
  readAuthority,
  withWriterLock,
  closeWriterLocks,
  type LegacySource,
} from '../../memory/src/cutover.ts'
import type { PostgresMemoryStore } from '../../memory/src/postgres.ts'
import { PostgresMemoryStore as MemoryStorePostgres } from '../../memory/src/postgres.ts'
import { anyMemoryFeatureEnabled, memoryFeatureFlags } from '../../../src/lib/memory/rollout'
import type { MemoryTurnRuntime } from '../../../src/lib/memory/turn-runtime'
import { createServerMemorySession } from '../../../src/server/memory-session'
import { createRuntime, unavailableOutcome } from '../../../src/server/memory-turn-runtime'
import { memoryRetrievalOptions } from '../../memory/src/providers.ts'
import type { Memory, MemoryStore } from '../../../src/lib/tools/memory'
import type { MemorySession } from '../../../src/lib/memory/contracts'
import type { Env } from './types'

export interface WorkerMemoryContext {
  memoryStore: MemoryStore
  memorySession: MemorySession<MemoryStore>
  memoryRuntime?: MemoryTurnRuntime
  controlSession?: MemorySession<PostgresMemoryStore>
  close(): Promise<void>
}

const KEEP_OPEN = async () => undefined

function flagsFor(env: Env, owner: string) {
  const nodeEnv = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test' ? 'development' : 'production'
  return memoryFeatureFlags({
    NODE_ENV: nodeEnv,
    GIDEON_MEMORY_STAGE15_CUTOVER: env.GIDEON_MEMORY_STAGE15_CUTOVER,
    GIDEON_MEMORY_CANONICAL_ONLY: env.GIDEON_MEMORY_CANONICAL_ONLY,
    GIDEON_MEMORY_ROLLOUT_PERCENT: env.GIDEON_MEMORY_ROLLOUT_PERCENT,
    GIDEON_MEMORY_CAPTURE_ENABLED: env.GIDEON_MEMORY_CAPTURE_ENABLED,
    GIDEON_MEMORY_COMMAND_WRITES_ENABLED: env.GIDEON_MEMORY_COMMAND_WRITES_ENABLED,
    GIDEON_MEMORY_RECALL_ENABLED: env.GIDEON_MEMORY_RECALL_ENABLED,
  }, owner, owner.startsWith('user/'))
}

function createStore(connectionString: string): { store: PostgresMemoryStore; close(): Promise<void> } {
  const pool = new Pool({
    connectionString,
    // Five recall branches, the mode and authority reads beside them, and
    // capture all run at once. A smaller pool queues those bounded reads behind
    // each other even though retrieval uses Promise.all.
    max: 8,
    connectionTimeoutMillis: 3_000,
    // Long enough to span the pause between two things said, so the second
    // turn finds the first one's connections still open.
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
    application_name: 'chat-gideon-worker-memory',
  })
  pool.on('error', () => undefined)
  const store = new MemoryStorePostgres(pool)
  return {
    store,
    async close() {
      await closeWriterLocks(store).catch(() => undefined)
      await pool.end().catch(() => undefined)
    },
  }
}

async function legacySource(connectionString: string, owner: string): Promise<LegacySource> {
  const read = async () => {
    const client = new Client({ connectionString })
    client.on('error', () => undefined)
    await client.connect()
    try {
      const result = await client.query('SELECT memories FROM public.gideon_memories WHERE session_id = $1', [owner])
      if (result.rows.length > 1) throw new Error('Legacy memory owner is not unique')
      return result.rows.length ? (result.rows[0] as { memories: unknown }).memories : null
    } finally {
      await client.end().catch(() => undefined)
    }
  }
  return {
    read,
    async write(memories: Memory[]) {
      const client = new Client({ connectionString })
      client.on('error', () => undefined)
      await client.connect()
      try {
        await client.query(
          `INSERT INTO public.gideon_memories (session_id, memories) VALUES ($1, $2::jsonb)
           ON CONFLICT (session_id) DO UPDATE SET memories = excluded.memories`,
          [owner, JSON.stringify(memories)],
        )
      } finally {
        await client.end().catch(() => undefined)
      }
    },
  }
}

class FencedLegacyStore implements MemoryStore {
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

const PAUSED = {
  ok: false,
  content: 'Your memory is being moved to its new home right now, so nothing was saved, changed or forgotten. Please try again in a moment.',
  summary: 'Memory paused while it is moved',
  receiptState: 'failed' as const,
}

function pausedRuntime(flags: ReturnType<typeof memoryFeatureFlags>): MemoryTurnRuntime {
  return {
    flags,
    captureUserTurn: async () => ({ status: 'unavailable', reason: 'cutover_fenced' }),
    retrieve: async () => ({ status: 'unavailable', reason: 'failure' }),
    execute: async () => PAUSED,
  }
}

function guardedRuntime(runtime: MemoryTurnRuntime, store: PostgresMemoryStore, scopeId: string): MemoryTurnRuntime {
  const guard = <T>(work: () => Promise<T>) => withWriterLock(store, scopeId, ['active'], work)
  const active = async () => (await readAuthority(store, scopeId).catch(() => null))?.state === 'active'
  return {
    flags: runtime.flags,
    async observeTurn(turn) { if (await active()) await runtime.observeTurn?.(turn) },
    async captureUserTurn(context, signal) {
      try { return await guard(() => runtime.captureUserTurn!(context, signal)) }
      catch (error) {
        if (error instanceof CutoverFenceError) return { status: 'unavailable', reason: 'cutover_fenced' }
        throw error
      }
    },
    async retrieve(query, context, signal) {
      // Checked beside the lookup rather than in front of it: a lookup made
      // while the owner was being moved is thrown away unread, and every other
      // turn no longer pays a round trip before its lookup starts.
      const [isActive, result] = await Promise.all([active(), runtime.retrieve(query, context, signal)])
      return isActive ? result : { status: 'unavailable', reason: 'stale' }
    },
    async execute(name, args, context) {
      if (name === 'recall') return (await active()) ? runtime.execute(name, args, context) : PAUSED
      try { return await guard(() => runtime.execute(name, args, context)) }
      catch (error) {
        if (error instanceof CutoverFenceError) return PAUSED
        throw error
      }
    },
  }
}

/**
 * Reuses the existing Worker memory row until the Stage 15 writer fence says
 * the canonical PostgreSQL authority is active for this verified account.
 */
export async function resolveWorkerMemoryForTurn(input: {
  env: Env
  owner: string
  channel: 'worker_http' | 'worker_websocket'
  legacyStore: MemoryStore
}): Promise<WorkerMemoryContext> {
  const { env, owner, channel, legacyStore } = input
  const authority = owner.startsWith('user/') ? 'worker_auth_session' : 'ephemeral_request'
  const legacySession = createServerMemorySession({ owner, store: legacyStore, channel, authority })
  const flags = flagsFor(env, owner)
  if (!anyMemoryFeatureEnabled(flags)) return { memoryStore: legacyStore, memorySession: legacySession, close: KEEP_OPEN }

  const connectionString = env.HYPERDRIVE?.connectionString
  if (!connectionString) {
    return {
      memoryStore: legacyStore,
      memorySession: legacySession,
      memoryRuntime: { flags, retrieve: async () => ({ status: 'unavailable', reason: 'not_configured' }), execute: async () => unavailableOutcome() },
      close: KEEP_OPEN,
    }
  }

  const { store, close } = createStore(connectionString)
  const canonicalSession = createServerMemorySession({ owner, store, channel, authority: 'worker_auth_session' })
  const fencedSession = createServerMemorySession({
    owner,
    store: new FencedLegacyStore(legacyStore, canonicalSession),
    channel,
    authority: 'worker_auth_session',
  })

  try {
    let { state } = await readAuthority(store, canonicalSession.scope.id)
    if (state === 'legacy' && env.GIDEON_MEMORY_CUTOVER_ENABLED === '1') {
      const source = await legacySource(connectionString, owner)
      const parsed = parseLegacyMemories(await source.read())
      // Empty owners can move safely on first use. Accounts with saved legacy
      // memories remain on that writer until an operator runs the cutover.
      if (!parsed.valid.length && !parsed.quarantined.length) {
        const report = await cutoverScope(canonicalSession, source)
        if (report.outcome === 'activated' || report.outcome === 'already_active') state = 'active'
      }
    }
    if (state === 'active') {
      return {
        memoryStore: fencedSession.store,
        memorySession: fencedSession,
        memoryRuntime: guardedRuntime(createRuntime(canonicalSession, flags, memoryRetrievalOptions({ ...input.env })), store, canonicalSession.scope.id),
        controlSession: canonicalSession,
        close,
      }
    }
    if (state === 'fenced') return { memoryStore: fencedSession.store, memorySession: fencedSession, memoryRuntime: pausedRuntime(flags), close }
    if (env.GIDEON_MEMORY_CANONICAL_ONLY === '1') return { memoryStore:fencedSession.store,memorySession:fencedSession,memoryRuntime:pausedRuntime(flags),close }
    return { memoryStore: fencedSession.store, memorySession: fencedSession, close }
  } catch {
    return { memoryStore: fencedSession.store, memorySession: fencedSession, memoryRuntime: pausedRuntime(flags), close }
  }
}

/** How long a connection trusts that its owner is still on the canonical authority before looking again. */
const AUTHORITY_FRESH_MS = 30_000
/** A lookup reads on about this many connections at once; warming opens them before it needs them. */
const WARM_CONNECTIONS = 6
const WARM_EVERY_MS = 5_000

export interface ConnectionMemory {
  /** The memory for one turn. `close` hands it back; the connection decides when it is really closed. */
  resolve(): Promise<WorkerMemoryContext>
  /** Starts resolving before the first turn asks, so that turn does not wait for it. */
  warm(): void
  close(): Promise<void>
}

/**
 * One connection's memory, resolved once and kept for the turns that follow.
 *
 * Every turn used to open a pool, ask which authority the owner was on, run,
 * and close the pool again: several connections and a round trip of setup in
 * front of each reply, to learn what the turn before had just learned. An
 * owner on the canonical authority keeps its runtime and its connections for
 * the life of the socket instead. The runtime still checks the authority beside
 * every read and under the writer lock for every write, so a cutover that
 * happens mid-connection is noticed by the turn it affects; this only saves
 * asking in advance. Any other state is resolved afresh each turn, as before.
 */
export function createConnectionMemory(input: Parameters<typeof resolveWorkerMemoryForTurn>[0]): ConnectionMemory {
  interface Held { context: WorkerMemoryContext; users: number; retired: boolean; checkedAt: number }
  let held: Held | null = null
  let pending: Promise<WorkerMemoryContext> | null = null
  let closed = false
  let warmedAt = 0

  const release = async (entry: Held) => {
    entry.users -= 1
    if (entry.retired && entry.users <= 0) await entry.context.close().catch(() => undefined)
  }
  const retire = (entry: Held) => {
    entry.retired = true
    if (held === entry) held = null
    if (entry.users <= 0) void entry.context.close().catch(() => undefined)
  }
  const lend = (entry: Held): WorkerMemoryContext => {
    entry.users += 1
    let returned = false
    const runtime = entry.context.memoryRuntime
    return {
      ...entry.context,
      // A lookup refused as stale means the owner has left the canonical
      // authority, so the next turn asks afresh which one it is on. A lookup
      // that merely failed or ran out of time keeps its connections: the pool
      // already discards a broken one, and reopening them all in front of the
      // next reply would make a slow database slower.
      ...(runtime ? {
        memoryRuntime: {
          ...runtime,
          async retrieve(query, context, signal) {
            const result = await runtime.retrieve(query, context, signal)
            if (result.status === 'unavailable' && result.reason === 'stale' && !signal.aborted) retire(entry)
            return result
          },
        },
      } : {}),
      async close() {
        if (returned) return
        returned = true
        await release(entry)
      },
    }
  }
  const recheck = (entry: Held) => {
    entry.checkedAt = Date.now()
    const session = entry.context.controlSession
    if (!session) return
    void readAuthority(session.store, session.scope.id).then(
      ({ state }) => { if (state !== 'active') retire(entry) },
      () => retire(entry),
    )
  }

  const resolve = async (): Promise<WorkerMemoryContext> => {
    if (held && !held.retired) {
      if (Date.now() - held.checkedAt > AUTHORITY_FRESH_MS) recheck(held)
      return lend(held)
    }
    pending ??= resolveWorkerMemoryForTurn(input).finally(() => { pending = null })
    const context = await pending
    // Only the canonical authority's runtime is worth keeping; `controlSession`
    // is what marks it. Anything else belongs to this turn alone.
    if (!context.controlSession) return context
    if (closed) return context
    if (!held || held.retired) held = { context, users: 0, retired: false, checkedAt: Date.now() }
    // Two turns that resolved together share the first one's context.
    else if (held.context !== context) void context.close().catch(() => undefined)
    return lend(held)
  }

  return {
    resolve,
    warm() {
      // Called when the socket opens and again whenever speech arrives, which
      // is a moment before the turn that will want these connections.
      if (closed || Date.now() - warmedAt < WARM_EVERY_MS) return
      warmedAt = Date.now()
      void resolve().then(async (context) => {
        try {
          const pool = context.controlSession?.store.pool
          if (pool) await Promise.all(Array.from({ length: WARM_CONNECTIONS }, () => pool.query('SELECT 1').catch(() => undefined)))
        } finally {
          await context.close()
        }
      }, () => undefined)
    },
    async close() {
      closed = true
      if (held) retire(held)
    },
  }
}
