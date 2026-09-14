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

export type Material = SeriesMaterial | RecordMaterial

export function isSeries(material: Material): material is SeriesMaterial {
  return material.kind === 'series'
}

export function isRecord(material: Material): material is RecordMaterial {
  return material.kind === 'record'
}
