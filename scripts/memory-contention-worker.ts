/**
 * One OS process in the Stage 14 multi-process contention test
 * (backend/memory/src/operational.live.test.ts). Run with jiti; the parent
 * passes its plan in MEMORY_CONTENTION_PLAN and reads one JSON line per
 * attempt from stdout. It never prints memory text beyond the synthetic
 * values it was told to write.
 */
import { Pool } from 'pg'
import { executeExplicitCommand, readCurrentAssertion } from '../backend/memory/src/commands.ts'
import { PostgresMemoryStore } from '../backend/memory/src/postgres.ts'
import { EphemeralMemoryStore } from '../src/lib/tools/memory'
import { createServerMemorySession } from '../src/server/memory-session'

interface Plan { databaseUrl: string; owner: string; worker: number; targets: string[]; corrections: number; duplicateText: string; startAt: number }

const plan = JSON.parse(process.env.MEMORY_CONTENTION_PLAN ?? '{}') as Plan
const pool = new Pool({ connectionString: plan.databaseUrl, max: 2, application_name: `contention-${plan.worker}` })
const store = new PostgresMemoryStore(pool)
const session = { ...createServerMemorySession({ owner: plan.owner, store: new EphemeralMemoryStore(), channel: 'test', authority: 'worker_auth_session' }), store }
const emit = (record: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ worker: plan.worker, ...record })}\n`)

try {
  // Line up with the other processes so the writes really overlap.
  while (Date.now() < plan.startAt) await new Promise((resolve) => setTimeout(resolve, 2))

  // First-slot race: every process remembers the same new sentence at once.
  const duplicate = await executeExplicitCommand(session, { schemaVersion: 1, commandId: `command/contention/dup/${plan.worker}`, kind: 'remember', text: plan.duplicateText, assertionKind: 'fact', conditions: [] })
  emit({ kind: 'remember', ok: duplicate.ok, outcome: duplicate.ok ? duplicate.outcome : null, assertionId: duplicate.ok ? duplicate.assertion.id : null, failure: duplicate.ok ? null : duplicate.failure.code })

  for (let attempt = 0; attempt < plan.corrections; attempt += 1) {
    const target = plan.targets[(attempt + plan.worker) % plan.targets.length]!
    const current = await readCurrentAssertion(session, target as never)
    if (!current.version) { emit({ kind: 'correct', ok: false, failure: 'unreadable', target }); continue }
    const text = `Value w${plan.worker} a${attempt}`
    const result = await executeExplicitCommand(session, {
      schemaVersion: 1, commandId: `command/contention/${plan.worker}/${attempt}`, kind: 'correct',
      targetAssertionId: target, targetRevision: current.version.revision, text, assertionKind: 'fact', conditions: [],
    })
    emit({ kind: 'correct', ok: result.ok, target, text, expectedRevision: current.version.revision, revision: result.ok ? result.assertion.revision : null, failure: result.ok ? null : result.failure.code })
  }
} finally {
  await store.close()
}
