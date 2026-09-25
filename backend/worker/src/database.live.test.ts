import { getMigrations } from 'better-auth/db/migration'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Memory } from '../../../src/lib/tools/memory'
import { applyWorkerMigrations, workerMigrationStatus } from '../../../scripts/worker-db'
import { accountOptions, ownerOf } from './accounts'
import { handleApi } from './api'
import { hyperdriveClients, HyperdriveMemoryStore, type SqlClient } from './memory'
import type { Env } from './types'

/**
 * The Worker's database on real PostgreSQL, reached the way Hyperdrive hands
 * it over: a connection string, one short-lived client per operation.
 * Run with `node scripts/memory-postgres-harness.mjs backend/worker/src/database.live.test.ts`.
 */

const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)
const ORIGIN = 'http://localhost'
const connectionString = process.env.MEMORY_TEST_DATABASE_URL ?? ''

const cello: Memory = { id: 'memory-1', kind: 'fact', text: 'The user plays the cello.', createdAt: '2026-09-10T00:00:00.000Z', usedAt: '2026-09-10T00:00:00.000Z', uses: 1 }

describe.skipIf(!enabled)('Worker database on PostgreSQL', () => {
  const admin = new pg.Client({ connectionString })

  beforeAll(async () => { await admin.connect() })
  afterAll(async () => { await admin.end() })

  it('applies the migrations once, and refuses a recorded file that changed', async () => {
    const first = await applyWorkerMigrations(admin)
    expect(first).toEqual({ applied: ['001_gideon_memories.sql', '002_accounts.sql'], pending: [] })
    expect(await applyWorkerMigrations(admin)).toEqual(first)
    const recorded = (await admin.query(`SELECT checksum FROM public.gideon_worker_migrations WHERE name = '002_accounts.sql'`)).rows[0].checksum
    await admin.query(`UPDATE public.gideon_worker_migrations SET checksum = 'edited' WHERE name = '002_accounts.sql'`)
    await expect(applyWorkerMigrations(admin)).rejects.toThrow(/changed after it was applied/u)
    await admin.query(`UPDATE public.gideon_worker_migrations SET checksum = $1 WHERE name = '002_accounts.sql'`, [recorded])
    expect(await workerMigrationStatus(admin)).toEqual(first)
  })

  it('matches exactly what Better Auth expects, so no column it reads is missing', async () => {
    const pool = new pg.Pool({ connectionString, max: 1 })
    try {
      const plan = await getMigrations(accountOptions(pool, 'x'.repeat(40), ORIGIN))
      expect(plan.toBeCreated).toEqual([])
      expect(plan.toBeAdded).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('issues an anonymous account through Hyperdrive and recognises it on the next request', async () => {
    const env = { HYPERDRIVE: { connectionString }, BETTER_AUTH_SECRET: 'a-test-secret-that-is-long-enough-to-use' } as unknown as Env
    const response = await handleApi(new Request(`${ORIGIN}/api/account`, { method: 'POST', headers: { Origin: ORIGIN } }), env)
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ anonymous: true })
    const cookie = (response?.headers.getSetCookie() ?? []).map((value) => value.split(';')[0]).join('; ')

    const users = await admin.query(`SELECT id, "isAnonymous" FROM public."user"`)
    expect(users.rows).toHaveLength(1)
    expect(users.rows[0].isAnonymous).toBe(true)
    expect(await ownerOf(new Request(`${ORIGIN}/api/chat`, { method: 'POST', headers: { Cookie: cookie } }), env)).toBe(`user/${users.rows[0].id}`)

    // Every request's connection was closed: nothing is left idle on the server.
    const open = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle'`)
    expect(open.rows[0].n).toBe(0)
  })

  it('keeps account memory in the owner\'s row, and nobody else\'s', async () => {
    const connect = hyperdriveClients(connectionString)
    await new HyperdriveMemoryStore(connect, 'user/a').mutate((memories) => ({ memories: [...memories, cello], result: null }))

    expect(await new HyperdriveMemoryStore(connect, 'user/a').all()).toEqual([cello])
    expect(await new HyperdriveMemoryStore(connect, 'user/b').all()).toEqual([])
    const row = await admin.query(`SELECT jsonb_typeof(memories) AS type FROM public.gideon_memories WHERE session_id = 'user/a'`)
    expect(row.rows[0].type).toBe('array')

    await new HyperdriveMemoryStore(connect, 'user/a').mutate(() => ({ memories: [], result: null }))
    expect(await new HyperdriveMemoryStore(connect, 'user/a').all()).toEqual([])
  })

  it('reports a failed read instead of treating it as empty memory', async () => {
    const broken: () => Promise<SqlClient> = async () => ({ query: async () => { throw new Error('offline') }, end: async () => undefined })
    await expect(new HyperdriveMemoryStore(broken, 'user/a').all()).rejects.toThrow('offline')
  })
})
