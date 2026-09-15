import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { choosePlace, forgetWeather, openMeteo, runWeather } from '../weather'
import { forgetNews, topStories } from './news'
import { countryData } from './world-bank'
import { entityFacts } from './wikidata'

/**
 * The desk's data sources against the live services, run on purpose with
 * `npx vitest run src/lib/tools/desk/desk.live.test.ts --mode live`.
 *
 * Skipped in the ordinary suite because it needs the network. The World Bank,
 * Wikidata and Open-Meteo need no key and cost nothing; the news is one Exa
 * search, and needs EXA_API_KEY. It answers what fixtures cannot: whether the responses
 * still have the shape the parsers expect, and how long a lookup takes beside
 * a research run.
 */

const live = import.meta.env.MODE === 'live'
const deps = { fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init), now: Date.now }
const signal = () => new AbortController().signal

/** A key from the environment, or from .env when the tests were started without it. */
function key(name: string): string {
  if (process.env[name]) return process.env[name]
  if (!existsSync('.env')) return ''
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((each) => each.startsWith(`${name}=`))
  return line ? line.slice(name.length + 1).trim() : ''
}

function report(row: Record<string, unknown>) {
  process.stdout.write(`LIVE ${JSON.stringify(row)}\n`)
}

describe.skipIf(!live)('live desk data', () => {
  it('reads the World Bank', { timeout: 60_000 }, async () => {
    const startedAt = Date.now()
    const result = await countryData({ countries: ['JPN', 'KOR', 'XYZ'], indicator: 'population' }, deps, signal())
    report({ source: 'worldbank', ms: Date.now() - startedAt, ok: result.ok, text: result.text.slice(0, 400) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const japan = result.materials.find((series) => series.subject === 'Japan')!
    expect(japan.points.length).toBeGreaterThan(50)
    expect(japan.points[0].x).toBe('1960')
    expect(japan.points.every((point, index, all) => index === 0 || Number(point.x) > Number(all[index - 1].x))).toBe(true)
    expect(result.text).toContain('does not recognise XYZ')
  })

  it('reads Wikidata for a person, a country, an organisation and a building', { timeout: 60_000 }, async () => {
    for (const title of ['Marie Curie', 'Japan', 'Microsoft', 'Eiffel Tower']) {
      const startedAt = Date.now()
      const result = await entityFacts({ titles: [title] }, deps, signal())
      const record = result.ok ? result.materials[0] : null
      report({ source: 'wikidata', title, ms: Date.now() - startedAt, type: record?.type, fields: record?.fields, events: record?.events.map((event) => `${event.date} ${event.label}`) })
      expect(record?.subject, title).toBeTruthy()
      expect(record!.fields.length, title).toBeGreaterThanOrEqual(3)
    }
  })

  it('reads the forecast for a place, and asks which Springfield', { timeout: 60_000 }, async () => {
    forgetWeather()
    const provider = openMeteo(deps)
    const lisbon = choosePlace('Lisbon', await provider.places('Lisbon', signal()))
    expect(lisbon && 'place' in lisbon ? lisbon.place.country : null).toBe('Portugal')

    for (const place of ['Lisbon', 'Bergen, Norway']) {
      const startedAt = Date.now()
      const outcome = await runWeather({ place, day: 'tomorrow' }, { signal: signal(), timezone: 'Europe/London' }, provider, Date.now())
      const card = await outcome.card
      const forecast = card?.blocks.find((block) => block.type === 'forecast')
      report({ source: 'open-meteo', place, ms: Date.now() - startedAt, ok: outcome.ok, summary: outcome.summary, brief: outcome.content.split('\n').slice(0, 3) })
      expect(outcome.ok, place).toBe(true)
      expect(forecast?.type === 'forecast' ? [forecast.hours.length, forecast.days.length] : null, place).toEqual([24, 7])
    }

    const springfield = await runWeather({ place: 'Springfield' }, { signal: signal(), timezone: 'Europe/London' }, provider, Date.now())
    expect(springfield.content).toMatch(/^Springfield could be /)
  })

  it("reads the day's news, and a topic's", { timeout: 60_000 }, async () => {
    const exaKey = key('EXA_API_KEY')
    expect(exaKey, 'EXA_API_KEY').toBeTruthy()
    forgetNews()
    for (const topic of ['', 'technology']) {
      const startedAt = Date.now()
      const result = await topStories({ topic }, { ...deps, exaKey }, signal())
      const stories = result.ok ? result.materials[0].items : []
      report({
        source: 'exa news',
        topic,
        ms: Date.now() - startedAt,
        stories: stories.map((story) => ({ headline: story.headline, host: story.host, published: story.published, outlets: story.outlets, image: Boolean(story.image), deck: story.deck })),
      })
      expect(stories.length, topic || 'headlines').toBeGreaterThanOrEqual(3)
      for (const story of stories) {
        expect(story.url).toMatch(/^https:\/\//)
        expect(story.deck.split(/\s+/).length).toBeLessThanOrEqual(30)
      }
    }
  })
})
