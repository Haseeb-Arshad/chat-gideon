/**
 * The weather: the forecast, or the conditions now, for one place.
 *
 * A forecast is data with a source, not something to research, so it does not
 * go through the research desk. The place is found, the provider is asked, and
 * the speaking model is told the few figures that matter while the card shows
 * the rest, drawn in code from the provider's own numbers.
 *
 * The provider sits behind an interface. Open-Meteo is used today: free for
 * non-commercial use, CC BY 4.0, with its own place search, so no key and no
 * geocoding account. A commercial site would move to MET Norway or a paid plan,
 * which is a new provider here and no change to anything that draws the card.
 *
 * Arguments are checked before any request leaves. A day that has passed, or is
 * past the forecast's horizon, is refused with one sentence the model can act
 * on, and a place name that could be several places is asked about rather than
 * guessed.
 */

import { cardFromMaterials, temperature } from '../cards/from-materials'
import type { WeatherDay, WeatherMaterial } from '../cards/materials'
import { conditionOf, dayCode, placeName, uvBand } from '../cards/weather'
import { TimedCache } from './desk/cache'
import type { ToolOutcome } from './registry'

/** Today and the six days after it: the week the card shows. */
export const FORECAST_DAYS = 7
/** A cold connection to the provider has taken past five seconds; a warm one takes a fifth of one. */
const TIMEOUT_MS = 8_000

export interface Place {
  name: string
  region: string
  country: string
  latitude: number
  longitude: number
  timezone: string
  population: number
  capital: boolean
}

export type TemperatureUnit = WeatherMaterial['units']['temperature']

export interface WeatherProvider {
  /** Credited on the card. */
  name: string
  /** The places a name could mean, the likeliest first. */
  places(name: string, signal: AbortSignal): Promise<Place[]>
  forecast(place: Place, unit: TemperatureUnit, signal: AbortSignal): Promise<WeatherMaterial>
}

export interface WeatherDeps {
  fetch: typeof fetch
  now: () => number
}

async function getJson(deps: WeatherDeps, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await deps.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) })
  if (!response.ok) {
    void response.body?.cancel()
    throw new Error(`weather ${response.status}`)
  }
  return response.json()
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object'
const numbers = (value: unknown): Array<number | null> =>
  Array.isArray(value) ? value.map((each) => (typeof each === 'number' && Number.isFinite(each) ? each : null)) : []
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((each) => (typeof each === 'string' ? each : '')) : [])

function readPlace(value: unknown): Place[] {
  if (!isObject(value) || typeof value.name !== 'string') return []
  const { latitude, longitude } = value
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return []
  return [
    {
      name: value.name,
      region: typeof value.admin1 === 'string' ? value.admin1 : '',
      country: typeof value.country === 'string' ? value.country : '',
      latitude,
      longitude,
      timezone: typeof value.timezone === 'string' ? value.timezone : 'UTC',
      population: typeof value.population === 'number' ? value.population : 0,
      capital: value.feature_code === 'PPLC',
    },
  ]
}

