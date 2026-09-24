import type { Pool } from 'pg'
import { expect, it } from 'vitest'
import { PostgresMemoryStore, isPostgresMemoryStore } from './postgres.ts'

it('recognises the store across bundle copies of the class, which instanceof cannot', () => {
  const store = new PostgresMemoryStore({} as Pool)
  expect(isPostgresMemoryStore(store)).toBe(true)
  expect(isPostgresMemoryStore(store.forContext({ principalId: 'user/a' as never, scopeId: 'user/a' as never, policyEpoch: 1 }))).toBe(true)
  // What the realtime bundle's copy of the class produces: same brand, different prototype.
  const foreign: object = Object.create({ [Symbol.for('gideon.memory.postgres-store.v1')]: true })
  expect(foreign instanceof PostgresMemoryStore).toBe(false)
  expect(isPostgresMemoryStore(foreign)).toBe(true)
  expect(isPostgresMemoryStore({})).toBe(false)
  expect(isPostgresMemoryStore(null)).toBe(false)
})
