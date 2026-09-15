import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WeatherMaterial } from '../cards/materials'
import { readCard } from '../cards/read'
import {
  choosePlace,
  describeWeather,
  forecastDay,
  forgetWeather,
  nameKey,
  openMeteo,
  readForecast,
  runWeather,
  unitFor,
  type Place,
  type WeatherProvider,
} from './weather'

/**
 * The weather tool against a provider that answers from fixtures. What is
 * pinned: a place is chosen only when the name surely means it, a day past the
 * forecast is refused before anything is asked, and the brief says what the
 * forecast says, in the units it was asked for.
 */

const place = (name: string, extra: Partial<Place> = {}): Place => ({
  name,
  region: '',
  country: 'Portugal',
  latitude: 38.72,
  longitude: -9.15,
  timezone: 'Europe/Lisbon',
  population: 500_000,
  capital: false,
  ...extra,
})

/** An Open-Meteo response in the shape the live service returned on 14 September 2026, cut to three hours and three days. */
const response = {
  current: { time: '2026-09-14T16:45', temperature_2m: 31.6, apparent_temperature: 32.4, weather_code: 0, is_day: 1, wind_speed_10m: 7.2, relative_humidity_2m: 27 },
  hourly: {
    time: ['2026-09-14T16:00', '2026-09-14T17:00', '2026-09-14T18:00'],
    temperature_2m: [32.1, 31.2, null],
    precipitation_probability: [0, 40, 5],
    weather_code: [0, 61, 1],
    is_day: [1, 1, 0],
  },
  daily: {
    time: ['2026-09-14', '2026-09-15', '2026-09-16'],
    weather_code: [0, 61, 63],
    temperature_2m_max: [32.1, 26.8, 25.5],
    temperature_2m_min: [19.8, 19.1, 18.7],
    precipitation_probability_max: [0, 5, 60],
    uv_index_max: [6.7, 6.65, null],
    sunrise: ['2026-09-14T07:16', '2026-09-15T07:17', ''],
    sunset: ['2026-09-14T19:46', '2026-09-15T19:44', ''],
  },
}

describe('reading a forecast', () => {
  it("keeps the provider's figures, leaves out an hour with no temperature, and credits the provider", () => {
    const material = readForecast(response, place('Lisbon'), '°C', Date.UTC(2026, 8, 14, 15))
    expect(material).toMatchObject({
      id: 'weather:38.72,-9.15:°C',
      kind: 'weather',
      units: { temperature: '°C', wind: 'km/h' },
      current: { time: '2026-09-14T16:45', temperature: 31.6, feelsLike: 32.4, code: 0, isDay: true, wind: 7.2, humidity: 27 },
      source: { title: 'Open-Meteo', url: 'https://open-meteo.com/', fetchedAt: '2026-09-14T15:00:00.000Z' },
    })
    expect(material.hours.map((hour) => [hour.time, hour.temperature, hour.rainChance])).toEqual([
      ['2026-09-14T16:00', 32.1, 0],
      ['2026-09-14T17:00', 31.2, 40],
    ])
    expect(material.days[0]).toMatchObject({ sunrise: '07:16', sunset: '19:46' })
    // A day with no sunrise given has none, rather than a time made from nothing.
    expect(material.days[2]).toEqual({ date: '2026-09-16', code: 63, high: 25.5, low: 18.7, rainChance: 60, uv: null, sunrise: null, sunset: null })
  })

  it('refuses a response that is not a forecast', () => {
    expect(() => readForecast({ error: true, reason: 'Latitude must be in range' }, place('Lisbon'), '°C', 0)).toThrow()
    expect(() => readForecast({ ...response, daily: { time: [] } }, place('Lisbon'), '°C', 0)).toThrow()
  })

  it('asks for Fahrenheit and miles an hour when those are the units', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(response))
    const material = await openMeteo({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => 0 }).forecast(place('Portland'), '°F', new AbortController().signal)
    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', forecast_days: '7', forecast_hours: '24', timezone: 'auto' })
    expect(material.units).toEqual({ temperature: '°F', wind: 'mph' })
  })
})

