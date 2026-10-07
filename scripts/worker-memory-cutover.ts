import { Client, Pool } from 'pg'
import { createServerMemorySession } from '../src/server/memory-session.ts'
import { cutoverScope, type LegacySource } from '../backend/memory/src/cutover.ts'
import { PostgresMemoryStore } from '../backend/memory/src/postgres.ts'
import { assertMigrationPermission, workerMigrationStatus } from './worker-db.ts'

function connectionString(): string {
  const value = process.env.GIDEON_DATABASE_URL?.trim()
  if (!value) throw new Error('Set GIDEON_DATABASE_URL to the direct PostgreSQL connection string.')
  const url = new URL(value)
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('GIDEON_DATABASE_URL must be a PostgreSQL URL.')
  return url.toString()
}

function legacySource(databaseUrl: string, owner: string): LegacySource {
  return {
    async read() {
      const client = new Client({ connectionString: databaseUrl, application_name: 'chat-gideon-worker-memory-cutover-read' })
      client.on('error', () => undefined)
      await client.connect()
      try {
        const result = await client.query('SELECT memories FROM public.gideon_memories WHERE session_id = $1', [owner])
        if (result.rows.length > 1) throw new Error('Legacy memory owner is not unique')
        return result.rows.length ? (result.rows[0] as { memories: unknown }).memories : null
      } finally {
        await client.end().catch(() => undefined)
      }
    },
    async write(memories) {
      const client = new Client({ connectionString: databaseUrl, application_name: 'chat-gideon-worker-memory-cutover-write' })
      client.on('error', () => undefined)
      await client.connect()
      try {
        await client.query('UPDATE public.gideon_memories SET memories = $2::jsonb WHERE session_id = $1', [owner, JSON.stringify(memories)])
      } finally {
        await client.end().catch(() => undefined)
      }
    },
  }
}

async function main(command: string) {
  if (command !== 'status' && command !== 'cutover') throw new Error('Use status or cutover.')
  if (command === 'cutover') {
    assertMigrationPermission(process.env)
    if (process.env.GIDEON_MEMORY_CUTOVER_WRITES_QUIESCED !== '1') {
      throw new Error('Cutover requires GIDEON_MEMORY_CUTOVER_WRITES_QUIESCED=1 after the old Worker version and other legacy writers have drained.')
    }
  }

  const url = new URL(connectionString())
  const pool = new Pool({ connectionString: url.toString(), max: 4, application_name: 'chat-gideon-worker-memory-cutover' })
  pool.on('error', () => undefined)
  try {
    const migrations = await workerMigrationStatus(pool)
    if (migrations.pending.length) throw new Error(`Database migrations are pending: ${migrations.pending.join(', ')}`)
    const owners = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM public.gideon_memories WHERE session_id LIKE 'user/%' ORDER BY session_id`,
    )
    if (command === 'status') {
      const state = await pool.query<{ state: string; count: string }>(
        `SELECT coalesce(c.state, 'legacy') AS state, count(*)::text AS count
         FROM public.gideon_memories m
         LEFT JOIN gideon_memory.authority_cutovers c ON c.scope_id = m.session_id
         WHERE m.session_id LIKE 'user/%'
         GROUP BY coalesce(c.state, 'legacy') ORDER BY state`,
      )
      console.log(JSON.stringify({ operation: command, host: url.hostname, verifiedAccountRows: owners.rowCount ?? owners.rows.length, states: state.rows }, null, 2))
      return
    }

    const counts = { checked: 0, activated: 0, already_active: 0, aborted: 0 }
    const reasons: Record<string, number> = {}
    const store = new PostgresMemoryStore(pool)
    for (const { session_id: owner } of owners.rows) {
      counts.checked += 1
      const session = createServerMemorySession({ owner, store, channel: 'http', authority: 'worker_auth_session' })
      const report = await cutoverScope(session, legacySource(url.toString(), owner))
      counts[report.outcome] += 1
      if (report.reason) reasons[report.reason] = (reasons[report.reason] ?? 0) + 1
    }
    console.log(JSON.stringify({ operation: command, host: url.hostname, ...counts, reasons }, null, 2))
    if (counts.aborted) process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main(process.argv[2] ?? 'status').catch((error: Error) => {
  console.error(error.message)
  process.exitCode = 1
})
