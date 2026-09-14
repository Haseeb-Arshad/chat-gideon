/**
 * Yearly figures for countries, from the World Bank's open data API.
 *
 * A chart needs numbers nobody would read aloud, and a brief of 180 words has
 * room for three of them. So when a question is about a country's population,
 * economy or health over time, the research desk asks here, gets the whole
 * series as a material the card can draw from exactly, and is told a handful
 * of the same numbers in words to write the brief with.
 *
 * The indicators are a fixed list rather than any code the model can name. The
 * World Bank publishes some sixteen thousand of them, retires codes without
 * warning (the old CO2 series went in 2024), and a model's memory of their
 * codes is exactly the kind of recall this desk exists not to trust. Each one
 * here was checked against the live API on 14 September 2026.
 *
 * No key, CC BY 4.0, credited on the card.
 */

import type { SeriesMaterial } from '../../cards/materials'
import { TimedCache } from './cache'

const API = 'https://api.worldbank.org/v2'
const TIMEOUT_MS = 6_000
const FIRST_YEAR = 1960
/** A comparison chart holds five lines at most, so a request does too. */
export const MAX_COUNTRIES = 5

export interface Indicator {
  code: string
  /** What the chart is titled. */
  name: string
  /** Said with each value: '%' after it, 'US$' as a dollar sign before it. */
  unit: string
  /** Places kept, so the card and the brief show the same figure. */
  decimals: number
}

export const INDICATORS = {
  population: { code: 'SP.POP.TOTL', name: 'Population', unit: '', decimals: 0 },
  population_growth: { code: 'SP.POP.GROW', name: 'Population growth', unit: '%', decimals: 2 },
  aged_65_and_over: { code: 'SP.POP.65UP.TO.ZS', name: 'Aged 65 and over', unit: '%', decimals: 1 },
  urban_population: { code: 'SP.URB.TOTL.IN.ZS', name: 'Living in towns and cities', unit: '%', decimals: 1 },
  life_expectancy: { code: 'SP.DYN.LE00.IN', name: 'Life expectancy at birth', unit: 'years', decimals: 1 },
  fertility_rate: { code: 'SP.DYN.TFRT.IN', name: 'Births per woman', unit: '', decimals: 2 },
  gdp: { code: 'NY.GDP.MKTP.CD', name: 'GDP', unit: 'US$', decimals: 0 },
  gdp_per_person: { code: 'NY.GDP.PCAP.CD', name: 'GDP per person', unit: 'US$', decimals: 0 },
  gdp_growth: { code: 'NY.GDP.MKTP.KD.ZG', name: 'GDP growth', unit: '%', decimals: 1 },
  inflation: { code: 'FP.CPI.TOTL.ZG', name: 'Inflation', unit: '%', decimals: 1 },
  unemployment: { code: 'SL.UEM.TOTL.ZS', name: 'Unemployment', unit: '%', decimals: 1 },
  exports: { code: 'NE.EXP.GNFS.CD', name: 'Exports of goods and services', unit: 'US$', decimals: 0 },
  military_spending: { code: 'MS.MIL.XPND.GD.ZS', name: 'Military spending, share of GDP', unit: '%', decimals: 2 },
  health_spending: { code: 'SH.XPD.CHEX.GD.ZS', name: 'Health spending, share of GDP', unit: '%', decimals: 1 },
  co2_per_person: { code: 'EN.GHG.CO2.PC.CE.AR5', name: 'CO₂ emissions per person', unit: 't', decimals: 2 },
  internet_users: { code: 'IT.NET.USER.ZS', name: 'Using the internet', unit: '%', decimals: 1 },
  electricity_access: { code: 'EG.ELC.ACCS.ZS', name: 'Access to electricity', unit: '%', decimals: 1 },
  renewable_energy: { code: 'EG.FEC.RNEW.ZS', name: 'Renewable share of energy use', unit: '%', decimals: 1 },
} satisfies Record<string, Indicator>

export type IndicatorKey = keyof typeof INDICATORS

export const INDICATOR_KEYS = Object.keys(INDICATORS) as IndicatorKey[]

export interface WorldBankDeps {
  fetch: typeof fetch
  now: () => number
}

export type DeskLookup<T> = { ok: true; materials: T[]; text: string } | { ok: false; text: string }

interface Row {
  country?: { id?: string; value?: string }
  countryiso3code?: string
  date?: string
  value?: number | null
}

