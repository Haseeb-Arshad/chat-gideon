/**
 * What stands between a public URL and someone else's OpenRouter bill.
 *
 * GIDEON's endpoints are unauthenticated by design: the whole point is that you
 * open the page and talk. That is fine on localhost and reckless in public, so
 * the same routes carry a token bucket and an origin check.
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
import { runtimeEnv } from './runtime-env'

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
  /**
   * Making sure a caller has an account. A page asks once as it loads, so
   * someone reloading as fast as they can stays well inside this; filling the
   * database with empty accounts would take a script.
   */
  account: { refillPerSecond: 0.2, capacity: 20 },
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

const LIMITER = Symbol.for('gideon.rate-limiter.v1')
const globals = globalThis as typeof globalThis & { [LIMITER]?: RateLimiter }
export const limiter = globals[LIMITER] ??= new RateLimiter()

/**
 * Who is asking, as well as a stateless server can tell.
 *
 * `x-forwarded-for` is client-supplied on almost every deployment, so trusting
 * it lets anyone rotate their rate-limit identity per request. It is honoured
 * only when the TCP peer address itself is a trusted proxy, and only its last
 * entry — the one the trusted proxy appended — is believed. Everything else
 * falls back to platform-ingress headers, and finally to the address the host
 * actually saw. This identifies a caller well enough to rate-limit them; it is
 * not an authentication claim and is never treated as one.
 */
export function trustedProxies(): string[] {
  const configured = readEnv('GIDEON_TRUSTED_PROXIES')
  if (!configured) return []
  return configured.split(',').map((value) => value.trim()).filter(Boolean)
}

/** True when `address` is a trusted proxy or the request came from the host itself. */
export function isTrustedAddress(address: string | null | undefined): boolean {
  if (!address) return false
  const value = address.trim().toLowerCase().replace(/^::ffff:/, '')
  if (!value) return false
  // Trust is opt-in, including loopback: a local direct client can set XFF too.
  return trustedProxies().some((proxy) => {
    const candidate = proxy.toLowerCase().replace(/^::ffff:/, '')
    // A bare /8, /16 or /32 word is treated as an exact address; anything with
    // a prefix length is compared numerically.
    const [network, bits] = candidate.split('/')
    if (bits === undefined) return network === value
    if (!/^\d+$/.test(bits)) return false
    const prefix = Number(bits)
    return sameNetwork(value, network, prefix)
  })
}

/** Compares the leading `prefix` bits of two IPv4 or IPv6 addresses. */
export function sameNetwork(address: string, network: string, prefix: number): boolean {
  const parse = (value: string): bigint | null => {
    const clean = value.toLowerCase().replace(/^::ffff:/, '')
    if (clean.includes(':')) {
      const sections = clean.split('::')
      if (sections.length > 2) return null
      const head = sections[0] ? sections[0].split(':') : []
      const tail = sections[1] ? sections[1].split(':') : []
      const missing = 8 - head.length - tail.length
      if (sections.length === 2 ? missing < 0 : head.length !== 8) return null
      const words = [...head, ...Array.from({ length: Math.max(missing, 0) }, () => '0'), ...tail]
      if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null
      return words.reduce((sum, word) => (sum << 16n) + BigInt(parseInt(word, 16)), 0n)
    }
    const octets = clean.split('.')
    if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null
    return octets.reduce((sum, octet) => (sum << 8n) + BigInt(Number(octet)), 0n)
  }

  if (!Number.isInteger(prefix) || prefix < 0) return false
  const normalAddress = address.replace(/^::ffff:/i, '')
  const normalNetwork = network.replace(/^::ffff:/i, '')
  if (normalAddress.includes(':') !== normalNetwork.includes(':')) return false
  const left = parse(normalAddress)
  const right = parse(normalNetwork)
  if (left === null || right === null) return false
  const width = normalAddress.includes(':') ? 128n : 32n
  const bits = BigInt(prefix)
  if (bits > width) return false
  if (bits === 0n) return true
  const shift = width - bits
  return left >> shift === right >> shift
}

/**
 * The caller a rate-limit bucket is filed under.
 *
 * Platform ingress headers (Cloudflare's `cf-connecting-ip`) win, because that
 * platform stripped any client copy before we saw the request. The forwarded
 * chain is read only from a trusted proxy, and only its last entry — the one
 * that proxy itself appended — is believed.
 */
export function callerKey(
  headers: { get: (name: string) => string | null },
  fallback = 'local',
  /** Which ingress headers may be trusted: who terminated the TLS in front of us. */
  ingress: 'none' | 'cloudflare' = 'none',
  /** The socket's peer address, when the host can see it. */
  remoteAddress?: string | null,
): string {
  if (remoteAddress && isTrustedAddress(remoteAddress)) {
    const forwarded = headers.get('x-forwarded-for')
    if (forwarded) {
      const last = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean).pop()
      if (last) return last
    }
  }
  if (ingress === 'cloudflare') {
    const connecting = headers.get('cf-connecting-ip')?.trim()
    if (connecting) return connecting
  }
  if (remoteAddress) return remoteAddress
  return fallback
}

function readEnv(name: string): string {
  return runtimeEnv(name) || process.env[name]?.trim() || ''
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
 * Whether the request arrived from the machine itself, judged on the socket's
 * peer address — never on a header, which any client can set.
 */
export function isLocalRequest(remoteAddress: string | null | undefined): boolean {
  return Boolean(remoteAddress) && isLocalHost(remoteAddress ? String(remoteAddress) : null)
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
  requireOrigin = false,
): boolean {
  if (!origin) return !requireOrigin
  try {
    const source = new URL(origin)
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin) return false
    // Callers should pass the full trusted request URL. Bare hosts remain a
    // secure-by-default compatibility form: public hosts mean HTTPS.
    const target = host
      ? new URL(host.includes('://') ? host : `${/^(\[::1\]|::1|127\.|localhost)/i.test(host) ? 'http' : 'https'}://${host}`)
      : null
    if (target && source.origin === target.origin) return true
    // Development exceptions apply only when both ends are local.
    if (target && isLocalHost(target.host) && isLocalHost(source.host) && source.protocol === target.protocol) return true
    return allowedOrigins().some((entry) => {
      try { return new URL(entry).origin === source.origin } catch { return false }
    })
  } catch { return false }
}

export interface GateResult {
  ok: boolean
  status: number
  code: string
  message: string
  retryAfter: number
}

const PASS: GateResult = { ok: true, status: 200, code: '', message: '', retryAfter: 0 }

/** One check covering origin and rate limit, in that order. */
export function gate(
  request: { url?: string; headers: { get: (name: string) => string | null } },
  limit: LimitName,
  now = Date.now(),
  ingress: 'none' | 'cloudflare' = 'none',
): GateResult {
  const headers = request.headers

  if (!originAllowed(headers.get('origin'), request.url ?? headers.get('host'))) {
    return {
      ok: false,
      status: 403,
      code: 'origin_rejected',
      message: 'That request came from an origin GIDEON does not answer.',
      retryAfter: 0,
    }
  }

  // Framework Request does not expose a trusted peer address. Never disable
  // public limits based on the client-controlled Host header alone.
  if (!rateLimited(request.url ? null : headers.get('host'))) return PASS

  const decision = limiter.check(callerKey(headers, 'local', ingress), limit, now)
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
