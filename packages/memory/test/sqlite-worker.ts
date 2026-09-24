/** One OS process in the SQLite multi-writer test; prints one JSON line per attempt. */
import { MemoryError } from '../src/contract.ts'
import { openMemory } from '../src/core.ts'
import { SqliteMemoryBackend } from '../src/sqlite.ts'

const plan = JSON.parse(process.env.WORKER_PLAN ?? '{}') as { path: string; worker: number; shared: string; writes: number }
const backend = new SqliteMemoryBackend({ path: plan.path, busyTimeoutMs: 20_000 })
const memory = openMemory({ backend, scopeId: 'multi', principalId: 'multi' })
const emit = (record: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(record)}\n`)

for (let index = 0; index < plan.writes; index += 1) {
  const text = `Worker ${plan.worker} note ${index}`
  try {
    const saved = await memory.remember({ commandId: `w${plan.worker}-n${index}`, text })
    emit({ kind: 'remember', ok: true, id: saved.item.id, text })
  } catch (error) {
    emit({ kind: 'remember', ok: false, code: error instanceof MemoryError ? error.code : 'thrown' })
  }
  const current = await memory.get(plan.shared)
  const value = `Shared value w${plan.worker} a${index}`
  try {
    const fixed = await memory.correct({ commandId: `w${plan.worker}-c${index}`, id: plan.shared, expectedRevision: current!.revision, text: value })
    emit({ kind: 'correct', ok: true, revision: fixed.item.revision, text: value })
  } catch (error) {
    emit({ kind: 'correct', ok: false, code: error instanceof MemoryError ? error.code : 'thrown' })
  }
}
await backend.close()
