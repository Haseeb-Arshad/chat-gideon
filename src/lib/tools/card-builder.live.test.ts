import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { numbersIn } from '../cards'
import { briefBody, buildCard, cardDeps } from './card-builder'
import type { ResearchResult } from './research'

/**
 * Live checks of the card builder, run on purpose with `npm run benchmark:cards`.
 *
 * Skipped in the ordinary suite: they spend real tokens. The briefs are fixed
 * and realistic, so no search is needed; the card model and Wikipedia are real.
 * They answer what no mock can. Does the model pick the right kind of card for
 * the answer, does it decline when there is nothing to show, is the picture
 * the right one, and how long does all of that take beside a spoken answer?
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

const CASES: Array<{ question: string; brief: string; kind: string | null; image: boolean }> = [
  {
    question: 'Who was Albert Einstein?',
    brief:
      'Albert Einstein (14 March 1879 – 18 April 1955) was a German-born theoretical physicist, best known for developing the theory of relativity and the mass-energy equivalence formula E = mc2. He received the 1921 Nobel Prize in Physics for his explanation of the photoelectric effect. He emigrated to the United States in 1933 and worked at the Institute for Advanced Study in Princeton until his death.\nSources: Albert Einstein | Britannica https://www.britannica.com/biography/Albert-Einstein',
    kind: 'entity',
    image: true,
  },
  {
    question: 'Where is the Eiffel Tower and how tall is it?',
    brief:
      "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is 330 metres tall including its antennas, and was completed in 1889 for the World's Fair. It was built by the company of engineer Gustave Eiffel.\nSources: Eiffel Tower | Britannica https://www.britannica.com/topic/Eiffel-Tower-Paris-France",
    kind: 'entity',
    image: true,
  },
  {
    question: "What's the price of bitcoin right now?",
    brief:
      'Bitcoin was trading at $67,420 on 11 September 2026, up 2.1% over the previous 24 hours, according to CoinDesk. Its market capitalisation was about $1.33 trillion.\nSources: Bitcoin price | CoinDesk https://www.coindesk.com/price/bitcoin',
    kind: 'figure',
    image: false,
  },
  {
    question: 'Is it raining in London right now?',
    brief:
      'I could not find a current weather report for London. The most recent forecast I found was published last week, so it does not answer the question.\nSources: Met Office https://www.metoffice.gov.uk',
    kind: null,
    image: false,
  },
]

describe.skipIf(!live)('live cards', () => {
  it('draws the right card, or none, from real briefs', { timeout: 120_000 }, async () => {
    loadEnv()
    const deps = cardDeps((name) => process.env[name]?.trim() || undefined)
    expect(deps.openrouterHeaders, 'OPENROUTER_API_KEY is needed').not.toBeNull()

    for (const { question, brief, kind, image } of CASES) {
      const result: ResearchResult = {
        ok: true,
        brief,
        sources: [{ title: 'Source', url: brief.match(/https:\/\/\S+/)?.[0] ?? 'https://example.org' }],
        via: 'agent',
        model: 'fixed',
        searches: 1,
        ms: 0,
      }
      const startedAt = Date.now()
      const card = await buildCard(question, result, deps, new AbortController().signal)
      report({ question, ms: Date.now() - startedAt, card })

      expect(card?.kind ?? null, question).toBe(kind)
      if (!card) continue
      expect(Boolean(card.image), `${question}: image`).toBe(image)
      // Nothing on the card may state a number the brief did not.
      const known = new Set(numbersIn(briefBody(brief)).flatMap((n) => [n, n.split('.')[0]]))
      const shown = [card.title, card.subtitle, card.summary, card.figure?.value ?? '', ...card.facts.map((f) => f.value)]
      for (const number of shown.flatMap(numbersIn)) expect(known.has(number), `${question}: ${number}`).toBe(true)
    }
  })
})
