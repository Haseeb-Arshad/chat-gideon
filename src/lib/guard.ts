/**
 * What stands between a public URL and someone else's OpenRouter bill.
 *
 * GIDEON's endpoints are unauthenticated by design: the whole point is that you
 * open the page and talk. That is fine on localhost and reckless in public, so
 * the same routes carry a token bucket, an origin check, and an optional shared
 * access code that only switches on when the environment sets one.
 *
 * Everything here is deliberately in-process. A single long-lived Node server is
 * the deployment target, so a Redis dependency would buy correctness across
 * replicas we do not have and cost a round trip on every turn.
 */

/**
 * Token buckets rather than fixed windows: a fixed window lets someone spend a
 * full quota in the last second of one window and again in the first second of
 * the next, and a voice turn is bursty enough that the distinction is real.
 */
export interface BucketConfig {
  /** Sustained rate, in tokens per second. */
  refillPerSecond: number
  /** How much burst is allowed above the sustained rate. */
  capacity: number
}

export interface BucketState {
  tokens: number
  updatedAt: number
}

export interface RateDecision {
  allowed: boolean
  /** Seconds until the next token, for a Retry-After header. */
  retryAfter: number
  remaining: number
}

/**
 * Ceilings a person cannot reach, not budgets a conversation has to live within.
 *
 * The first version of this table was sized by guessing at what seemed
 * reasonable per surface, and the result was that it throttled the actual user:
 * `turn` allowed eight and then one every two seconds, while every barge-in
 * starts a fresh turn, so interrupting a few times in a row hit the limit and
 * GIDEON answered "you are talking faster than I am allowed to answer". A
 * guard that stops the person it is meant to be protecting is worse than no
 * guard, because it fails in the one case that matters.
 *
 * So these are now set from the other direction: what a *script* would have to
 * exceed to be abusive, which is far above anything a human mouth can produce.
 * One turn every couple of seconds is fast conversation; sixty in the bucket
 * with two a second of refill cannot be reached by talking.
 */
export const LIMITS = {
  turn: { refillPerSecond: 2, capacity: 60 },
  /** A long reply is a dozen chunks, and several turns can overlap. */
  speak: { refillPerSecond: 10, capacity: 240 },
  /**
   * Transcription, on its own budget.
   *
   * It used to share `speak`, which starves both: one turn issues a partial
   * transcription roughly every 850 ms *and* a synthesis request per spoken
   * chunk, so listening and talking were competing for the same tokens and a
   * normal conversation could rate-limit itself into going deaf.
   */
  transcribe: { refillPerSecond: 8, capacity: 200 },
  config: { refillPerSecond: 2, capacity: 30 },
} as const satisfies Record<string, BucketConfig>

export type LimitName = keyof typeof LIMITS

export function takeToken(
  state: BucketState | undefined,
  config: BucketConfig,
  now: number,
  cost = 1,
): { state: BucketState; decision: RateDecision } {
  const previous = state ?? { tokens: config.capacity, updatedAt: now }
  const elapsed = Math.max(0, now - previous.updatedAt) / 1000
  const tokens = Math.min(config.capacity, previous.tokens + elapsed * config.refillPerSecond)

  if (tokens < cost) {
    return {
      state: { tokens, updatedAt: now },
      decision: {
        allowed: false,
        retryAfter: Math.ceil((cost - tokens) / config.refillPerSecond),
        remaining: Math.floor(tokens),
      },
    }
  }

  return {
    state: { tokens: tokens - cost, updatedAt: now },
    decision: { allowed: true, retryAfter: 0, remaining: Math.floor(tokens - cost) },
  }
}

/**
 * Buckets keyed by caller, swept lazily.
 *
 * The sweep runs on write rather than on a timer so the map cannot outlive the
 * process's usefulness, and so tests never have to wait for one.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>()
  private lastSweep = 0

  constructor(private readonly idleMs = 10 * 60_000) {}

  check(key: string, limit: LimitName, now = Date.now(), cost = 1): RateDecision {
    this.sweep(now)
    const composite = `${limit}:${key}`
    const { state, decision } = takeToken(this.buckets.get(composite), LIMITS[limit], now, cost)
    this.buckets.set(composite, state)
    return decision
  }

  private sweep(now: number) {
    if (now - this.lastSweep < this.idleMs) return
    this.lastSweep = now
    for (const [key, state] of this.buckets) {
      if (now - state.updatedAt > this.idleMs) this.buckets.delete(key)
    }
  }

  get size() {
    return this.buckets.size
  }
}

export const limiter = new RateLimiter()

/**
 * Who is asking, as well as a stateless server can tell.
 *
 * Behind a proxy the socket address is the proxy, so the forwarded chain is
 * preferred — but only its first entry, because everything after it is
 * attacker-supplied. This identifies a caller well enough to rate-limit them;
 * it is not an authentication claim and is never treated as one.
 */