describe('choosing a place', () => {
  it('takes a capital, or a place with far more people than the next, and asks about the rest', () => {
    const capital = place('Lisbon', { capital: true })
    expect(choosePlace('Lisbon', [capital, place('Lisbon', { country: 'United States', population: 2_700 })])).toEqual({ place: capital })
    const oregon = place('Portland', { region: 'Oregon', country: 'United States', population: 652_000 })
    const maine = place('Portland', { region: 'Maine', country: 'United States', population: 66_900 })
    expect(choosePlace('Portland', [oregon, maine])).toEqual({ place: oregon })
    const missouri = place('Springfield', { region: 'Missouri', country: 'United States', population: 169_000 })
    const illinois = place('Springfield', { region: 'Illinois', country: 'United States', population: 114_000 })
    expect(choosePlace('Springfield', [missouri, illinois])).toEqual({ options: [missouri, illinois] })
  })

  it('lets a region or country after a comma decide, and finds nothing when nothing matches', () => {
    const oregon = place('Portland', { region: 'Oregon', country: 'United States', population: 652_000 })
    const maine = place('Portland', { region: 'Maine', country: 'United States', population: 66_900 })
    expect(choosePlace('Portland, Maine', [oregon, maine])).toEqual({ place: maine })
    expect(choosePlace('Portland, Peru', [oregon, maine])).toBeNull()
    // A model adds every region it knows; one of them agreeing is enough.
    expect(choosePlace('Portland, Cumberland County, Maine, United States', [oregon, maine])).toEqual({ place: maine })
    expect(choosePlace('Atlantis', [])).toBeNull()
  })

  it('compares only the places called what was asked, when there are any', () => {
    // A place search matches other names a place goes by: the live one found this Santana for "Porto".
    const porto = place('Porto', { population: 249_600 })
    const santana = place('Santana', { region: 'Amapá', country: 'Brazil', population: 285_000 })
    expect(choosePlace('Porto', [santana, porto])).toEqual({ place: porto })
    expect(choosePlace('são paulo', [place('Sao Paulo', { country: 'Brazil' })])).toEqual({ place: place('Sao Paulo', { country: 'Brazil' }) })
    expect(nameKey('The Hague')).toBe(nameKey('hague'))
    const lone = place('Santana', { country: 'Brazil' })
    expect(choosePlace('Porto', [lone])).toEqual({ place: lone })
  })
})

describe('which day', () => {
  // Monday 14 September 2026, where the place is.
  const today = '2026-09-14'

  it('counts today, tomorrow, a weekday and a date from the place’s own today', () => {
    expect(forecastDay('today', today)).toEqual({ index: 0 })
    expect(forecastDay('Tonight', today)).toEqual({ index: 0 })
    expect(forecastDay('tomorrow', today)).toEqual({ index: 1 })
    expect(forecastDay('Friday', today)).toEqual({ index: 4 })
    expect(forecastDay('monday', today)).toEqual({ index: 0 })
    expect(forecastDay('2026-09-20', today)).toEqual({ index: 6 })
    expect(forecastDay('sometime soon', today)).toBeNull()
  })

  it('refuses a day that has passed or is past the week, with what to do instead', () => {
    expect(forecastDay('2026-09-13', today)).toEqual({ refusal: expect.stringContaining('already passed') })
    expect(forecastDay('2026-09-21', today)).toEqual({ refusal: expect.stringContaining('past the 7-day forecast') })
  })
})

describe('units', () => {
  it('follows what was asked, then where the user is', () => {
    expect(unitFor('fahrenheit', 'Europe/London')).toBe('°F')
    expect(unitFor('celsius', 'America/Chicago')).toBe('°C')
    expect(unitFor(undefined, 'America/Indiana/Indianapolis')).toBe('°F')
    expect(unitFor(undefined, 'America/Toronto')).toBe('°C')
    expect(unitFor(undefined, 'Europe/London')).toBe('°C')
  })
})

describe('the brief', () => {
  const material = (): WeatherMaterial => readForecast(response, place('Lisbon', { region: 'Lisbon District' }), '°C', 0)

  it('says now, the day asked about first, the hours, the rest of the week and the UV, and what is on screen', () => {
    const lines = describeWeather(material(), 1).split('\n')
    expect(lines[0]).toBe('Lisbon, Portugal. Now, at 16:45 local time: 32°C and sunny, feeling like 32°C, wind 7 km/h.')
    // A day whose worst hour is rain but whose chance is 5% is not called a rainy day.
    expect(lines[1]).toBe('Asked about tomorrow, 15 September. Tomorrow: overcast, 19°C to 27°C, no rain expected.')
    expect(lines[2]).toBe('Next 2 hours: warmest 32°C at 16:00, coolest 31°C at 17:00, rain most likely around 17:00 (40%).')
    expect(lines).toContain('Today: sunny, 20°C to 32°C, no rain expected.')
    expect(lines).toContain('Wednesday: rain, 19°C to 26°C, a 60% chance of rain.')
    expect(lines).toContain('UV today peaks at 7, high.')
    expect(lines).toContain('Tomorrow the sun rises at 07:17 and sets at 19:44, local time.')
    expect(lines.at(-1)).toContain("On the user's screen now: a weather card")
  })
})

