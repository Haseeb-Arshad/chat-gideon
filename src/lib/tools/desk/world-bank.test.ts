import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INDICATORS, countryData, describeSeries, forgetWorldBank, sayValue, type WorldBankDeps } from './world-bank'

/**
 * The World Bank source, against responses shaped exactly like the live API's:
 * a page header and a list of rows, a message in place of the header when a
 * code is unknown, and null values for years with no figure.
 */

const NOW = Date.UTC(2026, 8, 14)

function row(iso3: string, iso2: string, name: string, year: number, value: number | null) {
  return {
    indicator: { id: 'SP.POP.TOTL', value: 'Population, total' },
    country: { id: iso2, value: name },
    countryiso3code: iso3,
    date: String(year),
    value,
  }
}

const JAPAN = [
  row('JPN', 'JP', 'Japan', 2025, 123366734.4),
  row('JPN', 'JP', 'Japan', 2008, 128105431),
  row('JPN', 'JP', 'Japan', 1970, 104665171),
  row('JPN', 'JP', 'Japan', 1960, 93216000),
  row('JPN', 'JP', 'Japan', 1961, null),
]
const KOREA = [row('KOR', 'KR', 'Korea, Rep.', 1960, 25012374), row('KOR', 'KR', 'Korea, Rep.', 2025, 51664311)]

const INVALID = [{ message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] }]
const header = { page: 1, pages: 1, per_page: 1000, total: 1 }

function world(answer: (codes: string[]) => unknown) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const codes = decodeURIComponent(url.match(/country\/([^/]+)\/indicator/)![1]).split(';')
    return Response.json(answer(codes))
  })
  const deps: WorldBankDeps = { fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW }
  return { fetch, deps }
}

const live = () => new AbortController().signal

beforeEach(() => forgetWorldBank())

describe('countryData', () => {
  it('turns rows into one series per country, oldest first, without the empty years', async () => {
    const { fetch, deps } = world(() => [header, [...JAPAN, ...KOREA]])
    const result = await countryData({ countries: ['jpn', 'KOR'], indicator: 'population' }, deps, live())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const url = String(fetch.mock.calls[0][0])
    expect(url).toContain('/country/JPN;KOR/indicator/SP.POP.TOTL')
    expect(url).toContain('date=1960:2026')

    const [japan, korea] = result.materials
    expect(japan).toMatchObject({
      id: 'worldbank:population:JPN',
      kind: 'series',
      measure: 'worldbank:population',
      name: 'Population',
      subject: 'Japan',
      unit: '',
      source: { title: 'World Bank', url: 'https://data.worldbank.org/indicator/SP.POP.TOTL?locations=JP' },
    })
    // Rounded to the indicator's places, so the card and the brief agree.
    expect(japan.points).toEqual([
      { x: '1960', value: 93216000 },
      { x: '1970', value: 104665171 },
      { x: '2008', value: 128105431 },
      { x: '2025', value: 123366734 },
    ])
    // Filed by the World Bank as "Korea, Rep.", and called what people call it.
    expect(korea.subject).toBe('South Korea')
    expect(result.text).toContain('World Bank · Population')
    expect(result.text).toContain("shown on the user's screen as a chart")
  })

  it('tries each country alone when one code sinks the combined request, and names the one it does not know', async () => {
    const { fetch, deps } = world((codes) => (codes.includes('XYZ') ? INVALID : [header, JAPAN]))
    const result = await countryData({ countries: ['JPN', 'XYZ'], indicator: 'population' }, deps, live())
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(result.ok && result.materials.map((series) => series.subject)).toEqual(['Japan'])
    expect(result.text).toContain('does not recognise XYZ')
  })

  it('says which countries have no figures, and fails when none do', async () => {
    let { deps } = world(() => [{ ...header, total: 0 }, null])
    const empty = await countryData({ countries: ['TWN'], indicator: 'gdp' }, deps, live())
    expect(empty).toEqual({ ok: false, text: expect.stringContaining('It has no gdp figures for TWN') })

    forgetWorldBank()
    ;({ deps } = world(() => [header, JAPAN]))
    const partial = await countryData({ countries: ['JPN', 'TWN'], indicator: 'population' }, deps, live())
    expect(partial.ok).toBe(true)
    expect(partial.text).toContain('It has no population figures for TWN')
  })

  it('refuses what it cannot ask for, before asking', async () => {
    const { fetch, deps } = world(() => [header, JAPAN])
    expect((await countryData({ countries: ['JPN'], indicator: 'happiness' }, deps, live())).text).toContain(
      'There is no indicator called happiness',
    )
    expect((await countryData({ countries: ['Japan'], indicator: 'gdp' }, deps, live())).text).toContain('three-letter ISO code')
    const six = ['JPN', 'KOR', 'CHN', 'IND', 'USA', 'GBR']
    expect((await countryData({ countries: six, indicator: 'gdp' }, deps, live())).text).toContain('at most 5')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks once for the same figures, however many turns want them', async () => {
    const { fetch, deps } = world(() => [header, JAPAN])
    await Promise.all([
      countryData({ countries: ['JPN'], indicator: 'population' }, deps, live()),
      countryData({ countries: ['jpn'], indicator: 'population' }, deps, live()),
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('says it could not reach the World Bank rather than throwing, and a failure is not remembered', async () => {
    const fetch = vi.fn(async () => new Response('down', { status: 503 }))
    const deps: WorldBankDeps = { fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW }
    const first = await countryData({ countries: ['JPN'], indicator: 'population' }, deps, live())
    expect(first).toEqual({ ok: false, text: expect.stringContaining('could not be reached') })
    await countryData({ countries: ['JPN'], indicator: 'population' }, deps, live())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stops waiting when the run is let go', async () => {
    const { deps } = world(() => new Promise(() => undefined))
    const controller = new AbortController()
    const pending = countryData({ countries: ['JPN'], indicator: 'population' }, deps, controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
  })
})

describe('saying values', () => {
  it('writes money in billions and trillions, and a percent sign unspaced', () => {
    expect(sayValue(4213000000000, INDICATORS.gdp)).toBe('US$4.21 trillion')
    expect(sayValue(52300000000, INDICATORS.gdp)).toBe('US$52.30 billion')
    expect(sayValue(34064, INDICATORS.gdp_per_person)).toBe('US$34,064')
    expect(sayValue(2.6, INDICATORS.inflation)).toBe('2.6%')
    expect(sayValue(84.1, INDICATORS.life_expectancy)).toBe('84.1 years')
  })

  it('describes a long series by its tens, its ends, its peak and its low', () => {
    const points = Array.from({ length: 66 }, (_, index) => ({ x: String(1960 + index), value: 100 + index }))
    points[48].value = 500
    const text = describeSeries(
      { id: 'x', kind: 'series', measure: 'm', name: 'Population', subject: 'Japan', unit: '', points, source: { title: '', url: '', fetchedAt: '' } },
      INDICATORS.population,
    )
    expect(text).toBe(
      'Japan, 1960 to 2025: 1960 100 · 1970 110 · 1980 120 · 1990 130 · 2000 140 · 2010 150 · 2020 160 · 2025 165. Highest 500 in 2008; lowest 100 in 1960.',
    )
  })
})
