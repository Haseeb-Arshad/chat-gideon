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
    GIDEON_MEMORY_ROLLOUT_PERCENT: env.GIDEON_MEMORY_ROLLOUT_PERCENT,
    GIDEON_MEMORY_CAPTURE_ENABLED: env.GIDEON_MEMORY_CAPTURE_ENABLED,
    GIDEON_MEMORY_COMMAND_WRITES_ENABLED: env.GIDEON_MEMORY_COMMAND_WRITES_ENABLED,
    GIDEON_MEMORY_RECALL_ENABLED: env.GIDEON_MEMORY_RECALL_ENABLED,
  }, owner, owner.startsWith('user/'))
}

function createStore(connectionString: string): { store: PostgresMemoryStore; close(): Promise<void> } {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000,
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
    async captureUserTurn(context, signal) {
      try { return await guard(() => runtime.captureUserTurn!(context, signal)) }
      catch (error) {
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
        memoryRuntime: guardedRuntime(createRuntime(canonicalSession, flags), store, canonicalSession.scope.id),
        controlSession: canonicalSession,
        close,
      }
    }
    if (state === 'fenced') return { memoryStore: fencedSession.store, memorySession: fencedSession, memoryRuntime: pausedRuntime(flags), close }
    return { memoryStore: fencedSession.store, memorySession: fencedSession, close }
  } catch {
    return { memoryStore: fencedSession.store, memorySession: fencedSession, memoryRuntime: pausedRuntime(flags), close }
  }
}
