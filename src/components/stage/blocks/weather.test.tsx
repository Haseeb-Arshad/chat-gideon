// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { cardFromMaterials } from '../../../lib/cards/from-materials'
import type { WeatherMaterial } from '../../../lib/cards/materials'
import type { CardV2 } from '../../../lib/cards/schema'
import { Stage } from '../Stage'
import { temperatureColour } from './Forecast'

/**
 * The weather card as it is read: now beside the next hours over the week,
 * every picture of the sky named, the UV said in words beside its colour, and
 * a day lighting up as it is named.
 */

afterEach(cleanup)

const material: WeatherMaterial = {
  id: 'weather:60.39,5.32:°C',
  kind: 'weather',
  place: { name: 'Bergen', region: 'Vestland', country: 'Norway', latitude: 60.39, longitude: 5.32, timezone: 'Europe/Oslo' },
  units: { temperature: '°C', wind: 'km/h' },
  current: { time: '2026-09-14T17:45', temperature: 13.6, feelsLike: 11.8, code: 61, isDay: true, wind: 14, humidity: 88 },
  hours: [
    { time: '2026-09-14T17:00', temperature: 13.8, rainChance: 70, code: 61, isDay: true },
    { time: '2026-09-14T18:00', temperature: 13.2, rainChance: 0, code: 3, isDay: true },
    { time: '2026-09-14T21:00', temperature: 11.9, rainChance: 20, code: 61, isDay: false },
    { time: '2026-09-14T22:00', temperature: 11.4, rainChance: null, code: 3, isDay: false },
  ],
  days: [
    { date: '2026-09-14', code: 61, high: 14.2, low: 8.1, rainChance: 33, uv: 2.1, sunrise: '06:58', sunset: '19:52' },
    { date: '2026-09-15', code: 63, high: 15.4, low: 13.6, rainChance: 100, uv: 1.2, sunrise: '07:01', sunset: '19:49' },
    { date: '2026-09-16', code: 3, high: 12.8, low: 10.9, rainChance: 0, uv: 2, sunrise: '07:03', sunset: '19:46' },
  ],
  source: { title: 'Open-Meteo', url: 'https://open-meteo.com/', fetchedAt: '2026-09-14T15:45:00.000Z' },
}

function stage(card: CardV2, spoken = '') {
  return render(
    <Stage
      entries={[{ id: 'a', query: 'q', hint: 'web', card, leaving: false }]}
      frontId="a"
      tucking={false}
      spoken={spoken}
      onFocus={() => undefined}
      onTuck={() => undefined}
    />,
  )
}

describe('weather layout', () => {
  const card = cardFromMaterials('Will it rain in Bergen?', [material], 0)!

  it('shows now with its sky named, how it feels, and the UV in words', () => {
    const { container } = stage(card)
    const weather = container.querySelector('.card-weather')!
    expect(weather.querySelector('.card-title')?.textContent).toBe('Bergen')
    expect(weather.querySelector('.weather-temperature')?.textContent).toBe('14°C')
    expect(weather.querySelector('.weather-condition')?.textContent).toBe('Rain')
    expect(weather.querySelector('.weather-now .weather-icon')?.getAttribute('aria-label')).toBe('Rain')
    expect([...weather.querySelectorAll('.weather-now .card-fact dt')].map((each) => each.textContent)).toEqual(['Feels like', 'High', 'Low', 'Wind', 'Sunrise', 'Sunset'])
    const meter = weather.querySelector('[role="meter"]')!
    expect(meter.getAttribute('aria-valuetext')).toBe('2, Low')
    expect(meter.querySelectorAll('.card-meter-track i')).toHaveLength(5)
  })

  it('draws the hours as a line with a column for each chance of rain, and shades the night', () => {
    const { container } = stage(card)
    const hours = container.querySelector('.forecast-hours')!
    expect(hours.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Next 4 hours: 14° now, warmest 14° at 17:00, coolest 11° at 22:00, rain most likely at 17:00, 70%.',
    )
    // An hour with no chance of rain, or none given, has no column at all.
    expect(hours.querySelectorAll('.forecast-rain')).toHaveLength(2)
    expect(hours.querySelectorAll('.forecast-night')).toHaveLength(1)
    expect(hours.querySelector('.forecast-line')?.getAttribute('points')?.split(' ')).toHaveLength(4)
  })

  it('sets out the week on one scale, with the chance of rain only where rain is likely, and lights a day as it is named', () => {
    const { container } = stage(card, 'Tomorrow is the wettest day.')
    const rows = [...container.querySelectorAll('.forecast-days li')]
    expect(rows.map((row) => row.querySelector('.forecast-day')?.textContent)).toEqual(['Today', 'Tomorrow', 'Wednesday'])
    expect(rows.map((row) => row.querySelector('.forecast-chance')?.textContent)).toEqual(['33%', '100%', ''])
    expect(rows.map((row) => row.getAttribute('data-said'))).toEqual([null, 'true', null])
    // The coldest low starts the scale and the warmest high ends it.
    const bar = (index: number) => (rows[index].querySelector('.forecast-range i') as HTMLElement).style
    expect([bar(0).left, bar(1).right]).toEqual(['0%', '0%'])
  })
})

describe('a forecast on another card', () => {
  it('draws its hours over its days in the body', () => {
    const card = cardFromMaterials('q', [material], 0)!
    const { container } = stage({ ...card, recipe: 'answer', size: 'standard' })
    expect(container.querySelector('.card-weather')).toBeNull()
    expect(container.querySelector('.card-body .card-forecast .forecast-hours')).not.toBeNull()
    expect(container.querySelector('.card-body [role="meter"]')).not.toBeNull()
  })
})

describe('temperature colours', () => {
  it('run from blue through green and amber to orange, the same in either unit', () => {
    expect(temperatureColour(-5, '°C')).toBe('rgb(57 135 229)')
    expect(temperatureColour(40, '°C')).toBe('rgb(217 89 38)')
    expect(temperatureColour(12, '°C')).toBe('rgb(25 158 112)')
    expect(temperatureColour(53.6, '°F')).toBe(temperatureColour(12, '°C'))
  })
})
