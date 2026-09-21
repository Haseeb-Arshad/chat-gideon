import { Pool } from 'pg'
import { assertExplicitMigrationPermission, memoryPostgresConfig } from '../backend/memory/src/config.ts'
import { applyMigrations, migrationStatus } from '../backend/memory/src/migrations.ts'
import { checkMemoryHealth } from '../backend/memory/src/health.ts'

const command = process.argv[2] ?? 'status'
const pool = new Pool(memoryPostgresConfig())

try {
  if (command === 'migrate') {
    assertExplicitMigrationPermission()
    const status = await applyMigrations(pool)
    console.log(JSON.stringify({ ...status, operation: 'migrate' }, null, 2))
  } else if (command === 'status') {
    const health = await checkMemoryHealth(pool)
    const status = health.status === 'ok' ? await migrationStatus(pool) : null
    console.log(JSON.stringify({ health, status, operation: 'status' }, null, 2))
  } else {
    throw new Error('Use status or migrate.')
  }
} finally {
  await pool.end()
}