type Response = { rows: Row[] } | { invalid: true }

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** A value as the brief should say it: whole dollars grow unreadable past a billion. */
export function sayValue(value: number, indicator: Indicator): string {
  if (indicator.unit === 'US$') {
    const magnitude = Math.abs(value)
    if (magnitude >= 1e12) return `US$${(value / 1e12).toFixed(2)} trillion`
    if (magnitude >= 1e9) return `US$${(value / 1e9).toFixed(2)} billion`
    return `US$${value.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
  }
  const text = value.toLocaleString('en-GB', { maximumFractionDigits: indicator.decimals })
  if (!indicator.unit) return text
  return indicator.unit === '%' ? `${text}%` : `${text} ${indicator.unit}`
}

async function request(codes: string[], indicator: Indicator, since: number, deps: WorldBankDeps): Promise<Response> {
  const until = new Date(deps.now()).getUTCFullYear()
  const url = `${API}/country/${codes.join(';')}/indicator/${indicator.code}?format=json&per_page=1000&date=${since}:${until}`
  const response = await deps.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) {
    void response.body?.cancel()
    throw new Error(`world bank ${response.status}`)
  }
  const body = (await response.json()) as unknown
  if (!Array.isArray(body)) throw new Error('world bank: unexpected response')
  // An unknown code fails the whole request, with a message in place of the page header.
  if (body[0] && typeof body[0] === 'object' && 'message' in body[0]) return { invalid: true }
  return { rows: Array.isArray(body[1]) ? (body[1] as Row[]) : [] }
}

/**
 * The same request, one country at a time, after a combined one was refused:
 * one code the World Bank does not know fails every code sent with it.
 */
async function eachAlone(codes: string[], indicator: Indicator, since: number, deps: WorldBankDeps) {
  const answers = await Promise.all(
    codes.map(async (code) => ({ code, response: await request([code], indicator, since, deps) })),
  )
  const rows = answers.flatMap(({ response }) => ('rows' in response ? response.rows : []))
  const unknown = answers.filter(({ response }) => 'invalid' in response).map(({ code }) => code)
  return { rows, unknown }
}

/**
 * The name a country goes by in conversation. The World Bank files names for
 * sorting ("Korea, Rep."), which on a chart legend reads as a filing cabinet.
 */
const EVERYDAY_NAMES: Record<string, string> = {
  'Korea, Rep.': 'South Korea',
  "Korea, Dem. People's Rep.": 'North Korea',
  'Egypt, Arab Rep.': 'Egypt',
  'Iran, Islamic Rep.': 'Iran',
  'Russian Federation': 'Russia',
  'Venezuela, RB': 'Venezuela',
  'Yemen, Rep.': 'Yemen',
  'Gambia, The': 'The Gambia',
  'Bahamas, The': 'The Bahamas',
  'Hong Kong SAR, China': 'Hong Kong',
  'Macao SAR, China': 'Macao',
  'Congo, Dem. Rep.': 'DR Congo',
  'Congo, Rep.': 'Republic of the Congo',
  'Micronesia, Fed. Sts.': 'Micronesia',
  'Lao PDR': 'Laos',
  'Kyrgyz Republic': 'Kyrgyzstan',
  'Slovak Republic': 'Slovakia',
  'Syrian Arab Republic': 'Syria',
  'Viet Nam': 'Vietnam',
  Turkiye: 'Türkiye',
  'St. Lucia': 'Saint Lucia',
  'St. Kitts and Nevis': 'Saint Kitts and Nevis',
  'St. Vincent and the Grenadines': 'Saint Vincent and the Grenadines',
}

function seriesFrom(rows: Row[], key: IndicatorKey, fetchedAt: string): SeriesMaterial[] {
  const indicator: Indicator = INDICATORS[key]
  const byCountry = new Map<string, { name: string; iso2: string; points: Map<string, number> }>()
  for (const row of rows) {
    const iso3 = row.countryiso3code?.trim()
    const year = row.date?.trim()
    if (!iso3 || !year || !/^\d{4}$/.test(year)) continue
    if (typeof row.value !== 'number' || !Number.isFinite(row.value)) continue
    const filed = row.country?.value?.trim() || iso3
    const entry = byCountry.get(iso3) ?? { name: EVERYDAY_NAMES[filed] ?? filed, iso2: row.country?.id ?? '', points: new Map() }
    entry.points.set(year, round(row.value, indicator.decimals))
    byCountry.set(iso3, entry)
  }

  const series: SeriesMaterial[] = []
  for (const [iso3, entry] of byCountry) {
    const points = [...entry.points.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([x, value]) => ({ x, value }))
    // One value is a figure, not a series.
    if (points.length < 2) continue
    series.push({
      id: `worldbank:${key}:${iso3}`,
      kind: 'series',
      measure: `worldbank:${key}`,
      name: indicator.name,
      subject: entry.name,
      unit: indicator.unit,
      points,
      source: {
        title: 'World Bank',
        url: `https://data.worldbank.org/indicator/${indicator.code}${entry.iso2 ? `?locations=${entry.iso2}` : ''}`,
        fetchedAt,
      },
    })
  }
  return series
}

