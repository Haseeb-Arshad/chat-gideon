import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { MEMORY_SCHEMA } from './config.ts'

export const DEFAULT_MIGRATION_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '../migrations')

export interface MigrationStatus {
  schema: string
  applied: readonly string[]
  pending: readonly string[]
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS ${MEMORY_SCHEMA};
    CREATE TABLE IF NOT EXISTS ${MEMORY_SCHEMA}.schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

async function migrationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && /^\d{3}-.*\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

export async function migrationStatus(pool: Pool, directory = DEFAULT_MIGRATION_DIRECTORY): Promise<MigrationStatus> {
  const files = await migrationFiles(directory)
  const client = await pool.connect()
  try {
    const table = await client.query<{ exists: string | null }>(
      `SELECT to_regclass($1) AS exists`,
      [`${MEMORY_SCHEMA}.schema_migrations`],
    )
    if (!table.rows[0]?.exists) return { schema: MEMORY_SCHEMA, applied: [], pending: files }
    const result = await client.query<{ version: string }>(`SELECT version FROM ${MEMORY_SCHEMA}.schema_migrations ORDER BY version`)
    const applied = result.rows.map((row) => row.version)
    const appliedSet = new Set(applied)
    return { schema: MEMORY_SCHEMA, applied, pending: files.filter((file) => !appliedSet.has(file)) }
  } finally {
    client.release()
  }
}

export async function applyMigrations(pool: Pool, directory = DEFAULT_MIGRATION_DIRECTORY): Promise<MigrationStatus> {
  const files = await migrationFiles(directory)
  for (const file of files) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await ensureMigrationTable(client)
      const existing = await client.query<{ version: string }>(
        `SELECT version FROM ${MEMORY_SCHEMA}.schema_migrations WHERE version = $1`,
        [file],
      )
      if (existing.rowCount === 0) {
        const sql = await readFile(join(directory, file), 'utf8')
        await client.query(sql)
        await client.query(`INSERT INTO ${MEMORY_SCHEMA}.schema_migrations (version) VALUES ($1)`, [file])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  return migrationStatus(pool, directory)
}
