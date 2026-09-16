import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureNodeAccount, nodeMemoryStore, nodeOwner } from './identity'
import { JsonMemoryStore, type Memory } from '../lib/tools/memory'

const fact: Memory = { id: 'one', kind: 'fact', text: 'Tea', createdAt: '2026-09-17', usedAt: '2026-09-17', uses: 0 }
const directories: string[] = []
afterEach(async () => {
  delete process.env.GIDEON_MEMORY_DIR
  delete process.env.GIDEON_IDENTITY_SECRET
  vi.useRealTimers()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function cookie() {
  const result = await ensureNodeAccount(new Request('https://gideon.example/api/account', {
    method: 'POST', headers: { origin: 'https://gideon.example' },
  }))
  expect(result.status).toBe(200)
  expect(result.headers.get('set-cookie')).toContain('HttpOnly')
  expect(result.headers.get('set-cookie')).toContain('Secure')
  return new Headers({ cookie: result.headers.get('set-cookie')!.split(';')[0] })
}

describe('Node owner authority', () => {
  it('isolates two confirmed owners and shares HTTP/socket and separately loaded bundle authority', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gideon-owner-')); directories.push(dir)
    process.env.GIDEON_MEMORY_DIR = dir
    const a = await cookie(), b = await cookie()
    const http = nodeMemoryStore(a), socket = nodeMemoryStore(a)
    expect(http).toBe(socket)
    expect(nodeOwner(a)).not.toBe(nodeOwner(b))
    vi.resetModules()
    const otherBundle = await import('./identity')
    expect(otherBundle.nodeMemoryStore(a)).toBe(http)
    await http.mutate(() => ({ memories: [fact], result: 1 }))
    expect(await socket.all()).toEqual([fact])
    expect(await nodeMemoryStore(b).all()).toEqual([])
  })

  it('does not trust legacy IDs, altered cookies, expired cookies, or missing credentials', async () => {
    const headers = await cookie()
    const changed = new Headers({ cookie: headers.get('cookie')!.replace('v1.', 'v2.') })
    expect(nodeOwner(changed)).toBeNull()
    const a = nodeMemoryStore(new Headers({ 'x-gideon-session': 'shared' }))
    const b = nodeMemoryStore(new Headers({ 'x-gideon-session': 'shared' }))
    await a.mutate(() => ({ memories: [fact], result: 1 }))
    expect(await b.all()).toEqual([])
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 366 * 86400000)
    expect(nodeOwner(headers)).toBeNull()
  })

  it('reports invalid signing configuration as transient', async () => {
    process.env.GIDEON_IDENTITY_SECRET = 'short'
    const result = await ensureNodeAccount(new Request('https://gideon.example/api/account', { method: 'POST', headers: { origin: 'https://gideon.example' } }))
    expect(result.status).toBe(503)
  })

  it('never overwrites unreadable/corrupt disk data or publishes failed writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gideon-disk-')); directories.push(dir)
    const path = join(dir, 'memory.json')
    await writeFile(path, 'not json')
    const corrupt = new JsonMemoryStore(path)
    await expect(corrupt.mutate(() => ({ memories: [], result: 1 }))).rejects.toThrow()
    await writeFile(path, JSON.stringify([fact]))
    expect(await corrupt.all()).toEqual([fact])
    const blocked = new JsonMemoryStore(join(path, 'child.json'))
    await expect(blocked.save([fact])).rejects.toThrow()
    // Windows reports ENOENT for a child under a file. Either way the failed
    // write must not publish the attempted fact into the cache.
    expect(await blocked.all().catch(() => [])).toEqual([])
  })
})
