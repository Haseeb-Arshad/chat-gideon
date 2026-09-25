import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

/**
 * Migrations for the Worker's PostgreSQL database (Supabase): accounts and
 * account memory. They run from a trusted machine over a direct connection,
 * never through Hyperdrive and never from the Worker itself.
 *
 *   GIDEON_DATABASE_URL=… npm run db:status
 *   GIDEON_DATABASE_URL=… GIDEON_DATABASE_MIGRATE=1 GIDEON_DATABASE_ALLOW_REMOTE=1 npm run db:migrate
 *
 * Each file runs once, in its own transaction, and is recorded with a
 * checksum; a recorded file that has since changed stops the run.
 */

export const WORKER_MIGRATIONS = resolve(fileURLToPath(new URL('..', import.meta.url)), 'backend/worker/supabase/migrations')

const TABLE = 'public.gideon_worker_migrations'

export interface WorkerMigrationStatus { applied: string[]; pending: string[] }

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

function files(directory: string): { name: string; sql: string; checksum: string }[] {
  return readdirSync(directory)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(directory, name), 'utf8')
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') }
    })
}

export async function workerMigrationStatus(client: Queryable, directory = WORKER_MIGRATIONS): Promise<WorkerMigrationStatus> {
  const exists = await client.query('SELECT to_regclass($1) AS name', [TABLE])
  const recorded = exists.rows[0]?.name ? (await client.query(`SELECT name FROM ${TABLE} ORDER BY name`)).rows.map((row) => String(row.name)) : []
  const known = new Set(recorded)
  return { applied: recorded, pending: files(directory).map((file) => file.name).filter((name) => !known.has(name)) }
}

export async function applyWorkerMigrations(client: Queryable, directory = WORKER_MIGRATIONS): Promise<WorkerMigrationStatus> {
  await client.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`)
  for (const file of files(directory)) {
    await client.query('BEGIN')
    try {
      // Two runners at once: the second waits here and then sees the file recorded.
      await client.query(`LOCK TABLE ${TABLE} IN EXCLUSIVE MODE`)
      const found = await client.query(`SELECT checksum FROM ${TABLE} WHERE name = $1`, [file.name])
      const checksum = found.rows[0]?.checksum
      if (checksum === undefined) {
        await client.query(file.sql)
        await client.query(`INSERT INTO ${TABLE} (name, checksum) VALUES ($1, $2)`, [file.name, file.checksum])
      } else if (checksum !== file.checksum) {
        throw new Error(`${file.name} changed after it was applied; add a new migration instead.`)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  }
  return workerMigrationStatus(client, directory)
}

function databaseUrl(env: NodeJS.ProcessEnv): URL {
  const value = env.GIDEON_DATABASE_URL?.trim()
  if (!value) throw new Error('Set GIDEON_DATABASE_URL to the direct PostgreSQL connection string (not the Hyperdrive one).')
  const url = new URL(value)
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('GIDEON_DATABASE_URL must be a PostgreSQL URL.')
  return url
}

export function assertMigrationPermission(env: NodeJS.ProcessEnv): void {
  if (env.GIDEON_DATABASE_MIGRATE !== '1') throw new Error('Migrations require GIDEON_DATABASE_MIGRATE=1.')
  const host = databaseUrl(env).hostname.toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (!local && env.GIDEON_DATABASE_ALLOW_REMOTE !== '1') throw new Error('Remote migrations require GIDEON_DATABASE_ALLOW_REMOTE=1.')
}

async function main(command: string): Promise<void> {
  if (command !== 'status' && command !== 'migrate') throw new Error('Use status or migrate.')
  if (command === 'migrate') assertMigrationPermission(process.env)
  const url = databaseUrl(process.env)
  const client = new pg.Client({ connectionString: url.toString(), application_name: 'chat-gideon-migrate' })
  await client.connect()
  try {
    const status = command === 'migrate' ? await applyWorkerMigrations(client) : await workerMigrationStatus(client)
    // Names only; never the connection string.
    console.log(JSON.stringify({ operation: command, host: url.hostname, ...status }, null, 2))
  } finally {
    await client.end()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? 'status').catch((error: Error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