/** Open-Meteo's response, read into a material. Throws on a response that is not a forecast. */
export function readForecast(body: unknown, place: Place, unit: TemperatureUnit, fetchedAt: number): WeatherMaterial {
  if (!isObject(body) || !isObject(body.current) || !isObject(body.hourly) || !isObject(body.daily)) throw new Error('not a forecast')
  const current = body.current
  const now = {
    time: typeof current.time === 'string' ? current.time : '',
    temperature: numbers([current.temperature_2m])[0],
    feelsLike: numbers([current.apparent_temperature])[0],
    code: numbers([current.weather_code])[0],
    isDay: current.is_day !== 0,
    wind: numbers([current.wind_speed_10m])[0],
    humidity: numbers([current.relative_humidity_2m])[0],
  }
  if (!now.time || now.temperature === null || now.code === null) throw new Error('no current conditions')

  const hourly = body.hourly
  const hourTemperatures = numbers(hourly.temperature_2m)
  const hourRain = numbers(hourly.precipitation_probability)
  const hourCodes = numbers(hourly.weather_code)
  const hourDay = numbers(hourly.is_day)
  const hours = strings(hourly.time).flatMap((time, index) => {
    const value = hourTemperatures[index]
    return time && value !== null && value !== undefined
      ? [{ time, temperature: value, rainChance: hourRain[index] ?? null, code: hourCodes[index] ?? 3, isDay: hourDay[index] !== 0 }]
      : []
  })

  const daily = body.daily
  const highs = numbers(daily.temperature_2m_max)
  const lows = numbers(daily.temperature_2m_min)
  const dayCodes = numbers(daily.weather_code)
  const dayRain = numbers(daily.precipitation_probability_max)
  const uv = numbers(daily.uv_index_max)
  // "2026-09-14T07:16", of which the clock is kept; past the polar circles a day can have neither.
  const clock = (value: string | undefined) => (value && /T\d{2}:\d{2}/.test(value) ? value.slice(value.indexOf('T') + 1, value.indexOf('T') + 6) : null)
  const sunrises = strings(daily.sunrise)
  const sunsets = strings(daily.sunset)
  const days: WeatherDay[] = strings(daily.time).flatMap((date, index) => {
    const high = highs[index]
    const low = lows[index]
    return date && typeof high === 'number' && typeof low === 'number'
      ? [{ date, code: dayCodes[index] ?? 3, high, low, rainChance: dayRain[index] ?? null, uv: uv[index] ?? null, sunrise: clock(sunrises[index]), sunset: clock(sunsets[index]) }]
      : []
  })
  if (!days.length) throw new Error('no days')

  return {
    id: `weather:${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}:${unit}`,
    kind: 'weather',
    place: { name: place.name, region: place.region, country: place.country, latitude: place.latitude, longitude: place.longitude, timezone: place.timezone },
    units: { temperature: unit, wind: unit === '°F' ? 'mph' : 'km/h' },
    current: { ...now, temperature: now.temperature, code: now.code, feelsLike: now.feelsLike ?? now.temperature, wind: now.wind ?? 0, humidity: now.humidity ?? 0 },
    hours,
    days,
    source: { title: 'Open-Meteo', url: 'https://open-meteo.com/', fetchedAt: new Date(fetchedAt).toISOString() },
  }
}

