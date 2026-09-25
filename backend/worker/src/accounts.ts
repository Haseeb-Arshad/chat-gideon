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
import { anonymous } from 'better-auth/plugins'
import { Pool } from 'pg'
import { allowedOrigins } from '../../../src/lib/guard'
import { sessionIdFromRequest } from './identity'
import { memoryStoreForHttp, adoption } from './memory'
import type { Env } from './types'

/** Set by the Worker in front of the session object, which removes any a client sent. */
export const OWNER_HEADER = 'x-gideon-owner'

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
    plugins: [anonymous()],
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

/** The name memory is kept under: the account if the caller has one, otherwise never a shared id. */
export async function ownerOf(request: Request, env: Env): Promise<string> {
  const hasCredentials = request.headers.get('cookie')?.includes(SESSION_COOKIE)
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

/** Hands the session object its owner, replacing anything the client sent. */
export function withOwner(request: Request, owner: string): Request {
  const headers = new Headers(request.headers)
  headers.set(OWNER_HEADER, owner)
  return new Request(request, { headers })
}

export interface AccountResult {
  anonymous: boolean
  /** Carries the session cookies, new or refreshed, back to the browser. */
  headers: Headers
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
      const user = existing.response.user as { isAnonymous?: boolean | null }
      return { anonymous: Boolean(user.isAnonymous), headers: existing.headers }
    }

    const created = await auth.api.signInAnonymous({ headers: request.headers, returnHeaders: true })
    return { anonymous: true, headers: created.headers }
  } finally {
    await handle.close()
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
