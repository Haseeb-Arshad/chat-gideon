import { afterEach, describe, expect, it } from 'vitest'
import {
  LIMITS,
  RateLimiter,
  accessCodeValid,
  callerKey,
  gate,
  isLocalHost,
  originAllowed,
  rateLimited,
  takeToken,
} from './guard'

function headers(values: Record<string, string>) {
  const map = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]))
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null }
}

const ENV_KEYS = ['GIDEON_ACCESS_CODE', 'GIDEON_ALLOWED_ORIGINS', 'GIDEON_RATE_LIMIT'] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

describe('takeToken', () => {
  const config = { refillPerSecond: 1, capacity: 3 }

  it('starts full and spends down', () => {
    let state = undefined
    for (let i = 0; i < 3; i += 1) {
      const result = takeToken(state, config, 1_000)
      expect(result.decision.allowed).toBe(true)
      state = result.state
    }
    expect(takeToken(state, config, 1_000).decision.allowed).toBe(false)
  })

  it('refills at the configured rate, not in one jump', () => {
    const drained = { tokens: 0, updatedAt: 0 }
    expect(takeToken(drained, config, 500).decision.allowed).toBe(false)
    expect(takeToken(drained, config, 1_000).decision.allowed).toBe(true)
  })

  it('never refills above capacity', () => {
    const idle = { tokens: 0, updatedAt: 0 }
    const result = takeToken(idle, config, 10 * 60_000)
    expect(result.state.tokens).toBe(config.capacity - 1)
  })

  it('reports how long to wait', () => {
    const drained = { tokens: 0, updatedAt: 0 }
    expect(takeToken(drained, { refillPerSecond: 0.5, capacity: 4 }, 0).decision.retryAfter).toBe(2)
  })
})

describe('RateLimiter', () => {
  it('keeps separate budgets per caller and per surface', () => {
    const limiter = new RateLimiter()
    const now = 1_000
    for (let i = 0; i < LIMITS.turn.capacity; i += 1) {
      expect(limiter.check('a', 'turn', now).allowed).toBe(true)
    }
    expect(limiter.check('a', 'turn', now).allowed).toBe(false)
    // A different caller, and a different surface for the same caller, are both
    // untouched by one exhausted bucket.
    expect(limiter.check('b', 'turn', now).allowed).toBe(true)
    expect(limiter.check('a', 'speak', now).allowed).toBe(true)
  })

  it('drops buckets that have gone quiet', () => {
    const limiter = new RateLimiter(1_000)
    limiter.check('a', 'turn', 0)
    expect(limiter.size).toBe(1)
    limiter.check('b', 'turn', 5_000)
    expect(limiter.size).toBe(1)
  })
})

describe('callerKey', () => {
  it('trusts only the first hop of a forwarded chain', () => {
    expect(callerKey(headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }))).toBe(
      '203.0.113.7',
    )
  })

  it('falls back through the other proxy headers', () => {
    expect(callerKey(headers({ 'cf-connecting-ip': '198.51.100.4' }))).toBe('198.51.100.4')
    expect(callerKey(headers({}))).toBe('local')
  })
})

describe('originAllowed', () => {
  it('allows a same-origin request', () => {
    expect(originAllowed('https://gideon.example', 'gideon.example')).toBe(true)
  })

  it('allows localhost on any port', () => {
    expect(originAllowed('http://localhost:3000', 'gideon.example')).toBe(true)
    expect(originAllowed('http://127.0.0.1:5173', 'gideon.example')).toBe(true)
  })

  it('rejects an unlisted cross origin', () => {
    expect(originAllowed('https://evil.example', 'gideon.example')).toBe(false)
  })

  it('honours the configured allowlist', () => {
    process.env.GIDEON_ALLOWED_ORIGINS = 'https://portfolio.example/'
    expect(originAllowed('https://portfolio.example', 'gideon.example')).toBe(true)
    expect(originAllowed('https://other.example', 'gideon.example')).toBe(false)
  })

  it('lets a header-less client through, since only browsers guarantee one', () => {
    expect(originAllowed(null, 'gideon.example')).toBe(true)
  })

  it('demands the header when asked, which is what a socket upgrade needs', () => {
    // The tolerance above is right for HTTP health checks and wrong for a
    // socket: a command-line client sending no Origin was the one way to reach
    // the turn endpoint without passing any check at all.
    expect(originAllowed(null, 'gideon.example', true)).toBe(false)
    expect(originAllowed('https://gideon.example', 'gideon.example', true)).toBe(true)
  })

  it('rejects an unparseable origin rather than guessing', () => {
    expect(originAllowed('not a url', 'gideon.example')).toBe(false)
  })
})