describe('the tool', () => {
  const NOW = Date.UTC(2026, 8, 14, 15)
  const context = { signal: new AbortController().signal, timezone: 'Europe/London' }

  function provider(places: Place[], fail = false) {
    const forecast = vi.fn(async (chosen: Place, unit: '°C' | '°F') => {
      if (fail) throw new Error('down')
      return readForecast(response, chosen, unit, NOW)
    })
    const find = vi.fn(async () => places)
    return { provider: { name: 'Test', places: find, forecast } satisfies WeatherProvider, find, forecast }
  }

  beforeEach(() => forgetWeather())

  it('draws the card and briefs with the figures, looking the same place up only once', async () => {
    const { provider: test, find, forecast } = provider([place('Lisbon', { capital: true })])
    const outcome = await runWeather({ place: 'Lisbon', day: 'tomorrow' }, context, test, NOW)
    expect(outcome).toMatchObject({ ok: true, summary: 'Lisbon: 32°C, sunny' })
    expect(outcome.content).toContain('Asked about tomorrow, 15 September.')
    const card = await outcome.card
    expect(card).toMatchObject({ recipe: 'weather', size: 'feature', title: 'Weather, Lisbon', partial: false })
    expect(card?.blocks.map((block) => block.type)).toEqual(['headline', 'stat', 'facts', 'forecast', 'meter'])

    await runWeather({ place: 'lisbon' }, context, test, NOW)
    expect(find).toHaveBeenCalledTimes(1)
    expect(forecast).toHaveBeenCalledTimes(1)
  })

  it('puts a map of the place on the card when maps are set up, carrying only the public token', async () => {
    const publicToken = 'pk.eyJ1IjoidGVzdCIsImEiOiJ0ZXN0In0.dGVzdHNpZ25hdHVyZQ'
    const { provider: test } = provider([place('Lisbon', { capital: true })])
    const card = await (await runWeather({ place: 'Lisbon' }, { ...context, publicToken }, test, NOW)).card
    const map = card?.blocks.find((block) => block.type === 'map')
    expect(map).toMatchObject({ view: 'pin', center: [-9.15, 38.72], pins: [{ id: 'place', label: 'Lisbon', at: [-9.15, 38.72] }], token: publicToken })
    expect(readCard(JSON.parse(JSON.stringify(card)))?.blocks.some((block) => block.type === 'map')).toBe(true)
  })

  it('asks rather than guesses, and refuses a day past the forecast before asking the provider for it', async () => {
    const { provider: test, forecast } = provider([
      place('Springfield', { region: 'Missouri', country: 'United States', population: 169_000 }),
      place('Springfield', { region: 'Illinois', country: 'United States', population: 114_000 }),
    ])
    expect((await runWeather({ place: 'Springfield' }, context, test, NOW)).content).toBe(
      'Springfield could be Springfield, Missouri, United States, or Springfield, Illinois, United States. Ask the user which one they mean.',
    )
    const lisbon = provider([place('Lisbon', { capital: true })])
    expect((await runWeather({ place: 'Lisbon', day: '2026-10-30' }, context, lisbon.provider, NOW)).content).toContain('past the 7-day forecast')
    expect(lisbon.forecast).not.toHaveBeenCalled()
    expect(forecast).not.toHaveBeenCalled()
  })

  it('forecasts for where the user is when no place is named, and says it is a guess to name', async () => {
    const { provider: test, find, forecast } = provider([])
    const location = { city: 'Lisbon', region: 'Lisbon', country: 'Portugal', latitude: 38.72, longitude: -9.13, timezone: 'Europe/Lisbon' }
    const outcome = await runWeather({ day: 'today' }, { ...context, location }, test, NOW)
    expect(outcome.ok).toBe(true)
    expect(outcome.content.split('\n')[0]).toBe(
      "No place was given, so this is for where the user's connection places them, roughly: Lisbon, Portugal. Say which place it is, in case that is wrong.",
    )
    // The place is already known, so nothing is looked up by name.
    expect(find).not.toHaveBeenCalled()
    expect(forecast.mock.calls[0][0]).toMatchObject({ name: 'Lisbon', latitude: 38.72, longitude: -9.13, timezone: 'Europe/Lisbon' })
    expect((await outcome.card)?.title).toBe('Weather, Lisbon')

    expect((await runWeather({}, context, test, NOW)).content).toBe(
      'No place was given, and where the user is could not be found (they may not have allowed it). Ask them which place they mean, and do not look the weather up any other way.',
    )
  })

  it('says so, in a sentence, when the forecast cannot be reached or the place cannot be found', async () => {
    const down = provider([place('Lisbon', { capital: true })], true)
    expect(await runWeather({ place: 'Lisbon' }, context, down.provider, NOW)).toMatchObject({ ok: false, summary: 'Could not get the weather' })
    const nowhere = provider([])
    expect((await runWeather({ place: 'Atlantis' }, context, nowhere.provider, NOW)).content).toBe(
      'No place called Atlantis could be found. If it sounds like a place you know, try again with its proper spelling; otherwise ask the user where they mean. Do not look the weather up any other way.',
    )
  })
})
