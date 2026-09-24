/**
 * Operator commands for the PostgreSQL memory authority. Uses
 * GIDEON_MEMORY_DATABASE_URL (see backend/memory/src/config.ts). Prints JSON
 * with counts and ids only, never memory text. See
 * docs/memory/operations/runbook.md.
 *
 *   npm run memory:ops -- metrics            counts, ages and alerts; exit 2 on a critical alert
 *   npm run memory:ops -- readiness          exit 1 unless ready (migrations applied, no restore block)
 *   npm run memory:ops -- ledger-export [watermarks.json]   ledger rows after the given per-scope watermarks
 *   GIDEON_MEMORY_RESTORE=1 npm run memory:ops -- restore-replay ledger.json
 *                                            after a restore: import, block, replay, reopen
 *   npm run memory:ops -- config-check       which settings are present (never their values)
 *   npm run memory:ops -- cutover-plan <legacy-dir> <environment>
 *                                            dry run: the migration manifest, no writes
 *   GIDEON_MEMORY_CUTOVER=1 npm run memory:ops -- cutover <manifest.json> [owner ...]
 *                                            move the owners in a reviewed manifest
 *   GIDEON_MEMORY_CUTOVER=1 npm run memory:ops -- rollback <legacy-dir> <owner>
 *                                            hand one owner back to its legacy file
 */
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { memoryPostgresConfig } from '../backend/memory/src/config.ts'
import { markRestorePending, reconcileRestoreLedger } from '../backend/memory/src/deletion.ts'
import { checkMemoryReadiness } from '../backend/memory/src/health.ts'
import { collectMemoryMetrics, evaluateMemoryAlerts, exportControlLedger, importControlLedger } from '../backend/memory/src/operations.ts'
import { PostgresMemoryStore } from '../backend/memory/src/postgres.ts'
import { closeWriterLocks } from '../backend/memory/src/cutover.ts'
import { executeLegacyMigration, memoryConfigCheck, planLegacyMigration, rollbackLegacyOwner, type MigrationManifest } from '../src/server/memory-migration.ts'

const [command = 'metrics', argument, ...rest] = process.argv.slice(2)
let opened: { pool: Pool; store: PostgresMemoryStore } | null = null
/** Only commands that touch the database open it. */
function database() {
  if (!opened) {
    const pool = new Pool(memoryPostgresConfig())
    opened = { pool, store: new PostgresMemoryStore(pool) }
  }
  return opened
}
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))
const requireCutoverPermission = () => {
  if (process.env.GIDEON_MEMORY_CUTOVER !== '1') throw new Error(`${command} changes which store holds memory; set GIDEON_MEMORY_CUTOVER=1.`)
}

try {
  if (command === 'metrics') {
    const { pool } = database()
    const metrics = await collectMemoryMetrics(pool)
    const alerts = evaluateMemoryAlerts(metrics)
    print({ metrics, alerts })
    if (alerts.some((alert) => alert.severity === 'critical')) process.exitCode = 2
  } else if (command === 'readiness') {
    const { pool } = database()
    const readiness = await checkMemoryReadiness(pool)
    print(readiness)
    if (readiness.status !== 'ok') process.exitCode = 1
  } else if (command === 'ledger-export') {
    const after = argument ? JSON.parse(readFileSync(argument, 'utf8')) as Record<string, number> : {}
    print(await exportControlLedger(database().store, { after }))
  } else if (command === 'restore-replay') {
    if (process.env.GIDEON_MEMORY_RESTORE !== '1') throw new Error('restore-replay changes the database; set GIDEON_MEMORY_RESTORE=1.')
    if (!argument) throw new Error('Give the shipped ledger file.')
    const { pool, store } = database()
    const imported = await importControlLedger(store, JSON.parse(readFileSync(argument, 'utf8')))
    const replayed = []
    for (const [scopeId, requiredLedgerSequence] of Object.entries(imported.requiredBySequence)) {
      await markRestorePending(store, scopeId as never, { requiredLedgerSequence })
      replayed.push(await reconcileRestoreLedger(store, scopeId as never))
    }
    print({ imported: { inserted: imported.inserted, alreadyPresent: imported.alreadyPresent, skippedUnknownScopes: imported.skippedUnknownScopes }, scopesReplayed: replayed.length, readiness: await checkMemoryReadiness(pool) })
  } else if (command === 'config-check') {
    print(memoryConfigCheck())
  } else if (command === 'cutover-plan') {
    if (!argument || !rest[0]) throw new Error('Give the legacy directory and an environment name.')
    print(await planLegacyMigration({ directory: argument, environment: rest[0] }))
  } else if (command === 'cutover') {
    requireCutoverPermission()
    if (!argument) throw new Error('Give the reviewed manifest file.')
    const manifest = JSON.parse(readFileSync(argument, 'utf8')) as MigrationManifest
    const results = await executeLegacyMigration(manifest, database().store, { owners: rest.length ? rest : undefined })
    print({ environment: manifest.environment, results })
    if (results.some((result) => result.outcome !== 'activated' && result.outcome !== 'already_active')) process.exitCode = 1
  } else if (command === 'rollback') {
    requireCutoverPermission()
    if (!argument || !rest[0]) throw new Error('Give the legacy directory and the owner.')
    print(await rollbackLegacyOwner(rest[0], database().store, argument))
  } else {
    throw new Error('Use metrics, readiness, ledger-export, restore-replay, config-check, cutover-plan, cutover or rollback.')
  }
} finally {
  const open = opened as { pool: Pool; store: PostgresMemoryStore } | null
  if (open) {
    await closeWriterLocks(open.store)
    await open.store.close()
  }
}
