import { Pool } from 'pg'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { applyMigrations } from '../../../backend/memory/src/migrations.ts'
import { PostgresMemoryStore } from '../../../backend/memory/src/postgres.ts'
import { PostgresMemoryBackend } from '../src/postgres.ts'
import { backendConformance } from './conformance.ts'

/**
 * The same conformance suite against the PostgreSQL backend, through the
 * disposable harness:
 *   node scripts/memory-postgres-harness.mjs packages/memory/test/postgres.live.test.ts
 */

const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)
const run = Date.now().toString(36)
let backend: PostgresMemoryBackend
let scopes = 0

beforeAll(async () => {
  if (!enabled) return
  if (process.env.MEMORY_TEST_DATABASE_OWNED !== '1') throw new Error('Requires an owned disposable database.')
  const pool = new Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL, max: 8 })
  await pool.query('DROP SCHEMA IF EXISTS gideon_memory CASCADE')
  await applyMigrations(pool)
  backend = new PostgresMemoryBackend(new PostgresMemoryStore(pool))
})

afterAll(async () => {
  if (enabled) await backend.close()
})

if (enabled) {
  backendConformance('PostgreSQL', () => ({ backend, freshScope: () => `user/portable-${run}-${(scopes += 1)}`, distinctPrincipals: false }))
} else {
  describe.skip('PostgreSQL backend conformance', () => {
    it('needs the disposable database harness', () => undefined)
  })
}
