/**
 * Who a person is, rather than which browser they happen to be in.
 *
 * Memory used to be chosen by an id the browser made up for itself, so
 * clearing site data or opening another device met a GIDEON that had never
 * heard of you, and nothing on the server could tell whether the id was
 * honest. An account gives memory a name the server issued and can check.
 *
 * Nobody is asked to sign up. Everyone gets an anonymous account on arrival,
 * which a real sign-in can later be attached to. Accounts need a database
 * (PostgreSQL through Hyperdrive, or D1) and a secret; without either,
 * unverified callers get per-request/connection ephemeral memory. Legacy
 * browser IDs never prove ownership.
 */

import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { anonymous, bearer } from 'better-auth/plugins'
import { Pool } from 'pg'
import { allowedOrigins, originAllowed } from '../../../src/lib/guard'
import { SOCKET_AUTH_PREFIX } from '../../../src/lib/protocol'
import { sessionIdFromRequest } from './identity'
import { memoryStoreForHttp, adoption } from './memory'
import type { Env } from './types'

/** Set by the Worker in front of the session object, which removes any a client sent. */
export const OWNER_HEADER = 'x-gideon-owner'
/** A token the Worker has just issued, for the session object to hand to the browser. */
export const ISSUED_TOKEN_HEADER = 'x-gideon-issued-token'

/** Matches the plain and the `__Secure-` form Better Auth uses over HTTPS. */
const SESSION_COOKIE = 'better-auth.session_token'

export class OwnerUnavailable extends Error {}

const DAY = 60 * 60 * 24

