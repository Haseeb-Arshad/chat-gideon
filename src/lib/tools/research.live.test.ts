import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { streamTurn } from '../agent-core'
import { defaultDeps, research, type ResearchDeps } from './research'

/**
 * Live checks, run on purpose with `npm run benchmark:research`.
 *
 * Skipped in the ordinary suite: they spend real money and need real keys.
 * They answer the two questions no mock can. Does the conversational model
 * send questions about the world to research, and keep everything else to
 * itself? And how long does the research desk actually take? With
 * EXA_API_KEY set the desk searches the live web; without it, Exa is replaced
 * by a fixed page so the model loop can still be timed.
 */

const live = import.meta.env.MODE === 'live'

function loadEnv() {
  if (!existsSync('.env')) return
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at < 1 || line.startsWith('#')) continue
    const name = line.slice(0, at).trim()
    process.env[name] ??= line.slice(at + 1).trim()
  }
}

function report(row: Record<string, unknown>) {
  process.stdout.write(`LIVE ${JSON.stringify(row)}\n`)
}

const ROUTING: Array<[question: string, researches: boolean]> = [
  ["what's the weather in London today", true],
  ['who won the most recent Formula 1 race', true],
  ["what's the price of bitcoin right now", true],
  ["what's twelve times eight", false],
  ['tell me a joke about cats', false],
  ['how are you doing', false],
]

describe.skipIf(!live)('live research', () => {
  it('sends questions about the world to research, and nothing else', { timeout: 120_000 }, async () => {
    loadEnv()
    process.env.GIDEON_MEMORY_PATH = 'none'
    process.env.EXA_API_KEY ||= 'routing-probe'

    // Only the speaking model is real here. The research it asks for is
    // answered with a fixed brief, so this measures routing and nothing else.
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (String(input).includes('openrouter.ai') && body.stream === true) return real(input, init)
      return Response.json({ choices: [{ message: { content: 'A fixed brief for routing.' } }] })
    }) as typeof fetch

    const wrong: string[] = []
    try {
      for (const [question, expected] of ROUTING) {
        let researched = false
        for await (const frame of streamTurn('live', [{ role: 'user', content: question }], new AbortController().signal, {
          timezone: 'Europe/London',
        })) {
          if (frame.t === 'action' && frame.name === 'research') researched = true
        }
        report({ question, expected, researched })
        if (researched !== expected) wrong.push(question)
      }
    } finally {
      globalThis.fetch = real
    }
    expect(wrong).toEqual([])
  })

  it('times the research desk', { timeout: 180_000 }, async () => {
    loadEnv()
    const env = (name: string) => process.env[name]?.trim() || undefined
    const stubbed = !env('EXA_API_KEY') || env('EXA_API_KEY') === 'routing-probe'
    const base = defaultDeps(env)
    const today = new Date().toLocaleDateString('en-GB', { dateStyle: 'full', timeZone: 'Europe/London' })
    const deps: ResearchDeps = {
      ...base,
      exaKey: stubbed ? 'stub' : base.exaKey,
      fetch: stubbed
        ? async (input, init) =>
            String(input).includes('api.exa.ai')
              ? Response.json({
                  results: [
                    {
                      title: 'Met Office: London',
                      url: 'https://weather.example.org/london',
                      publishedDate: new Date().toISOString(),
                      highlights: [`London, ${today}: light rain clearing, high of 17C, low of 11C.`],
                    },
                  ],
                })
              : globalThis.fetch(input, init)
        : base.fetch,
    }

    for (const question of ["what's the weather like in London today", 'who is the CEO of Microsoft']) {
      for (let rep = 0; rep < 2; rep += 1) {
        const result = await research(question, { signal: new AbortController().signal, timezone: 'Europe/London' }, deps, null)
        report({
          question,
          exa: stubbed ? 'stub' : 'live',
          effort: deps.effort,
          ok: result.ok,
          via: result.via,
          model: result.model,
          searches: result.searches,
          ms: result.ms,
          brief: result.brief.split('\n')[0].slice(0, 100),
        })
        expect(result.ok).toBe(true)
      }
    }
  })
})
