import { describe, expect, it } from 'vitest'
import { MemoryError, type MemoryBackend } from '../src/contract.ts'
import { openMemory, type ScopedMemory } from '../src/core.ts'

/**
 * One behavioural contract, run unchanged against every backend. Seed cases
 * are named in the test titles (see docs/memory/handoffs/16-independent-framework.md).
 */

export interface ConformanceTarget {
  backend: MemoryBackend
  /** A fresh, unused scope id (principal = scope for backends that require it). */
  freshScope(): string
  /** Backend-specific: does the backend support a scope whose principal differs from its id? */
  distinctPrincipals: boolean
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    if (error instanceof MemoryError) return error.code
    throw error
  }
}

export function backendConformance(name: string, target: () => ConformanceTarget) {
  describe(`${name} backend conformance`, () => {
    const open = (scopeId?: string) => {
      const { backend, freshScope } = target()
      const id = scopeId ?? freshScope()
      return openMemory({ backend, scopeId: id, principalId: id })
    }
    let counter = 0
    const cmd = (label: string) => `cmd-${label}-${Date.now()}-${(counter += 1)}`

    it('remembers, reads back, lists and finds an explicit memory without any model', async () => {
      const memory = open()
      const saved = await memory.remember({ commandId: cmd('r'), text: 'My sister Hira was born on November 3', kind: 'fact' })
      expect(saved.outcome).toBe('created')
      expect(await memory.get(saved.item.id)).toMatchObject({ text: 'My sister Hira was born on November 3', revision: 1, kind: 'fact', basis: 'explicit' })
      expect((await memory.list()).items.map((item) => item.id)).toEqual([saved.item.id])
      expect((await memory.search('when was my sister born?')).map((item) => item.id)).toContain(saved.item.id)
      expect(await memory.search('passport number')).toEqual([])
    })

    it('C21: a repeated command replays; the same id with other content is a conflict; the same text is a duplicate', async () => {
      const memory = open()
      const id = cmd('idem')
      const first = await memory.remember({ commandId: id, text: 'I prefer aisle seats', kind: 'preference' })
      const again = await memory.remember({ commandId: id, text: 'I prefer aisle seats', kind: 'preference' })
      expect(again).toMatchObject({ outcome: 'replayed', item: { id: first.item.id } })
      expect(await code(memory.remember({ commandId: id, text: 'I prefer window seats', kind: 'preference' }))).toBe('conflict')
      const duplicate = await memory.remember({ commandId: cmd('dup'), text: '  I prefer   aisle seats ', kind: 'preference' })
      expect(duplicate).toMatchObject({ outcome: 'duplicate', item: { id: first.item.id } })
      expect((await memory.list()).items).toHaveLength(1)
    })

    it('C05: a mistake correction replaces the value at every point in time', async () => {
      const memory = open()
      const saved = await memory.remember({ commandId: cmd('c05'), text: 'My name is spelled Ali', validFrom: '2020-01-01T00:00:00.000Z' })
      const fixed = await memory.correct({ commandId: cmd('c05-fix'), id: saved.item.id, expectedRevision: 1, text: 'My name is spelled Aly', change: 'mistake' })
      expect(fixed.item).toMatchObject({ revision: 2, text: 'My name is spelled Aly', basis: 'correction' })
      expect((await memory.getAt(saved.item.id, '2021-06-01T00:00:00.000Z'))?.text).toBe('My name is spelled Aly')
      const history = await memory.history(saved.item.id)
      expect(history.map((revision) => [revision.revision, revision.supersededAsMistake])).toEqual([[1, true], [2, false]])
    })

    it('C04: a real change keeps the old value for the time it was true', async () => {
      const memory = open()
      const saved = await memory.remember({ commandId: cmd('c04'), text: 'I work at Meridian Logistics', validFrom: '2024-01-01T00:00:00.000Z' })
      await memory.correct({ commandId: cmd('c04-change'), id: saved.item.id, expectedRevision: 1, text: 'I work at Solace Health', change: 'changed', since: '2026-09-05T00:00:00.000Z' })
      expect((await memory.get(saved.item.id))?.text).toBe('I work at Solace Health')
      expect((await memory.getAt(saved.item.id, '2026-08-01T00:00:00.000Z'))?.text).toBe('I work at Meridian Logistics')
      expect((await memory.getAt(saved.item.id, '2026-09-10T00:00:00.000Z'))?.text).toBe('I work at Solace Health')
    })

    it('C19/C20: a stale revision is refused, and of two concurrent edits exactly one wins', async () => {
      const memory = open()
      const saved = await memory.remember({ commandId: cmd('c20'), text: 'Team lunch is on Thursday' })
      const edit = (text: string) => code(memory.correct({ commandId: cmd('c20-edit'), id: saved.item.id, expectedRevision: 1, text }))
      const results = await Promise.all([edit('Team lunch is on Friday'), edit('Team lunch is on Monday')])
      expect(results.sort()).toEqual(['conflict', 'ok'])
      expect(await code(memory.correct({ commandId: cmd('c19'), id: saved.item.id, expectedRevision: 1, text: 'Team lunch is on Sunday' }))).toBe('conflict')
      expect((await memory.get(saved.item.id))?.revision).toBe(2)
    })

    it('C22: forgetting removes content, blocks replay and re-import, and a new statement is new evidence', async () => {
      const memory = open()
      const creating = cmd('c22')
      const saved = await memory.remember({ commandId: creating, text: 'My locker code is 4471' })
      const kept = await memory.remember({ commandId: cmd('c22-keep'), text: 'My locker is on the second floor' })
      const exported = await memory.exportAll()
      expect(await code(memory.forget({ commandId: cmd('c22-stale'), id: saved.item.id, expectedRevision: 2 }))).toBe('conflict')
      expect(await memory.forget({ commandId: cmd('c22-forget'), id: saved.item.id, expectedRevision: 1 })).toEqual({ id: saved.item.id, forgotten: true })
      expect(await memory.get(saved.item.id)).toBeNull()
      expect((await memory.search('locker code 4471')).map((item) => item.id)).not.toContain(saved.item.id)
      expect((await memory.history(saved.item.id)).every((revision) => revision.text === null)).toBe(true)
      expect(await code(memory.remember({ commandId: creating, text: 'My locker code is 4471' }))).toBe('suppressed')
      // An export made before the forget cannot bring it back.
      const reimport = await memory.importAll(exported)
      expect(reimport).toMatchObject({ suppressed: 1, created: 0 })
      expect(await memory.get(saved.item.id)).toBeNull()
      expect((await memory.get(kept.item.id))?.text).toBe('My locker is on the second floor')
      // Saying it again later is a new explicit statement, not a resurrection of the old record.
      const restated = await memory.remember({ commandId: cmd('c22-new'), text: 'My locker code is 4471' })
      expect(restated.outcome).toBe('created')
      expect(restated.item.id).not.toBe(saved.item.id)
    })

    it('C24: another scope reads, finds, pages, edits and forgets nothing of this one', async () => {
      const victim = open()
      const attacker = open()
      const secret = await victim.remember({ commandId: cmd('c24'), text: 'My vault phrase is zebra quartz' })
      expect(await attacker.get(secret.item.id)).toBeNull()
      expect(await attacker.search('vault phrase zebra quartz')).toEqual([])
      expect((await attacker.list()).items).toEqual([])
      expect(await code(attacker.correct({ commandId: cmd('c24-edit'), id: secret.item.id, expectedRevision: 1, text: 'hijacked' }))).toBe('not_found')
      expect(await code(attacker.forget({ commandId: cmd('c24-forget'), id: secret.item.id, expectedRevision: 1 }))).toBe('not_found')
      expect(await attacker.history(secret.item.id)).toEqual([])
      const page = await victim.list({ limit: 1 })
      await victim.remember({ commandId: cmd('c24-more'), text: 'Another memory for paging' })
      const cursor = (await victim.list({ limit: 1 })).nextCursor
      expect(cursor).not.toBeNull()
      expect(await code(attacker.list({ cursor }))).toBe('validation')
      expect(page.items).toHaveLength(1)
      expect((await victim.get(secret.item.id))?.text).toBe('My vault phrase is zebra quartz')
    })

    it('binds a scope to one principal', async () => {
      const { backend, freshScope, distinctPrincipals } = target()
      const scopeId = freshScope()
      const owner = openMemory({ backend, scopeId, principalId: scopeId })
      await owner.remember({ commandId: cmd('bind'), text: 'Owned by the first principal' })
      const intruder = openMemory({ backend, scopeId, principalId: `${scopeId}-other` })
      expect(await code(intruder.get('anything'))).toBe(distinctPrincipals ? 'unauthorized' : 'unsupported')
      expect(await code(intruder.remember({ commandId: cmd('bind-2'), text: 'Written by someone else' }))).toBe(distinctPrincipals ? 'unauthorized' : 'unsupported')
    })

    it('pages through many memories with a stable cursor and no repeats', async () => {
      const memory = open()
      for (let index = 0; index < 25; index += 1) await memory.remember({ commandId: cmd(`page-${index}`), text: `Paged memory number ${index}` })
      const seen: string[] = []
      let cursor: string | null = null
      do {
        const page = await memory.list({ limit: 7, cursor })
        seen.push(...page.items.map((item) => item.id))
        cursor = page.nextCursor
      } while (cursor)
      expect(seen).toHaveLength(25)
      expect(new Set(seen).size).toBe(25)
    })

    it('captures idempotently and fences job leases: a stale or expired lease cannot complete', async () => {
      const memory = open()
      const first = await memory.capture({ idempotencyKey: cmd('turn'), text: 'I really enjoy hiking' })
      const key = cmd('turn-2')
      await memory.capture({ idempotencyKey: key, text: 'Second turn' })
      expect(await memory.capture({ idempotencyKey: key, text: 'Second turn' })).toMatchObject({ outcome: 'replayed' })
      expect(await code(memory.capture({ idempotencyKey: key, text: 'Different text' }))).toBe('conflict')
      const now = new Date()
      const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString()
      const claimed = await memory.claimJobs({ workerId: 'worker-a', limit: 1, leaseMs: 10_000 }, { now: at(0) })
      expect(claimed).toHaveLength(1)
      expect(claimed[0]!.eventId).toBe(first.eventId)
      // Lease expires; another worker takes it with a higher fence.
      const retaken = await memory.claimJobs({ workerId: 'worker-b', limit: 5, leaseMs: 10_000 }, { now: at(20) })
      const same = retaken.find((job) => job.jobId === claimed[0]!.jobId)!
      expect(same.fence).toBeGreaterThan(claimed[0]!.fence)
      expect(await memory.completeJob({ jobId: claimed[0]!.jobId, fence: claimed[0]!.fence }, { now: at(21) })).toBe('lease_lost')
      expect(await memory.completeJob({ jobId: same.jobId, fence: same.fence }, { now: at(22) })).toBe('completed')
      expect(await memory.completeJob({ jobId: same.jobId, fence: same.fence }, { now: at(23) })).toBe('lease_lost')
    })

    it('refuses a missing grant, a cancelled call and malformed input without touching storage', async () => {
      const { backend, freshScope } = target()
      const scopeId = freshScope()
      const reader = openMemory({ backend, scopeId, principalId: scopeId, grants: ['read'] })
      expect(await code(reader.remember({ commandId: cmd('grant'), text: 'Should not be saved' }))).toBe('unauthorized')
      const writer = openMemory({ backend, scopeId, principalId: scopeId })
      const aborted = new AbortController()
      aborted.abort()
      expect(await code(writer.remember({ commandId: cmd('cancel'), text: 'Should not be saved' }, { signal: aborted.signal }))).toBe('cancelled')
      expect(await code(writer.remember({ commandId: 'bad id with spaces', text: 'x' }))).toBe('validation')
      expect(await code(writer.remember({ commandId: cmd('kind'), text: 'x', kind: 'secret' as never }))).toBe('validation')
      expect(await code(writer.remember({ commandId: cmd('long'), text: 'x'.repeat(1_001) }))).toBe('validation')
      expect((await writer.list()).items).toEqual([])
    })

    it('exports only current memories and imports idempotently into the same memory only', async () => {
      const memory: ScopedMemory = open()
      await memory.remember({ commandId: cmd('exp-1'), text: 'I like jasmine tea', kind: 'preference' })
      await memory.remember({ commandId: cmd('exp-2'), text: 'My cat is called Pixel' })
      const exported = await memory.exportAll()
      expect(exported.items.map((item) => item.text).sort()).toEqual(['I like jasmine tea', 'My cat is called Pixel'])
      // The scope travels only as a fingerprint.
      expect(JSON.stringify(exported)).not.toContain(memory.scope.scopeId)
      const report = await memory.importAll(exported)
      expect(report.created).toBe(0)
      expect(report.duplicate + report.replayed).toBe(2)
      const other = open()
      expect(await code(other.importAll(exported))).toBe('validation')
    })
  })
}