/** The account configuration; also used to generate the PostgreSQL schema, so the two never drift. */
export function accountOptions(database: BetterAuthOptions['database'], secret: string | undefined, origin: string) {
  return {
    database,
    secret,
    baseURL: origin,
    basePath: '/api/auth',
    trustedOrigins: [origin, ...allowedOrigins()],
    // A page served from another site cannot use this host's cookies, so it
    // keeps the signed session token itself and presents it as a bearer.
    plugins: [anonymous(), bearer({ requireSignature: true })],
    session: {
      // An anonymous account has no way back in once its cookie is gone, so
      // it lasts a year from the last visit instead of Better Auth's week.
      expiresIn: 365 * DAY,
      updateAge: DAY,
      // Spares a database read on every turn and every socket. A revoked
      // session can be trusted for at most this long afterwards.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions
}

function createAuth(env: Env, database: BetterAuthOptions['database'], origin: string) {
  return betterAuth(accountOptions(database, env.BETTER_AUTH_SECRET, origin))
}

type Auth = ReturnType<typeof createAuth>

/** An account handle for one request. `close` releases its database connection. */
interface AuthHandle { auth: Auth; close(): Promise<void> }

const KEEP_OPEN = async () => undefined

/** D1 instances are kept per origin, rebuilt if the isolate is handed different bindings. */
let built: { env: Env; byOrigin: Map<string, Auth> } | null = null

function authFor(request: Request, env: Env): AuthHandle | null {
  if ((env.BETTER_AUTH_SECRET?.trim().length ?? 0) < 32) return null
  const origin = new URL(request.url).origin

  const connectionString = env.HYPERDRIVE?.connectionString
  if (connectionString) {
    // A Worker cannot reuse a socket opened for another request, so each
    // request gets its own one-connection pool and closes it when done.
    // Hyperdrive keeps the real connections to the database warm.
    const pool = new Pool({ connectionString, max: 1 })
    pool.on('error', () => undefined)
    return { auth: createAuth(env, pool, origin), close: () => pool.end().catch(() => undefined) }
  }

  const database = env.DB
  if (!database) return null
  if (built?.env !== env) built = { env, byOrigin: new Map() }
  let auth = built.byOrigin.get(origin)
  if (!auth) {
    auth = createAuth(env, database, origin)
    built.byOrigin.set(origin, auth)
  }
  return { auth, close: KEEP_OPEN }
}

/** A browser's id cannot contain a slash, so no browser can claim an account's memory. */
export function accountOwner(userId: string) {
  return `user/${userId}`
}

/**
 * A page on another site, such as chatgideon.com in front of this Worker.
 * Cookies set here are third-party there, so it is given its token to keep.
 */
export function crossSitePage(request: Request): boolean {
  const origin = request.headers.get('origin')
  return Boolean(origin) && origin !== new URL(request.url).origin && originAllowed(origin, request.url, true)
}

function hasBearer(request: Request): boolean {
  return /^bearer\s+\S/i.test(request.headers.get('authorization') ?? '')
}

/**
 * A browser cannot set headers on a WebSocket, so a page keeps its token in
 * the one it can: the offered subprotocols. This moves it to where Better Auth
 * looks for it. The token never goes in the URL, where it would be logged.
 */
export function withSocketCredentials(request: Request): Request {
  if (hasBearer(request)) return request
  const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((value) => value.trim())
  const encoded = offered.find((value) => value.startsWith(SOCKET_AUTH_PREFIX))?.slice(SOCKET_AUTH_PREFIX.length)
  if (!encoded) return request
  let token: string
  try { token = atob(encoded.replaceAll('-', '+').replaceAll('_', '/')) } catch { return request }
  if (!/^[\x21-\x7e]{1,512}$/.test(token)) return request
  const headers = new Headers(request.headers)
  headers.set('authorization', `Bearer ${token}`)
  return new Request(request, { headers })
}

/** The signed session token from Better Auth's cookies: what a bearer must present. */
function issuedToken(headers: Headers): string | null {
  for (const cookie of headers.getSetCookie()) {
    const [pair] = cookie.split(';')
    const at = pair.indexOf('=')
    if (at < 0 || !pair.slice(0, at).trim().endsWith(SESSION_COOKIE)) continue
    const value = pair.slice(at + 1).trim()
    try { return decodeURIComponent(value) || null } catch { return value || null }
  }
  return null
}

/** The name memory is kept under: the account if the caller has one, otherwise never a shared id. */
export async function ownerOf(request: Request, env: Env): Promise<string> {
  const hasCredentials = request.headers.get('cookie')?.includes(SESSION_COOKIE) || hasBearer(request)
  const handle = hasCredentials ? authFor(request, env) : null
  if (!handle && hasCredentials) throw new OwnerUnavailable('Account verification is not configured.')
  if (handle) {
    try {
      const session = await handle.auth.api.getSession({ headers: request.headers })
      if (session) return accountOwner(session.user.id)
    } catch (error) {
      // The caller presented credentials that could not be verified right now.
      // Answering with an unverified id would hand this turn somebody else's
      // conversation, and a shared fallback would hand it to strangers, so the
      // caller is told to retry rather than served under a borrowed name.
      throw new OwnerUnavailable('The account could not be verified.', { cause: error })
    } finally {
      await handle.close()
    }
  }
  return sessionIdFromRequest(request)
}

/** Hands the session object its owner, and any token just issued, replacing anything the client sent. */
export function withOwner(request: Request, owner: string, issued?: string | null): Request {
  const headers = new Headers(request.headers)
  headers.set(OWNER_HEADER, owner)
  headers.delete(ISSUED_TOKEN_HEADER)
  headers.delete('authorization')
  if (issued) headers.set(ISSUED_TOKEN_HEADER, issued)
  return new Request(request, { headers })
}

export interface AccountResult {
  anonymous: boolean
  /** Carries the session cookies, new or refreshed, back to the browser. */
  headers: Headers
  userId: string
  /** The signed session token, when this response set one; what a cross-site page keeps. */
  token: string | null
}

/**
 * Makes sure the caller has an account, creating an anonymous one if not.
 *
 * The page calls this before opening its socket, because the socket's memory
 * is chosen as it opens. No legacy browser-ID data is imported: those IDs were
 * unverified. Cookie issuance has no dependency on memory storage/adoption.
 */
export async function ensureAccount(request: Request, env: Env): Promise<AccountResult | null> {
  const handle = authFor(request, env)
  if (!handle) return null
  const { auth } = handle
  try {
    const existing = await auth.api.getSession({ headers: request.headers, returnHeaders: true })
    if (existing.response) {
      const user = existing.response.user as { id: string; isAnonymous?: boolean | null }
      return { anonymous: Boolean(user.isAnonymous), headers: existing.headers, userId: user.id, token: issuedToken(existing.headers) }
    }

    const created = await auth.api.signInAnonymous({ headers: request.headers, returnHeaders: true })
    return { anonymous: true, headers: created.headers, userId: created.response.user.id, token: issuedToken(created.headers) }
  } finally {
    await handle.close()
  }
}

/**
 * Opens an account for a cross-site page arriving on a socket without one, so
 * its memory is kept from the first thing said. The token goes back over the
 * socket that is already opening, which spares a first visit a separate
 * request and its preflight before GIDEON can listen. Null when accounts are
 * off or the account could not be made; the socket is then served as before.
 */
export async function accountForSocket(request: Request, env: Env): Promise<{ owner: string; token: string } | null> {
  try {
    const result = await ensureAccount(request, env)
    return result?.token ? { owner: accountOwner(result.userId), token: result.token } : null
  } catch {
    return null
  }
}

/**
 * Copies one owner's memories to another that has none yet, when the new owner
 * is verified.
 *
 * The browser's id keeps its own copy, so a takeover that fails part way has
 * lost nothing.
 */
export async function adoptMemories(env: Env, from: string, to: string): Promise<number> {
  if (!from.startsWith('user/') || !to.startsWith('user/')) return 0
  const found = await memoryStoreForHttp(env, from, env.GIDEON_SESSION).all()
  return memoryStoreForHttp(env, to, env.GIDEON_SESSION).mutate((target) => adoption(target, found))
}
