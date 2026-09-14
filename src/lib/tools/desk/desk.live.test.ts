import { describe, expect, it } from 'vitest'
import { countryData } from './world-bank'
import { entityFacts } from './wikidata'

/**
 * The desk's data sources against the live services, run on purpose with
 * `npx vitest run src/lib/tools/desk/desk.live.test.ts --mode live`.
 *
 * Skipped in the ordinary suite because it needs the network. Neither service
 * needs a key or costs anything. It answers what fixtures cannot: whether the
 * responses still have the shape the parsers expect, and how long a lookup
 * takes beside a research run.
 */

const live = import.meta.env.MODE === 'live'
const deps = { fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init), now: Date.now }
const signal = () => new AbortController().signal

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
})
