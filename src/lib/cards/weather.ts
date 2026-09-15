/**
 * The words and scales a weather card is drawn with, shared by the server that
 * makes the card and the browser that draws it.
 *
 * A forecast arrives as numbers and WMO weather codes. What a code is called,
 * which band a UV index falls in and how a temperature is written are decided
 * here, in code, once: never by a model, and never differently on the card
 * from what the voice is told.
 */

/** The WMO weather interpretation codes a forecast uses, by what a person would call them. */
const CONDITIONS: Array<{ codes: number[]; day: string; night?: string; kind: WeatherKind }> = [
  { codes: [0], day: 'Sunny', night: 'Clear', kind: 'clear' },
  { codes: [1], day: 'Mainly sunny', night: 'Mainly clear', kind: 'clear' },
  { codes: [2], day: 'Partly cloudy', kind: 'partly' },
  { codes: [3], day: 'Overcast', kind: 'cloud' },
  { codes: [45, 48], day: 'Fog', kind: 'fog' },
  { codes: [51, 53, 55], day: 'Drizzle', kind: 'drizzle' },
  { codes: [56, 57], day: 'Freezing drizzle', kind: 'drizzle' },
  { codes: [61, 63], day: 'Rain', kind: 'rain' },
  { codes: [65], day: 'Heavy rain', kind: 'rain' },
  { codes: [66, 67], day: 'Freezing rain', kind: 'rain' },
  { codes: [71, 73, 77], day: 'Snow', kind: 'snow' },
  { codes: [75], day: 'Heavy snow', kind: 'snow' },
  { codes: [80, 81], day: 'Showers', kind: 'rain' },
  { codes: [82], day: 'Heavy showers', kind: 'rain' },
  { codes: [85, 86], day: 'Snow showers', kind: 'snow' },
  { codes: [95], day: 'Thunderstorms', kind: 'storm' },
  { codes: [96, 99], day: 'Thunderstorms with hail', kind: 'storm' },
]

/** What a condition looks like, for its icon. */
export type WeatherKind = 'clear' | 'partly' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm'

export function conditionOf(code: number, isDay = true): { text: string; kind: WeatherKind } {
  const found = CONDITIONS.find((condition) => condition.codes.includes(code))
  if (!found) return { text: 'Cloudy', kind: 'cloud' }
  return { text: isDay ? found.day : (found.night ?? found.day), kind: found.kind }
}

const WET: ReadonlySet<WeatherKind> = new Set(['drizzle', 'rain', 'snow', 'storm'])

/** Below this chance of rain, a day is not called wet, whatever its worst hour's code says. */
export const WET_DAY_CHANCE = 20

/**
 * A day's condition as it is shown and said. A forecast gives each day its most
 * severe code, so a day with a passing shower in one model run is "rain" beside
 * a 5% chance of any: said together, "rain, no rain expected". A wet code is
 * kept only when rain is at least somewhat likely, and is overcast otherwise.
 */
export function dayCode(code: number, rainChance: number | null): number {
  return WET.has(conditionOf(code).kind) && rainChance !== null && rainChance < WET_DAY_CHANCE ? 3 : code
}

/** A place with the parts that say where it is, leaving out a region named for the place itself: "Lisbon, Portugal". */
export function placeName(place: { name: string; region: string; country: string }): string {
  const region = place.region && !place.region.toLowerCase().startsWith(place.name.toLowerCase()) ? place.region : ''
  return [place.name, region, place.country].filter(Boolean).join(', ')
}

/** The WHO's UV index bands, which a meter is drawn in and a reading is named by. */
export const UV_BANDS = [
  { from: 0, to: 3, label: 'Low' },
  { from: 3, to: 6, label: 'Moderate' },
  { from: 6, to: 8, label: 'High' },
  { from: 8, to: 11, label: 'Very high' },
  { from: 11, to: 12, label: 'Extreme' },
] as const

/** A UV index as it is read: rounded to a whole number, then named by its band. */
export function uvBand(index: number): string {
  const rounded = Math.round(index)
  return (UV_BANDS.find((band) => rounded >= band.from && rounded < band.to) ?? UV_BANDS[UV_BANDS.length - 1]).label
}

export type TemperatureUnit = '°C' | '°F'

/** "30°", rounded as a forecast is read; the unit is said once, not at every figure. */
export function degrees(value: number): string {
  const rounded = Math.round(value)
  // A minus sign, not a hyphen, and never "-0°".
  return `${rounded < 0 ? '−' : ''}${Math.abs(rounded)}°`
}
