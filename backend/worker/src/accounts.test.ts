import { memoryAdapter } from 'better-auth/adapters/memory'
import { describe, expect, it } from 'vitest'
import type { Memory } from '../../../src/lib/tools/memory'
import { OwnerUnavailable, ownerOf } from './accounts'
import { handleApi } from './api'
import { adoption } from './memory'
import type { Env } from './types'

const ORIGIN = 'http://localhost'

const cello: Memory = {
  id: 'memory-1',
  kind: 'fact',
  text: 'The user plays the cello.',
  createdAt: '2026-09-10T00:00:00.000Z',
  usedAt: '2026-09-10T00:00:00.000Z',
  uses: 2,
}

/**
 * Real Better Auth on its in-memory adapter, with the session namespace reduced
 * to the memory RPC surface the account flow uses.
 */
function world({ accounts = true } = {}) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  }
  const objects = new Map<string, Memory[]>()
  const env = {
    ...(accounts
      ? { DB: memoryAdapter(tables), BETTER_AUTH_SECRET: 'a-test-secret-that-is-long-enough-to-use' }
      : {}),
    GIDEON_SESSION: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        memories: async () => objects.get(name) ?? [],
        adopt: async (memories: Memory[]) => {
          const { memories: next, result } = adoption(objects.get(name) ?? [], memories)
          objects.set(name, next)
          return result
        },
        memorySnapshot: async (owner: string) => ({ memories: objects.get(owner) ?? [], version: 'test' }),
        memoryCommit: async (owner: string, _expected: string, memories: Memory[]) => {
          objects.set(owner, memories)
          return true
        },
      }),
    },
  } as unknown as Env
  return { env, tables, objects }
}

function visit(env: Env, headers: Record<string, string> = {}) {
  return handleApi(
    new Request(`${ORIGIN}/api/account`, { method: 'POST', headers: { Origin: ORIGIN, ...headers } }),
    env,
  )
}

/** The cookies a browser would send back after this response. */
function cookiesFrom(response: Response | null) {
  return (response?.headers.getSetCookie() ?? []).map((cookie) => cookie.split(';')[0]).join('; ')
}

function request(headers: Record<string, string>) {
  return new Request(`${ORIGIN}/api/chat`, { method: 'POST', headers })
}

describe('accounts', () => {
  it('gives a new visitor an anonymous account without asking them to sign up', async () => {
    const { env, tables } = world()

    const response = await visit(env)

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ anonymous: true })
    expect(cookiesFrom(response)).toContain('better-auth.session_token=')
    expect(tables.user).toHaveLength(1)
  })

  it('recognises the account on the next visit instead of making another', async () => {
    const { env, tables } = world()
    const cookie = cookiesFrom(await visit(env))

    const again = await visit(env, { Cookie: cookie })

    expect(again?.status).toBe(200)
    expect(tables.user).toHaveLength(1)
    expect(await ownerOf(request({ Cookie: cookie, 'X-Gideon-Session': 'browser-1' }), env)).toBe(
      `user/${tables.user[0]?.id}`,
    )
  })

  it('keeps memory on the ephemeral id when accounts are not set up', async () => {
    const { env } = world({ accounts: false })

    expect((await visit(env))?.status).toBe(404)
    const owner = await ownerOf(request({ 'X-Gideon-Session': 'browser-1' }), env)
    expect(owner.startsWith('ephemeral/')).toBe(true)
    const second = await ownerOf(request({ 'X-Gideon-Session': 'browser-1' }), env)
    expect(second).not.toBe(owner)
  })

  it('never lets a browser id name an account owner', async () => {
    const { env, tables } = world()
    await visit(env)
    const name = `user/${tables.user[0]?.id}`

    const owner = await ownerOf(request({ 'X-Gideon-Session': name }), env)
    expect(owner.startsWith('user/')).toBe(false)
  })

  it('returns 503 when credentials are present but cannot be verified', async () => {
    const { env, tables } = world()
    const cookie = cookiesFrom(await visit(env))
    // Drop the database: the cookie can no longer be checked.
    delete env.DB

    await expect(ownerOf(request({ Cookie: cookie }), env)).rejects.toBeInstanceOf(OwnerUnavailable)

    const chat = await handleApi(
      new Request(`${ORIGIN}/api/chat`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
      }),
      env,
    )
    expect(chat?.status).toBe(503)
    expect(tables.user).toHaveLength(1)
  })

  it('serves nothing durable to a request without credentials', async () => {
    const { env, tables } = world()

    const owner = await ownerOf(request({ 'X-Gideon-Session': 'browser-1' }), env)
    expect(owner.startsWith('ephemeral/')).toBe(true)
    expect(tables.user).toHaveLength(0)
  })
})

describe('adoption', () => {
  it('never overwrites an account that already remembers something', () => {
    const own: Memory = { ...cello, id: 'memory-2', text: 'The user has a dog called Biscuit.' }

    expect(adoption([own], [cello])).toEqual({ memories: [own], result: 0 })
  })

  it('takes only well-formed memories', () => {
    expect(adoption([], [cello, { text: 'not a memory' }])).toEqual({ memories: [cello], result: 1 })
  })
})