describe('accessCodeValid', () => {
  it('is open when no code is configured', () => {
    expect(accessCodeValid(null)).toBe(true)
  })

  it('accepts only the exact code', () => {
    process.env.GIDEON_ACCESS_CODE = 'open-sesame'
    expect(accessCodeValid('open-sesame')).toBe(true)
    expect(accessCodeValid('open-sesam')).toBe(false)
    expect(accessCodeValid('open-sesame ')).toBe(false)
    expect(accessCodeValid(null)).toBe(false)
  })
})

describe('isLocalHost', () => {
  it('recognises loopback in the shapes a Host header uses', () => {
    for (const host of ['localhost', 'localhost:3000', '127.0.0.1:8080', '[::1]:3000', '::1']) {
      expect(isLocalHost(host)).toBe(true)
    }
  })

  it('does not mistake a real host for loopback', () => {
    for (const host of ['gideon.example', 'localhost.evil.example', '10.0.0.4', null]) {
      expect(isLocalHost(host)).toBe(false)
    }
  })
})

describe('rateLimited', () => {
  it('stays out of the way on localhost by default', () => {
    expect(rateLimited('localhost:3000')).toBe(false)
  })

  it('protects a public host by default', () => {
    expect(rateLimited('gideon.example')).toBe(true)
  })

  it('can be forced either way', () => {
    process.env.GIDEON_RATE_LIMIT = 'on'
    expect(rateLimited('localhost:3000')).toBe(true)
    process.env.GIDEON_RATE_LIMIT = 'off'
    expect(rateLimited('gideon.example')).toBe(false)
  })
})

describe('LIMITS', () => {
  it('sits above what a person could produce by talking', () => {
    /*
     * The regression this pins: `turn` was 8 with a refill of one every two
     * seconds, and since every barge-in starts a fresh turn, interrupting a
     * few times in a row hit the limit and GIDEON refused to answer. These
     * ceilings exist to stop a script, and a script is the only thing that can
     * reach them.
     */
    // Ten interruptions inside ten seconds is frantic but human.
    const limiter = new RateLimiter()
    const start = 10_000
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.check('me', 'turn', start + i * 1_000).allowed).toBe(true)
    }

    // A minute of hard conversation: a turn every three seconds, each with a
    // dozen spoken chunks and a partial transcription every 850 ms.
    for (let turn = 0; turn < 20; turn += 1) {
      const at = start + turn * 3_000
      expect(limiter.check('me', 'turn', at).allowed).toBe(true)
      for (let chunk = 0; chunk < 12; chunk += 1) {
        expect(limiter.check('me', 'speak', at + chunk * 60).allowed).toBe(true)
      }
      for (let partial = 0; partial < 4; partial += 1) {
        expect(limiter.check('me', 'transcribe', at + partial * 850).allowed).toBe(true)
      }
    }
  })

  it('still refuses a script hammering one surface', () => {
    const limiter = new RateLimiter()
    let refused = false
    for (let i = 0; i < LIMITS.turn.capacity + 5; i += 1) {
      if (!limiter.check('bot', 'turn', 1_000).allowed) refused = true
    }
    expect(refused).toBe(true)
  })
})

describe('gate', () => {
  it('rejects a bad origin before spending a token', () => {
    const request = { headers: headers({ origin: 'https://evil.example', host: 'gideon.example' }) }
    const result = gate(request, 'turn')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('origin_rejected')
    expect(result.status).toBe(403)
  })

  it('demands the access code when one is set', () => {
    process.env.GIDEON_ACCESS_CODE = 'secret'
    const request = { headers: headers({ host: 'gideon.example' }) }
    expect(gate(request, 'turn').code).toBe('access_code_required')
  })

  it('passes a well-formed same-origin request', () => {
    const request = {
      headers: headers({ origin: 'https://gideon.example', host: 'gideon.example' }),
    }
    expect(gate(request, 'config').ok).toBe(true)
  })

  it('does not meter a local request at all', () => {
    const request = { headers: headers({ host: 'localhost:3000' }) }
    // Far past every bucket; a machine talking to its own server is not a
    // threat to itself.
    for (let i = 0; i < LIMITS.turn.capacity * 3; i += 1) {
      expect(gate(request, 'turn').ok).toBe(true)
    }
  })

  it('still applies the access code locally, which is not about volume', () => {
    process.env.GIDEON_ACCESS_CODE = 'secret'
    const request = { headers: headers({ host: 'localhost:3000' }) }
    expect(gate(request, 'turn').code).toBe('access_code_required')
  })
})