export function openMeteo(deps: WeatherDeps): WeatherProvider {
  return {
    name: 'Open-Meteo',
    async places(name, signal) {
      const query = new URLSearchParams({ name, count: '10', language: 'en', format: 'json' })
      const body = await getJson(deps, `https://geocoding-api.open-meteo.com/v1/search?${query}`, signal)
      return isObject(body) && Array.isArray(body.results) ? body.results.flatMap(readPlace) : []
    },
    async forecast(place, unit, signal) {
      const query = new URLSearchParams({
        latitude: place.latitude.toFixed(4),
        longitude: place.longitude.toFixed(4),
        current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m',
        hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset',
        timezone: 'auto',
        forecast_days: String(FORECAST_DAYS),
        forecast_hours: '24',
        ...(unit === '°F' ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph' } : {}),
      })
      return readForecast(await getJson(deps, `https://api.open-meteo.com/v1/forecast?${query}`, signal), place, unit, deps.now())
    },
  }
}

// -- Checking the arguments ---------------------------------------------------------

/** How many times more people the likeliest place needs than the next before a name surely means it. */
const CLEAR_LEAD = 5

/**
 * The place a name means, the places it could mean when that is not clear, or
 * nothing when it means none. "Lisbon" is the capital of Portugal, not one of the
 * small towns in America with the same name, and "Portland" is Oregon, with ten
 * times Maine's people; "Springfield" could be any of several, and is asked
 * about. A region or country after a comma decides it.
 */
export function choosePlace(query: string, places: Place[]): { place: Place } | { options: Place[] } | null {
  const qualifier = query.split(',').slice(1).join(',').trim().toLowerCase()
  const candidates = qualifier
    ? places.filter((place) => [place.region, place.country].some((part) => part && part.toLowerCase().startsWith(qualifier)))
    : places
  const [first, second] = candidates
  if (!first) return null
  if (!second) return { place: first }
  const sameArea = first.country === second.country && first.region === second.region
  if (sameArea || (first.capital && !second.capital) || first.population >= Math.max(1, second.population) * CLEAR_LEAD) return { place: first }
  return { options: candidates.slice(0, 3) }
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** The date where the place is, as "2026-09-14". */
function localDate(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000

/**
 * Which day of the forecast a day the model passed means, counted from the
 * place's own today: 0 for today. A day that has passed, or is past the
 * horizon, is a refusal to act on; a day that cannot be read is no particular day.
 */
export function forecastDay(day: string, today: string): { index: number } | { refusal: string } | null {
  const said = day.trim().toLowerCase()
  if (!said) return null
  let index: number | null = null
  if (['today', 'tonight', 'now', 'this afternoon', 'this evening', 'this morning'].includes(said)) index = 0
  else if (said === 'tomorrow') index = 1
  else if (WEEKDAYS.includes(said)) {
    const [year, month, date] = today.split('-').map(Number)
    index = (WEEKDAYS.indexOf(said) - new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 7) % 7
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(said)) index = dayNumber(said) - dayNumber(today)
  if (index === null) return null
  if (index < 0) return { refusal: 'That day has already passed, so there is no forecast for it. Use research for what the weather was.' }
  if (index >= FORECAST_DAYS) {
    return { refusal: `That day is past the ${FORECAST_DAYS}-day forecast. Say so, or use research for what the weather is usually like then.` }
  }
  return { index }
}

/** Where the United States' clocks are, whose people read temperatures in Fahrenheit. */
const FAHRENHEIT_ZONES = /^(America\/(New_York|Detroit|Chicago|Denver|Phoenix|Los_Angeles|Anchorage|Juneau|Boise|Sitka|Nome|Yakutat|Adak|Menominee|Metlakatla|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/Honolulu)$/

/** Fahrenheit when asked for, or for someone whose clock is in the United States; Celsius otherwise. */
export function unitFor(asked: unknown, userTimezone: string): TemperatureUnit {
  if (asked === 'fahrenheit') return '°F'
  if (asked === 'celsius') return '°C'
  return FAHRENHEIT_ZONES.test(userTimezone) ? '°F' : '°C'
}

// -- The brief ----------------------------------------------------------------------

function rainPhrase(chance: number | null): string {
  if (chance === null) return ''
  return chance < 10 ? 'no rain expected' : `a ${Math.round(chance)}% chance of rain`
}

function dayLine(day: WeatherDay, name: string, unit: TemperatureUnit): string {
  const rain = rainPhrase(day.rainChance)
  return `${name}: ${conditionOf(dayCode(day.code, day.rainChance)).text.toLowerCase()}, ${temperature(day.low, unit)} to ${temperature(day.high, unit)}${rain ? `, ${rain}` : ''}.`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** What the speaking model is told: the figures that matter, and what is on screen. */
export function describeWeather(material: WeatherMaterial, asked: number | null): string {
  const { current, units, place, days, hours } = material
  const unit = units.temperature
  const names = days.map((day, index) => (index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : WEEKDAYS[new Date(dayNumber(day.date) * 86_400_000).getUTCDay()].replace(/^\w/, (c) => c.toUpperCase())))
  const lines = [
    `${placeName(place)}. Now, at ${current.time.slice(11, 16)} local time: ${temperature(current.temperature, unit)} and ${conditionOf(current.code, current.isDay).text.toLowerCase()}, feeling like ${temperature(current.feelsLike, unit)}, wind ${Math.round(current.wind)} ${units.wind}.`,
  ]
  if (asked !== null && days[asked]) {
    const { date } = days[asked]
    const when = `${asked === 0 ? 'today' : asked === 1 ? 'tomorrow' : names[asked]}, ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`
    lines.push(`Asked about ${when}. ${dayLine(days[asked], names[asked], unit)}`)
  }
  if (hours.length) {
    const warmest = hours.reduce((best, hour) => (hour.temperature > best.temperature ? hour : best))
    const coolest = hours.reduce((best, hour) => (hour.temperature < best.temperature ? hour : best))
    const wettest = hours.reduce((best, hour) => ((hour.rainChance ?? 0) > (best.rainChance ?? 0) ? hour : best))
    const rain = (wettest.rainChance ?? 0) < 10 ? 'no rain expected' : `rain most likely around ${wettest.time.slice(11, 16)} (${wettest.rainChance}%)`
    lines.push(`Next ${hours.length} hours: warmest ${temperature(warmest.temperature, unit)} at ${warmest.time.slice(11, 16)}, coolest ${temperature(coolest.temperature, unit)} at ${coolest.time.slice(11, 16)}, ${rain}.`)
  }
  days.forEach((day, index) => {
    if (index !== asked) lines.push(dayLine(day, names[index], unit))
  })
  if (days[0]?.uv !== null && days[0]?.uv !== undefined) lines.push(`UV today peaks at ${Math.round(days[0].uv)}, ${uvBand(days[0].uv).toLowerCase()}.`)
  const sunDay = asked !== null && days[asked] ? asked : 0
  const sun = days[sunDay]
  if (sun?.sunrise && sun.sunset) {
    lines.push(`${sunDay === 0 ? 'Today' : names[sunDay]} the sun rises at ${sun.sunrise} and sets at ${sun.sunset}, local time.`)
  }
  lines.push(
    "On the user's screen now: a weather card with now, the next hours and the week. Say the one or two things that matter, such as rain later or a cold night, in the units given, and do not read the card out.",
  )
  return lines.join('\n')
}

// -- The tool -----------------------------------------------------------------------

const places = new TimedCache<Place[]>(24 * 60 * 60_000)
const forecasts = new TimedCache<WeatherMaterial>(10 * 60_000)

export interface WeatherContext {
  signal: AbortSignal
  /** The user's timezone, for the units they read temperatures in. */
  timezone: string
}

export async function runWeather(args: Record<string, unknown>, context: WeatherContext, provider: WeatherProvider, now: number): Promise<ToolOutcome> {
  const where = typeof args.place === 'string' ? args.place.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  if (!where) return { ok: false, content: 'No place was given. Ask the user which place they mean.' }
  const name = where.split(',')[0].trim()

  let found: Place[]
  try {
    found = await places.get(`${provider.name}|${name.toLowerCase()}`, () => provider.places(name, context.signal), (each) => each.length > 0)
  } catch (error) {
    if (context.signal.aborted) throw error
    return { ok: false, content: 'The forecast could not be reached just now. Say so in one short sentence.', summary: 'Could not get the weather' }
  }
  const chosen = choosePlace(where, found)
  if (!chosen) return { ok: false, content: `No place called ${where} could be found. Ask the user where they mean.`, summary: 'Place not found' }
  if ('options' in chosen) {
    const options = chosen.options.map(placeName)
    return { ok: false, content: `${name} could be ${options.join(', or ')}. Ask the user which one they mean.` }
  }
  const { place } = chosen

  const day = typeof args.day === 'string' ? forecastDay(args.day, localDate(now, place.timezone)) : null
  if (day && 'refusal' in day) return { ok: false, content: day.refusal }

  const unit = unitFor(args.units, context.timezone)
  let material: WeatherMaterial
  try {
    material = await forecasts.get(`${provider.name}|${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}|${unit}`, () =>
      provider.forecast(place, unit, context.signal),
    )
  } catch (error) {
    if (context.signal.aborted) throw error
    return { ok: false, content: 'The forecast could not be reached just now. Say so in one short sentence.', summary: 'Could not get the weather' }
  }

  const card = cardFromMaterials(`Weather in ${where}`, [material], now)
  return {
    ok: true,
    content: describeWeather(material, day ? day.index : null),
    summary: `${place.name}: ${temperature(material.current.temperature, unit)}, ${conditionOf(material.current.code, material.current.isDay).text.toLowerCase()}`,
    links: [{ title: `${provider.name}: ${place.name}`, url: material.source.url }],
    card: Promise.resolve(card),
  }
}

/** For tests: forget every place and forecast. */
export function forgetWeather() {
  places.clear()
  forecasts.clear()
}
