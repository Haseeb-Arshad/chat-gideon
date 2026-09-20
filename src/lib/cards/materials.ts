/**
 * What a card is made from: evidence captured by code from a source's own
 * response, with where it came from and when.
 *
 * A model never writes a material. The research desk calls a data source, the
 * response is parsed here into one of these shapes, and a card built from it
 * copies its values rather than retyping them, so a number on screen is the
 * number the source gave. The desk is told the same values in words, which is
 * what keeps the spoken answer and the card in agreement.
 */

export interface SourceRef {
  /** Who is credited on the card: "World Bank", "Wikidata". */
  title: string
  /** The page a person can open to check it, not the API that was called. */
  url: string
  /** When it was fetched, as an ISO timestamp. */
  fetchedAt: string
}

/** A number over time for one subject: a country's population by year. */
export interface SeriesMaterial {
  id: string
  kind: 'series'
  /** Groups series of the same measure, so two countries can share a chart. */
  measure: string
  /** What is measured: "Population". */
  name: string
  /** Who or what it is measured for: "Japan". */
  subject: string
  /** Said after a value, or before it for money: "", "%", "years", "US$". */
  unit: string
  /** Oldest first, one per year, only years that have a value. */
  points: Array<{ x: string; value: number }>
  source: SourceRef
}

export interface RecordField {
  /** Stable, so the same field on two records can be lined up: "born", "population". */
  key: string
  label: string
  value: string
}

export interface RecordEvent {
  /** As shown: "1903", "7 November 1867". */
  date: string
  /** Orders events whatever their precision; larger is later. */
  sort: number
  label: string
}

/** The structured record of one person, place, organisation or work. */
export interface RecordMaterial {
  id: string
  kind: 'record'
  /** What sort of thing it is, so two records are only compared when they are alike. */
  type: 'person' | 'country' | 'place' | 'organisation' | 'work' | 'thing'
  subject: string
  description: string
  fields: RecordField[]
  events: RecordEvent[]
  /** The exact title of its English Wikipedia article, for a portrait that is surely the right one. */
  wikipedia?: string
  coordinates?: { latitude: number; longitude: number }
  source: SourceRef
}

export interface Story {
  /** The publisher's own headline, with the publisher's name taken off it. */
  headline: string
  /** What happened, in a passage of the publisher's own words, without its dateline. */
  deck: string
  url: string
  host: string
  /** As the source reported it: an ISO timestamp, which may carry only a date. */
  published: string
  /** The story's own lead picture, https only. */
  image?: string
  /** How many outlets carried the same story: what makes a lead a lead. */
  outlets: number
}

/** The day's stories, or a topic's, most widely reported first. */
export interface StoriesMaterial {
  id: string
  kind: 'stories'
  /** What the stories are about, or empty for the day's headlines. */
  topic: string
  /** How far back they go. */
  since: 'day' | 'week'
  items: Story[]
  source: SourceRef
}

/** An hour of a forecast, in the place's own local time. */
export interface WeatherHour {
  /** "2026-09-14T13:00", local to the place. */
  time: string
  temperature: number
  /** Chance of rain, 0 to 100, or null where the forecast gives none. */
  rainChance: number | null
  /** A WMO weather code. */
  code: number
  isDay: boolean
}

export interface WeatherDay {
  /** "2026-09-14", local to the place. */
  date: string
  code: number
  high: number
  low: number
  rainChance: number | null
  /** The day's highest UV index, or null where the forecast gives none. */
  uv: number | null
  /** "07:16", local to the place, or null on a day the sun does not rise or set. */
  sunrise: string | null
  sunset: string | null
}

/** A forecast for one place, as the provider gave it, in the units it was asked for. */
export interface WeatherMaterial {
  id: string
  kind: 'weather'
  place: { name: string; region: string; country: string; latitude: number; longitude: number; timezone: string }
  units: { temperature: '°C' | '°F'; wind: 'km/h' | 'mph' }
  current: { time: string; temperature: number; feelsLike: number; code: number; isDay: boolean; wind: number; humidity: number }
  /** The next 24 hours, from the current one. */
  hours: WeatherHour[]
  /** Today and the days after it. */
  days: WeatherDay[]
  source: SourceRef
}

export type Material = SeriesMaterial | RecordMaterial | StoriesMaterial | WeatherMaterial | import('./table-mediation').TableMaterial

export function isSeries(material: Material): material is SeriesMaterial {
  return material.kind === 'series'
}

export function isRecord(material: Material): material is RecordMaterial {
  return material.kind === 'record'
}

export function isStories(material: Material): material is StoriesMaterial {
  return material.kind === 'stories'
}

export function isWeather(material: Material): material is WeatherMaterial {
  return material.kind === 'weather'
}
