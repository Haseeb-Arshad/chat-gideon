import { describe, expect, it } from 'vitest'
import { digestOf } from './digest'
import { cardFromMaterials, describeCard } from './from-materials'
import type { WeatherMaterial } from './materials'
import { hear, saidDays } from './mentions'
import { readCard } from './read'
import type { ForecastBlock, MeterBlock } from './schema'
import { conditionOf, dayCode, degrees, placeName, uvBand } from './weather'

/**
 * The weather as a card. The names for skies and UV readings come from tables
 * in code, the card is drawn from the provider's figures, and it survives the
 * wire exactly as it was drawn.
 */

describe('the words for the weather', () => {
  it('names a sky by day and by night, and anything unknown as cloud', () => {
    expect(conditionOf(0)).toEqual({ text: 'Sunny', kind: 'clear' })
    expect(conditionOf(0, false)).toEqual({ text: 'Clear', kind: 'clear' })
    expect(conditionOf(63)).toEqual({ text: 'Rain', kind: 'rain' })
    expect(conditionOf(96)).toEqual({ text: 'Thunderstorms with hail', kind: 'storm' })
    expect(conditionOf(42)).toEqual({ text: 'Cloudy', kind: 'cloud' })
  })

  it("reads the UV index on the WHO's bands, rounded as it is said", () => {
    expect([0, 2.4, 2.6, 5.4, 6.7, 7.5, 10.4, 10.6, 13].map(uvBand)).toEqual([
      'Low',
      'Low',
      'Moderate',
      'Moderate',
      'High',
      'Very high',
      'Very high',
      'Extreme',
      'Extreme',
    ])
  })

  it('calls a day wet only when rain is somewhat likely', () => {
    expect(dayCode(61, 5)).toBe(3)
    expect(dayCode(61, 20)).toBe(61)
    expect(dayCode(61, null)).toBe(61)
    expect(dayCode(1, 0)).toBe(1)
  })

  it('writes a temperature with a real minus, and a place without a region named after it', () => {
    expect(degrees(-0.4)).toBe('0°')
    expect(degrees(-3.6)).toBe('−4°')
    expect(placeName({ name: 'Lisbon', region: 'Lisbon District', country: 'Portugal' })).toBe('Lisbon, Portugal')
    expect(placeName({ name: 'Bergen', region: 'Vestland', country: 'Norway' })).toBe('Bergen, Vestland, Norway')
  })
})

const lisbon: WeatherMaterial = {
  id: 'weather:38.73,-9.15:°C',
  kind: 'weather',
  place: { name: 'Lisbon', region: 'Lisbon District', country: 'Portugal', latitude: 38.72509, longitude: -9.1498, timezone: 'Europe/Lisbon' },
  units: { temperature: '°C', wind: 'km/h' },
  current: { time: '2026-09-14T16:45', temperature: 31.6, feelsLike: 32.4, code: 0, isDay: true, wind: 7.2, humidity: 27 },
  hours: [
    { time: '2026-09-14T16:00', temperature: 32.1, rainChance: 0, code: 0, isDay: true },
    { time: '2026-09-14T17:00', temperature: 31.2, rainChance: 40, code: 61, isDay: true },
    { time: '2026-09-14T20:00', temperature: 26.4, rainChance: null, code: 1, isDay: false },
  ],
  days: [
    { date: '2026-09-14', code: 0, high: 32.1, low: 19.8, rainChance: 0, uv: 6.7, sunrise: '07:16', sunset: '19:46' },
    { date: '2026-09-15', code: 61, high: 26.8, low: 19.1, rainChance: 5, uv: 6.65, sunrise: '07:17', sunset: '19:44' },
    { date: '2026-09-16', code: 63, high: 25.5, low: 18.7, rainChance: 60, uv: 6.5, sunrise: '07:18', sunset: '19:43' },
  ],
  source: { title: 'Open-Meteo', url: 'https://open-meteo.com/', fetchedAt: '2026-09-14T15:00:00.000Z' },
}

