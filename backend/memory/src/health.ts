import type { Pool } from 'pg'
import { MEMORY_SCHEMA } from './config.ts'
import { migrationStatus } from './migrations.ts'

export interface MemoryHealth {
  service: 'memory-postgres'
  status: 'ok' | 'unavailable'
  checkedAt: string
  latencyMs: number | null
  schema: string | null
  pendingMigrations: number | null
}

export async function checkMemoryHealth(pool: Pool): Promise<MemoryHealth> {
  const started = performance.now()
  const checkedAt = new Date().toISOString()
  try {
    await pool.query('SELECT 1')
    const status = await migrationStatus(pool)
    return {
      service: 'memory-postgres',
      status: 'ok',
      checkedAt,
      latencyMs: Number((performance.now() - started).toFixed(3)),
      schema: status.schema,
      pendingMigrations: status.pending.length,
    }
  } catch {
    return {
      service: 'memory-postgres',
      status: 'unavailable',
      checkedAt,
      latencyMs: Number((performance.now() - started).toFixed(3)),
      schema: null,
      pendingMigrations: null,
    }
  }
}

export async function checkMemoryReadiness(pool: Pool): Promise<MemoryHealth> {
  const health = await checkMemoryHealth(pool)
  if (health.status === 'unavailable' || health.pendingMigrations !== 0) return { ...health, status: 'unavailable' }
  try {
    const guard = await pool.query<{ status: string; required_ledger_sequence: string; reconciled_ledger_sequence: string }>(
      `SELECT status, required_ledger_sequence, reconciled_ledger_sequence
       FROM ${MEMORY_SCHEMA}.recovery_guards
       WHERE status = 'blocked' OR reconciled_ledger_sequence < required_ledger_sequence
       LIMIT 1`,
    )
    if (guard.rows[0]) return { ...health, status: 'unavailable' }
  } catch {
    return { ...health, status: 'unavailable' }
  }
  return health
}
