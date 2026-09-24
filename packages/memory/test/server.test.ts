import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryError } from '../src/contract.ts'
import { createMemoryClient } from '../src/sdk.ts'
import { createMemoryServer } from '../src/server.ts'
import { SqliteMemoryBackend } from '../src/sqlite.ts'

const backend = new SqliteMemoryBackend({ path: ':memory:' })
const ALICE = 'alice-token-0123456789abcdef'
const BOB = 'bob-token-0123456789abcdef0'
const READER = 'reader-token-0123456789abcd'
const service = createMemoryServer({
  backend,
  tokens: new Map([
    [ALICE, { scopeId: 'alice', principalId: 'alice' }],
    [BOB, { scopeId: 'bob', principalId: 'bob' }],
    [READER, { scopeId: 'alice', principalId: 'alice', grants: ['read'] }],
  ]),
})
let url = ''

beforeAll(async () => {
  url = (await service.listen()).url
})

afterAll(async () => {
  await service.close()
  await backend.close()
})

const code = async (promise: Promise<unknown>) => promise.then(() => 'ok', (error) => (error instanceof MemoryError ? error.code : 'thrown'))

describe('local memory server and SDK', () => {
  it('remembers, pages, searches and exports through the SDK with typed results', async () => {
    const alice = createMemoryClient({ baseUrl: url, token: ALICE })
    expect((await alice.capabilities()).backend).toBe('sqlite')
    const saved = await alice.remember({ commandId: 'sdk-1', text: 'My favourite bakery is on Canal Road', kind: 'preference' })
    for (let index = 0; index < 5; index += 1) await alice.remember({ commandId: `sdk-page-${index}`, text: `Paged note ${index}` })
    const all: string[] = []
    for await (const item of alice.listAll({ pageSize: 2 })) all.push(item.id)
    expect(all).toHaveLength(6)
    expect((await alice.search('favourite bakery')).map((item) => item.id)).toContain(saved.item.id)
    expect((await alice.exportAll()).items).toHaveLength(6)
  })

  it('takes identity from the token only: another token sees nothing, and a body naming a scope is refused', async () => {
    const alice = createMemoryClient({ baseUrl: url, token: ALICE })
    const bob = createMemoryClient({ baseUrl: url, token: BOB })
    const secret = await alice.remember({ commandId: 'sdk-secret', text: 'My vault phrase is zebra quartz' })
    expect(await bob.get(secret.item.id)).toBeNull()
    expect(await bob.search('vault phrase')).toEqual([])
    const forged = await fetch(`${url}/v1/get`, { method: 'POST', headers: { authorization: `Bearer ${BOB}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: secret.item.id, scopeId: 'alice' }) })
    expect(forged.status).toBe(400)
    expect(JSON.stringify(await forged.json())).not.toContain('zebra')
  })

  it('refuses missing or wrong tokens, missing grants, other protocol versions and oversized bodies', async () => {
    expect((await fetch(`${url}/v1/get`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect(await code(createMemoryClient({ baseUrl: url, token: 'wrong-token-0123456789abc' }).get('x'))).toBe('unauthorized')
    const reader = createMemoryClient({ baseUrl: url, token: READER })
    expect(await code(reader.remember({ commandId: 'reader-write', text: 'Should not save' }))).toBe('unauthorized')
    const other = await fetch(`${url}/v1/get`, { method: 'POST', headers: { authorization: `Bearer ${ALICE}`, 'x-gideon-memory-protocol': '99' }, body: '{"id":"x"}' })
    expect(other.status).toBe(422)
    const huge = await fetch(`${url}/v1/remember`, { method: 'POST', headers: { authorization: `Bearer ${ALICE}` }, body: JSON.stringify({ commandId: 'huge', text: 'x'.repeat(2_000_000) }) })
    expect(huge.status).toBe(400)
  })

  it('reports cancellation and an unreachable server as typed errors', async () => {
    const alice = createMemoryClient({ baseUrl: url, token: ALICE })
    const aborted = new AbortController()
    aborted.abort()
    expect(await code(alice.get('x', { signal: aborted.signal }))).toBe('cancelled')
    const gone = createMemoryClient({ baseUrl: 'http://127.0.0.1:1', token: ALICE, timeoutMs: 2_000 })
    const error = await gone.get('x').catch((caught: MemoryError) => caught)
    expect(error).toMatchObject({ code: 'unavailable', retryable: true })
  })

  it('will not listen beyond loopback unless told to', () => {
    expect(() => createMemoryServer({ backend, tokens: new Map(), host: '0.0.0.0' })).toThrow(/loopback/u)
  })
})
