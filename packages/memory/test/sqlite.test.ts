import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openMemory } from '../src/core.ts'
import { SqliteMemoryBackend } from '../src/sqlite.ts'
import { backendConformance } from './conformance.ts'

const directory = mkdtempSync(join(tmpdir(), 'gideon-memory-sqlite-'))
const backend = new SqliteMemoryBackend({ path: join(directory, 'memory.db') })
let scopes = 0

afterAll(async () => {
  await backend.close()
  rmSync(directory, { recursive: true, force: true })
})

backendConformance('SQLite', () => ({ backend, freshScope: () => `sqlite-scope-${(scopes += 1)}`, distinctPrincipals: true }))

describe('SQLite backend specifics', () => {
  it('survives a restart: a new process-level handle reads what the old one wrote', async () => {
    const path = join(directory, 'restart.db')
    const first = new SqliteMemoryBackend({ path })
    const saved = await openMemory({ backend: first, scopeId: 'restart', principalId: 'restart' }).remember({ commandId: 'restart-1', text: 'Written before the restart' })
    await first.close()
    const second = new SqliteMemoryBackend({ path })
    expect(await openMemory({ backend: second, scopeId: 'restart', principalId: 'restart' }).get(saved.item.id)).toMatchObject({ text: 'Written before the restart' })
    await second.close()
  })

  it('creates the database file owner-only where the platform has POSIX permissions', () => {
    const mode = statSync(join(directory, 'memory.db')).mode & 0o777
    if (process.platform === 'win32') expect(mode).toBeGreaterThan(0)
    else expect(mode & 0o077).toBe(0)
  })

  it('C33: at the item quota, remember says so and saves nothing', async () => {
    const small = new SqliteMemoryBackend({ path: ':memory:', maxItemsPerScope: 2 })
    const memory = openMemory({ backend: small, scopeId: 'quota', principalId: 'quota' })
    await memory.remember({ commandId: 'q1', text: 'First' })
    await memory.remember({ commandId: 'q2', text: 'Second' })
    await expect(memory.remember({ commandId: 'q3', text: 'Third' })).rejects.toMatchObject({ code: 'quota' })
    expect((await memory.list()).items).toHaveLength(2)
    await small.close()
  })

  it('C25: a closed store fails loudly instead of answering "nothing remembered"', async () => {
    const closing = new SqliteMemoryBackend({ path: ':memory:' })
    const memory = openMemory({ backend: closing, scopeId: 'closed', principalId: 'closed' })
    await closing.close()
    await expect(memory.list()).rejects.toThrow()
  })

  it('refuses a database written by another stored-schema version', async () => {
    const path = join(directory, 'future.db')
    const created = new SqliteMemoryBackend({ path })
    await created.close()
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run()
    raw.close()
    expect(() => new SqliteMemoryBackend({ path })).toThrow(/stored schema 99/u)
  })

  it('four OS processes writing and correcting one database lose no acknowledged write (database locking, not a Promise queue)', async () => {
    const path = join(directory, 'multi.db')
    const setup = new SqliteMemoryBackend({ path })
    const shared = await openMemory({ backend: setup, scopeId: 'multi', principalId: 'multi' }).remember({ commandId: 'shared', text: 'Shared value 0' })
    await setup.close()
    const root = resolve(import.meta.dirname, '../../..')
    const jiti = resolve(root, 'node_modules/jiti/lib/jiti-cli.mjs')
    const outputs = await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, ['--no-warnings', jiti, resolve(import.meta.dirname, 'sqlite-worker.ts')], {
        env: { ...process.env, WORKER_PLAN: JSON.stringify({ path, worker, shared: shared.item.id, writes: 15 }) },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.stderr.on('data', (chunk) => { err += chunk })
      child.on('exit', (code) => (code === 0 ? done(out) : fail(new Error(`worker ${worker}: ${err.slice(0, 300)}`))))
    })))
    const records = outputs.flatMap((out) => out.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as { kind: string; ok: boolean; id?: string; text?: string; revision?: number; code?: string }))
    const check = new SqliteMemoryBackend({ path })
    const memory = openMemory({ backend: check, scopeId: 'multi', principalId: 'multi' })
    // Every acknowledged remember is there.
    for (const record of records.filter((item) => item.kind === 'remember' && item.ok)) expect((await memory.get(record.id!))?.text).toBe(record.text)
    expect(records.filter((item) => item.kind === 'remember' && !item.ok)).toEqual([])
    // Corrections of the shared memory: gapless revisions, each acknowledged one stored exactly.
    const corrections = records.filter((item) => item.kind === 'correct')
    expect(corrections.filter((item) => !item.ok).every((item) => item.code === 'conflict')).toBe(true)
    const history = await memory.history(shared.item.id)
    expect(history.map((revision) => revision.revision)).toEqual(history.map((_, index) => index + 1))
    for (const record of corrections.filter((item) => item.ok)) expect(history.find((revision) => revision.revision === record.revision)?.text).toBe(record.text)
    expect(corrections.filter((item) => item.ok)).toHaveLength(history.length - 1)
    await check.close()
  }, 120_000)
})