/** A few values from a long series, in words: every tenth year, the latest, the peak and the low. */
export function describeSeries(series: SeriesMaterial, indicator: Indicator): string {
  const { points } = series
  const first = points[0]
  const last = points[points.length - 1]
  const peak = points.reduce((best, point) => (point.value > best.value ? point : best))
  const low = points.reduce((best, point) => (point.value < best.value ? point : best))
  const shown = points.filter((point, index) => index === 0 || index === points.length - 1 || Number(point.x) % 10 === 0)
  const values = shown.map((point) => `${point.x} ${sayValue(point.value, indicator)}`).join(' · ')
  return `${series.subject}, ${first.x} to ${last.x}: ${values}. Highest ${sayValue(peak.value, indicator)} in ${peak.x}; lowest ${sayValue(low.value, indicator)} in ${low.x}.`
}

const cache = new TimedCache<{ rows: Row[]; unknown: string[] }>(12 * 60 * 60_000)

export interface CountryDataArgs {
  countries: string[]
  indicator: string
  since?: number
}

/**
 * The series behind a chart, and the words to brief with. Never rejects: a
 * lookup that cannot be done is a sentence the desk can act on.
 */
export async function countryData(
  args: CountryDataArgs,
  deps: WorldBankDeps,
  signal: AbortSignal,
): Promise<DeskLookup<SeriesMaterial>> {
  const key = args.indicator as IndicatorKey
  if (!Object.hasOwn(INDICATORS, key)) {
    return { ok: false, text: `There is no indicator called ${args.indicator}. Use one of: ${INDICATOR_KEYS.join(', ')}.` }
  }
  const indicator: Indicator = INDICATORS[key]
  const codes = [
    ...new Set(
      (Array.isArray(args.countries) ? args.countries : [])
        .map((code) => (typeof code === 'string' ? code.trim().toUpperCase() : ''))
        .filter((code) => /^[A-Z]{3}$/.test(code)),
    ),
  ]
  if (!codes.length) {
    return { ok: false, text: 'Give each country as its three-letter ISO code, such as JPN, or WLD for the world.' }
  }
  if (codes.length > MAX_COUNTRIES) {
    return { ok: false, text: `Ask for at most ${MAX_COUNTRIES} countries at a time.` }
  }
  const thisYear = new Date(deps.now()).getUTCFullYear()
  const since = Number.isInteger(args.since) && args.since! >= FIRST_YEAR && args.since! < thisYear ? args.since! : FIRST_YEAR

  const load = async () => {
    const combined = await request(codes, indicator, since, deps)
    if ('rows' in combined) return { rows: combined.rows, unknown: [] }
    return codes.length > 1 ? eachAlone(codes, indicator, since, deps) : { rows: [], unknown: codes }
  }

  let answer: { rows: Row[]; unknown: string[] }
  try {
    answer = await Promise.race([
      cache.get(`${[...codes].sort().join(';')}|${key}|${since}`, load),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ])
  } catch (error) {
    if (signal.aborted) throw error
    return { ok: false, text: 'The World Bank could not be reached just now. Answer from search instead.' }
  }

  const series = seriesFrom(answer.rows, key, new Date(deps.now()).toISOString())
  const unknown = answer.unknown.length ? ` The World Bank does not recognise ${answer.unknown.join(', ')}.` : ''
  const missing = codes.filter(
    (code) => !answer.unknown.includes(code) && !series.some((each) => each.id.endsWith(`:${code}`)),
  )
  const empty = missing.length ? ` It has no ${indicator.name.toLowerCase()} figures for ${missing.join(', ')}.` : ''
  if (!series.length) {
    return { ok: false, text: `No World Bank series for that.${unknown}${empty} Answer from search instead.` }
  }

  const lines = series.map((each) => describeSeries(each, indicator))
  return {
    ok: true,
    materials: series,
    text: `World Bank · ${indicator.name}${indicator.unit === 'US$' ? ', current US dollars' : ''}\n${lines.join('\n')}${unknown}${empty}\nThese series are shown on the user's screen as a chart. Use their numbers exactly as given here, and search as well for anything more recent than the latest year.`,
  }
}

/** For tests: forget every lookup. */
export function forgetWorldBank() {
  cache.clear()
}