describe('the weather card', () => {
  const card = cardFromMaterials('Weather in Lisbon', [lisbon], 0)!

  it("puts the place and its own date over now, the next hours, the week and the UV", () => {
    expect(card).toMatchObject({ recipe: 'weather', size: 'feature', title: 'Weather, Lisbon', asOf: '2026-09-14T16:45', partial: false })
    expect(card.sources).toEqual([{ title: 'Open-Meteo', url: 'https://open-meteo.com/', host: 'open-meteo.com' }])
    expect(card.blocks[0]).toEqual({ id: 'headline', slot: 'head', type: 'headline', kicker: 'Monday 14 September, 16:45', title: 'Lisbon', subtitle: 'Portugal' })
    expect(card.blocks[1]).toEqual({ id: 'now', slot: 'figure', type: 'stat', value: '32°C', label: 'Sunny' })
    expect(card.blocks[2]).toMatchObject({
      type: 'facts',
      items: [
        { label: 'Feels like', value: '32°C' },
        { label: 'High', value: '32°C' },
        { label: 'Low', value: '20°C' },
        { label: 'Wind', value: '7 km/h' },
        { label: 'Sunrise', value: '07:16' },
        { label: 'Sunset', value: '19:46' },
      ],
    })
    const forecast = card.blocks[3] as ForecastBlock
    expect(forecast.now).toEqual({ code: 0, isDay: true })
    expect(forecast.hours.map((hour) => hour.time)).toEqual(['16:00', '17:00', '20:00'])
    // The week is named the way it is said, and a rain code with a 5% chance draws as cloud.
    expect(forecast.days.map((day) => [day.day, day.code])).toEqual([
      ['Today', 0],
      ['Tomorrow', 3],
      ['Wednesday', 63],
    ])
    expect(card.blocks[4]).toMatchObject({ type: 'meter', label: 'UV index today', value: 6.7, min: 0, max: 12 })
  })

  it('survives the wire exactly as it was drawn, and is described as the weather', () => {
    expect(readCard(JSON.parse(JSON.stringify(card)))).toEqual(card)
    expect(describeCard(card)).toBe('a weather card for Lisbon: now, the next 3 hours and 3 days')
  })

  it('tells the speaking model what is on it, and lights a day as it is named', () => {
    expect(digestOf(card)).toContain('Next 3 hours: warmest 32°C at 16:00, coolest 26°C at 20:00, chance of rain up to 40%')
    expect(digestOf(card)).toContain('UV index today: 6.7 (high)')
    const forecast = card.blocks[3] as ForecastBlock
    expect(saidDays(forecast, hear('Tomorrow is cooler, and Wednesday brings rain.'))).toEqual(new Set(['d1', 'd2']))
    expect(saidDays(forecast, hear('It is hot out there.'))).toEqual(new Set())
  })
})

describe('reading a forecast and a meter off the wire', () => {
  it('keeps what can be drawn, and settles what cannot on something safe', () => {
    const read = readCard({
      schema: 2,
      recipe: 'weather',
      size: 'feature',
      query: 'q',
      title: 'Weather',
      blocks: [
        {
          id: 'f',
          type: 'forecast',
          unit: 'kelvin',
          now: { code: 'sunny' },
          hours: [{ time: '16:00', temperature: 30, rainChance: 140, code: 999 }, { time: '17:00', temperature: 'hot' }],
          days: [{ id: 'a', day: 'Today', date: '2026-09-14', high: 20, low: 25, code: 2, rainChance: -4 }, { day: 'Tomorrow', high: 20 }],
        },
        { id: 'm', type: 'meter', label: 'UV index today', value: 40, min: 0, max: 12, bands: [{ from: 0, to: 3, label: 'Low' }, { from: 5, to: 3, label: 'Backwards' }] },
        { id: 'm2', type: 'meter', label: 'No scale', value: 3, min: 5, max: 5, bands: [] },
      ],
      sources: [],
      asOf: null,
      partial: false,
    })!
    const forecast = read.blocks[0] as ForecastBlock
    expect(forecast.unit).toBe('°C')
    expect(forecast.now).toEqual({ code: 3, isDay: true })
    expect(forecast.hours).toEqual([{ time: '16:00', temperature: 30, rainChance: 100, code: 3, isDay: true }])
    // A low above its high is read as the high; a day with no low is left out.
    expect(forecast.days).toEqual([{ id: 'a', day: 'Today', date: '2026-09-14', code: 2, high: 20, low: 20, rainChance: 0 }])
    const meter = read.blocks[1] as MeterBlock
    expect(meter).toMatchObject({ value: 12, bands: [{ from: 0, to: 3, label: 'Low' }] })
    expect(read.blocks).toHaveLength(2)
  })
})