export function callerKey(headers: {
  get: (name: string) => string | null
}, fallback = 'local'): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return headers.get('x-real-ip')?.trim() || headers.get('cf-connecting-ip')?.trim() || fallback
}

function readEnv(name: string): string {
  return process.env[name]?.trim() || ''
}

/**
 * Hosts allowed to open a socket or post a turn.
 *
 * An empty allowlist means "same origin only", resolved against the request's
 * own Host header, which is the correct default for a single-origin app. The
 * env var exists for the case where the page is embedded somewhere else.
 */
export function allowedOrigins(): string[] {
  const configured = readEnv('GIDEON_ALLOWED_ORIGINS')
  if (!configured) return []
  return configured
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

/** Loopback, in the shapes a Host header actually arrives in. */
export function isLocalHost(host: string | null): boolean {
  if (!host) return false
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)(:\d+)?$/i.test(host.trim())
}

/**
 * Whether to meter this request at all.
 *
 * `auto`, the default, means "protect a public deployment and stay out of the
 * way locally". The limiter exists so a public URL is not a free OpenRouter
 * key; on a machine talking to its own server there is nobody to protect
 * against and nothing to gain from getting in the way. `on` and `off` force it
 * either direction for anyone who disagrees.
 */
export function rateLimited(host: string | null): boolean {
  const mode = readEnv('GIDEON_RATE_LIMIT').toLowerCase()
  if (mode === 'off') return false
  if (mode === 'on') return true
  return !isLocalHost(host)
}

/**
 * A missing Origin header is allowed on purpose. Browsers always send one on a
 * cross-origin request, so absence means a same-origin navigation or a non
 * browser client such as a health checker or curl. Rejecting those would break
 * uptime monitoring without stopping anything: a hostile script cannot forge or
 * omit the header from a browser anyway. The rate limiter is what bounds abuse.
 */
export function originAllowed(
  origin: string | null,
  host: string | null,
  /**
   * Demand the header rather than tolerating its absence.
   *
   * The tolerance above is correct for HTTP, where a health checker or curl
   * legitimately sends no Origin. It is wrong for a socket upgrade: the only
   * legitimate client is a browser, browsers always send one, and treating its
   * absence as trustworthy is exactly the hole a command-line client walks
   * through to reach the turn endpoint unmetered.
   */
  requireOrigin = false,
): boolean {
  if (!origin) return !requireOrigin

  let hostname: string
  try {
    hostname = new URL(origin).host
  } catch {
    return false
  }

  if (host && hostname === host) return true
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostname)) return true

  const allowlist = allowedOrigins()
  if (!allowlist.length) return false
  return allowlist.some((entry) => {
    try {
      return new URL(entry).host === hostname
    } catch {
      return entry === hostname
    }
  })
}

/**
 * An optional shared secret for public demos, compared in constant time so the
 * comparison cannot be used to recover the code one character at a time.
 */
export function accessCodeRequired(): boolean {
  return Boolean(readEnv('GIDEON_ACCESS_CODE'))
}

export function accessCodeValid(supplied: string | null): boolean {
  const expected = readEnv('GIDEON_ACCESS_CODE')
  if (!expected) return true
  if (!supplied) return false

  const a = new TextEncoder().encode(expected)
  const b = new TextEncoder().encode(supplied)
  // Length is not secret, but bailing early on it would leak it through timing,
  // so both sides are walked to the same fixed length regardless.
  let diff = a.length ^ b.length
  const span = Math.max(a.length, b.length)
  for (let i = 0; i < span; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

export interface GateResult {
  ok: boolean
  status: number
  code: string
  message: string
  retryAfter: number
}

const PASS: GateResult = { ok: true, status: 200, code: '', message: '', retryAfter: 0 }

/** One check covering origin, access code and rate limit, in that order. */
export function gate(
  request: { headers: { get: (name: string) => string | null } },
  limit: LimitName,
  now = Date.now(),
): GateResult {
  const headers = request.headers

  if (!originAllowed(headers.get('origin'), headers.get('host'))) {
    return {
      ok: false,
      status: 403,
      code: 'origin_rejected',
      message: 'That request came from an origin GIDEON does not answer.',
      retryAfter: 0,
    }
  }

  if (!accessCodeValid(headers.get('x-gideon-access'))) {
    return {
      ok: false,
      status: 401,
      code: 'access_code_required',
      message: 'This GIDEON is behind an access code.',
      retryAfter: 0,
    }
  }

  if (!rateLimited(headers.get('host'))) return PASS

  const decision = limiter.check(callerKey(headers), limit, now)
  if (!decision.allowed) {
    return {
      ok: false,
      status: 429,
      code: 'rate_limited',
      // Reached only by something scripted; a person cannot talk this fast.
      message: 'That is more than this GIDEON is configured to answer. Try again shortly.',
      retryAfter: decision.retryAfter,
    }
  }

  return PASS
}
