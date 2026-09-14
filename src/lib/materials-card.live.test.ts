import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { streamTurn } from './agent-core'
import type { ServerFrame } from './protocol'

/**
 * Cards from figures and records, through the real models and the real data
 * sources, run on purpose with
 * `npx vitest run src/lib/materials-card.live.test.ts --mode live`.
 *
 * Skipped in the ordinary suite: it spends OpenRouter credit (three turns cost
 * a few cents) and needs OPENROUTER_API_KEY and EXA_API_KEY. It answers what no
 * mock can: does the research model reach for the data tools when a question
 * calls for them, what card does that draw, and how long after the tool call
 * does it arrive?
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

const QUESTIONS: Array<{ question: string; recipe: string; source: string }> = [
  { question: "How has Japan's population changed since 1960?", recipe: 'trend', source: 'api.worldbank.org' },
  { question: 'Who was Marie Curie?', recipe: 'profile', source: 'wikidata.org' },
  { question: 'Compare GDP per person in Germany and France over time', recipe: 'compare', source: 'api.worldbank.org' },
]

describe.skipIf(!live)('live cards from figures and records', () => {
  it('reaches for the data tools and draws the card they make', { timeout: 240_000 }, async () => {
    loadEnv()
    process.env.GIDEON_MEMORY_PATH = 'none'
    const real = globalThis.fetch
    const results: Array<{ question: string; ok: boolean }> = []

    for (const { question, recipe, source } of QUESTIONS) {
      const hosts = new Set<string>()
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        try {
          hosts.add(new URL(String(input)).hostname)
        } catch {
          // Not a URL worth recording.
        }
        return real(input, init)
      }) as typeof fetch

      const startedAt = Date.now()
      const at: Record<string, number> = {}
      const frames: ServerFrame[] = []
      let spoken = ''
      try {
        for await (const frame of streamTurn('live', [{ role: 'user', content: question }], new AbortController().signal, { timezone: 'Europe/London' })) {
          frames.push(frame)
          const ms = Date.now() - startedAt
          if (frame.t === 'action' && frame.pending) at.toolCalled ??= ms
          if (frame.t === 'action' && !frame.pending) at.briefReady ??= ms
          if (frame.t === 'delta') {
            at.firstWord ??= ms
            spoken += frame.text
          }
          if (frame.t === 'done') at.done = ms
          if (frame.t === 'card') at.card = ms
          if (frame.t === 'card_patch') at.patch = ms
        }
      } finally {
        globalThis.fetch = real
      }

      const card = frames.find((frame) => frame.t === 'card')
      const patch = frames.find((frame) => frame.t === 'card_patch')
      const drawn = card?.t === 'card' ? card.card : null
      report({
        question,
        dataSources: [...hosts].filter((host) => host.includes('worldbank') || host.includes('wikidata') || host.includes('wikipedia')),
        ms: at,
        recipe: drawn?.recipe,
        size: drawn?.size,
        title: drawn?.title,
        blocks: drawn?.blocks.map((block) => block.type),
        patch: patch?.t === 'card_patch' ? patch.blocks.map((block) => block.type) : null,
        spoken: spoken.slice(0, 280),
      })
      results.push({ question, ok: drawn?.recipe === recipe && [...hosts].some((host) => host.includes(source.replace('api.', ''))) })
    }

    // Soft, so one question the model routed differently does not hide how the others went.
    for (const result of results) expect.soft(result.ok, result.question).toBe(true)
  })
})
