import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { resolve, join } from 'node:path'
import { gate, originAllowed } from '../lib/guard'
import { EphemeralMemoryStore, JsonMemoryStore, type MemoryStore } from '../lib/tools/memory'
import { VersionedMemoryAuthority } from './memory-authority'

const COOKIE = 'gideon-owner'
const AGE = 365 * 24 * 60 * 60
const REGISTRY = Symbol.for('gideon.node.identity-memory.v1')
interface Registry { secret: string; stores: Map<string, MemoryStore> }
const globals = globalThis as typeof globalThis & { [REGISTRY]?: Registry }
/** Both separately generated Node bundles use this same process authority. */
function registry(): Registry {
  return globals[REGISTRY] ??= { secret: Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join(''), stores: new Map() }
}
function secret() {
  const configured = process.env.GIDEON_IDENTITY_SECRET?.trim()
  if (configured && configured.length < 32) throw new Error('GIDEON_IDENTITY_SECRET must be at least 32 characters')
  return configured || registry().secret
}
function sign(payload: string) { return createHmac('sha256', secret()).update(payload).digest('base64url') }
function cookieValue(headers: { get(name: string): string | null }): string | null {
  const values = (headers.get('cookie') || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`))
  return values.length === 1 ? values[0].slice(COOKIE.length + 1) : null
}
/** Only a valid, unexpired server-issued cookie selects durable memory. */
export function nodeOwner(headers: { get(name: string): string | null }): string | null {
  const token = cookieValue(headers)
  if (!token || token.length > 256) return null
  const match = /^(v1\.([a-f0-9]{64})\.(\d{10}))\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!match || Number(match[3]) <= Math.floor(Date.now() / 1000)) return null
  const expected = Buffer.from(sign(match[1]))
  const supplied = Buffer.from(match[4])
  return supplied.length === expected.length && timingSafeEqual(expected, supplied) ? `node/${match[2]}` : null
}
export function nodeMemoryStore(headers?: { get(name: string): string | null }): MemoryStore {
  const owner = headers ? nodeOwner(headers) : null
  if (!owner) return new EphemeralMemoryStore()
  const directory = resolve(process.env.GIDEON_MEMORY_DIR || '.gideon/memories')
  const key = `${directory}\0${owner}`
  let store = registry().stores.get(key)
  if (!store) {
    store = new VersionedMemoryAuthority(new JsonMemoryStore(join(directory, `${owner.slice(5)}.json`)))
    registry().stores.set(key, store)
  }
  return store
}
/** Where a signed Node owner's legacy memory array lives. */
export function legacyMemoryFile(owner: string): string {
  return join(resolve(process.env.GIDEON_MEMORY_DIR || '.gideon/memories'), `${owner.slice(5)}.json`)
}

/**
 * The legacy file for the Stage 15 cutover, read from disk on every access.
 * A cutover or rollback may rewrite the file from another process, so a
 * cached copy could put stale (even deleted) memories back on the next
 * write. Writes in this process are still serialised.
 */
export function uncachedLegacyStore(owner: string): VersionedMemoryAuthority {
  const path = legacyMemoryFile(owner)
  const key = `${path}\0uncached`
  let store = registry().stores.get(key) as VersionedMemoryAuthority | undefined
  if (!store) {
    store = new VersionedMemoryAuthority({
      all: () => new JsonMemoryStore(path).all(),
      save: (memories) => new JsonMemoryStore(path).save(memories),
      mutate: () => Promise.reject(new Error('Serialised by the authority')),
    })
    registry().stores.set(key, store)
  }
  return store
}

/** Bootstrap contract: 200 confirmed cookie, 503 retryable configuration/issuance failure. */
export async function ensureNodeAccount(request: Request): Promise<Response> {
  if (!originAllowed(request.headers.get('origin'), request.url, true)) {
    return Response.json({ error: { code: 'origin_rejected', message: 'Origin not allowed.', retryable: false } }, { status: 403 })
  }
  const decision = gate(request, 'account')
  if (!decision.ok) return Response.json({ error: { ...decision, retryable: decision.status === 429 } }, { status: decision.status })
  try {
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    if (!nodeOwner(request.headers)) {
      const payload = `v1.${Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('')}.${Math.floor(Date.now() / 1000) + AGE}`
      const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
      headers.set('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AGE}${secure}`)
    }
    return Response.json({ anonymous: true }, { headers })
  } catch {
    return Response.json({ error: { code: 'account_failed', message: 'Account setup is temporarily unavailable.', retryable: true } }, { status: 503 })
  }
}
