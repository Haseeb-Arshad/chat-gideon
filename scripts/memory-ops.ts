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
 */
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { memoryPostgresConfig } from '../backend/memory/src/config.ts'
import { markRestorePending, reconcileRestoreLedger } from '../backend/memory/src/deletion.ts'
import { checkMemoryReadiness } from '../backend/memory/src/health.ts'
import { collectMemoryMetrics, evaluateMemoryAlerts, exportControlLedger, importControlLedger } from '../backend/memory/src/operations.ts'
import { PostgresMemoryStore } from '../backend/memory/src/postgres.ts'

const [command = 'metrics', argument] = process.argv.slice(2)
const pool = new Pool(memoryPostgresConfig())
const store = new PostgresMemoryStore(pool)
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))

try {
  if (command === 'metrics') {
    const metrics = await collectMemoryMetrics(pool)
    const alerts = evaluateMemoryAlerts(metrics)
    print({ metrics, alerts })
    if (alerts.some((alert) => alert.severity === 'critical')) process.exitCode = 2
  } else if (command === 'readiness') {
    const readiness = await checkMemoryReadiness(pool)
    print(readiness)
    if (readiness.status !== 'ok') process.exitCode = 1
  } else if (command === 'ledger-export') {
    const after = argument ? JSON.parse(readFileSync(argument, 'utf8')) as Record<string, number> : {}
    print(await exportControlLedger(store, { after }))
  } else if (command === 'restore-replay') {
    if (process.env.GIDEON_MEMORY_RESTORE !== '1') throw new Error('restore-replay changes the database; set GIDEON_MEMORY_RESTORE=1.')
    if (!argument) throw new Error('Give the shipped ledger file.')
    const imported = await importControlLedger(store, JSON.parse(readFileSync(argument, 'utf8')))
    const replayed = []
    for (const [scopeId, requiredLedgerSequence] of Object.entries(imported.requiredBySequence)) {
      await markRestorePending(store, scopeId as never, { requiredLedgerSequence })
      replayed.push(await reconcileRestoreLedger(store, scopeId as never))
    }
    print({ imported: { inserted: imported.inserted, alreadyPresent: imported.alreadyPresent, skippedUnknownScopes: imported.skippedUnknownScopes }, scopesReplayed: replayed.length, readiness: await checkMemoryReadiness(pool) })
  } else {
    throw new Error('Use metrics, readiness, ledger-export or restore-replay.')
  }
} finally {
  await store.close()
}
