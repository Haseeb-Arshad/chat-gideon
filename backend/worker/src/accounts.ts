/**
 * Who a person is, rather than which browser they happen to be in.
 *
 * Memory used to be chosen by an id the browser made up for itself, so
 * clearing site data or opening another device met a GIDEON that had never
 * heard of you, and nothing on the server could tell whether the id was
 * honest. An account gives memory a name the server issued and can check.
 *
 * Nobody is asked to sign up. Everyone gets an anonymous account on arrival,
 * which a real sign-in can later be attached to. Accounts need a D1 database
 * and a secret; without either, memory stays keyed by the browser's id exactly
 * as before.
 */

import { betterAuth } from 'better-auth'
import { anonymous } from 'better-auth/plugins'
import { allowedOrigins } from '../../../src/lib/guard'
import type { Memory } from '../../../src/lib/tools/memory'
import { sessionIdFromRequest } from './identity'
import { SupabaseMemoryStore, adoption, hasSupabaseMemory } from './memory'
import type { Env } from './types'

/** Set by the Worker in front of the session object, which removes any a client sent. */
export const OWNER_HEADER = 'x-gideon-owner'

/** Matches the plain and the `__Secure-` form Better Auth uses over HTTPS. */
const SESSION_COOKIE = 'better-auth.session_token'

const DAY = 60 * 60 * 24

function createAuth(env: Env, database: D1Database, origin: string) {
  return betterAuth({
    database,
    secret: env.BETTER_AUTH_SECRET,
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
  })
}

type Auth = ReturnType<typeof createAuth>

/** One instance per origin, rebuilt if the isolate is handed different bindings. */
let built: { env: Env; byOrigin: Map<string, Auth> } | null = null

function authFor(request: Request, env: Env): Auth | null {
  const database = env.DB
  if (!database || (env.BETTER_AUTH_SECRET?.trim().length ?? 0) < 32) return null

  if (built?.env !== env) built = { env, byOrigin: new Map() }
  const origin = new URL(request.url).origin
  let auth = built.byOrigin.get(origin)
  if (!auth) {
    auth = createAuth(env, database, origin)
    built.byOrigin.set(origin, auth)
  }
  return auth
}

/** A browser's id cannot contain a slash, so no browser can claim an account's memory. */
export function accountOwner(userId: string) {
  return `user/${userId}`
}

/** The name memory is kept under: the account if the caller has one, otherwise the browser's id. */
export async function ownerOf(request: Request, env: Env): Promise<string> {
  const auth = authFor(request, env)
  if (auth && request.headers.get('cookie')?.includes(SESSION_COOKIE)) {
    try {
      const session = await auth.api.getSession({ headers: request.headers })
      if (session) return accountOwner(session.user.id)
    } catch {
      // A database outage costs this turn the account, not the turn itself.
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
 * is chosen as it opens. A new account takes over whatever the browser's id
 * already remembered, so nobody loses what GIDEON knew about them on the day
 * accounts arrive.
 */
export async function ensureAccount(request: Request, env: Env): Promise<AccountResult | null> {
  const auth = authFor(request, env)
  if (!auth) return null

  const existing = await auth.api.getSession({ headers: request.headers, returnHeaders: true })
  if (existing.response) {
    const user = existing.response.user as { isAnonymous?: boolean | null }
    return { anonymous: Boolean(user.isAnonymous), headers: existing.headers }
  }

  const created = await auth.api.signInAnonymous({ headers: request.headers, returnHeaders: true })
  const browser = sessionIdFromRequest(request)
  // `anonymous` is the one id every browser without storage shares, so what
  // it holds belongs to nobody in particular and must never be handed on.
  if (browser !== 'anonymous') {
    await adoptMemories(env, browser, accountOwner(created.response.user.id))
  }
  return { anonymous: true, headers: created.headers }
}

/** Copies one owner's memories to another that has none yet. */
export async function adoptMemories(env: Env, from: string, to: string): Promise<number> {
  if (hasSupabaseMemory(env)) {
    const found = await new SupabaseMemoryStore(env, from).all()
    return new SupabaseMemoryStore(env, to).mutate((current) => adoption(current, found))
  }

  const source = env.GIDEON_SESSION.get(env.GIDEON_SESSION.idFromName(from))
  const found: Memory[] = await source.memories()
  if (!found.length) return 0
  return env.GIDEON_SESSION.get(env.GIDEON_SESSION.idFromName(to)).adopt(found)
}
