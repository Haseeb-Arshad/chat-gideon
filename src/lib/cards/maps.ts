/**
 * Map cards: a place with its pin, and the way between two places.
 *
 * Shared by the server, which draws the cards from what Mapbox and Open-Meteo
 * returned, and the lab, which draws them from what they returned once. Every
 * figure is a provider's own, rounded as it is read, except the distance as the
 * crow flies, which is worked out here and labelled so.
 */

import type { Block, CardSource, CardV2, LngLat, MapBlock, MapPin } from './schema'

/** What a place is, as a person would call it. */
export type PlaceKind = 'country' | 'region' | 'capital' | 'city' | 'town' | 'landmark' | 'address' | 'area'

export interface MapPlace {
  name: string
  /** Where it is, beyond its name: "Portugal", "Paris, France", "Champ de Mars, 75007 Paris, France". */
  detail: string
  kind: PlaceKind
  at: LngLat
  /** An IANA timezone, when the provider gave one. */
  timezone?: string
  /** The west, south, east and north of the place, when it is a country or a region with an extent to show. */
  bounds?: [number, number, number, number]
}

export const MAP_SOURCES: CardSource[] = [
  { title: 'Mapbox', url: 'https://www.mapbox.com/about/maps/', host: 'mapbox.com' },
  { title: 'OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright', host: 'openstreetmap.org' },
]

/** How close a place is shown, by what it is. */
export const ZOOM: Record<PlaceKind, number> = { country: 4.5, region: 6.5, capital: 10, city: 10.5, town: 12, area: 13, landmark: 15, address: 16 }

const KIND_WORDS: Record<PlaceKind, string> = {
  country: 'Country',
  region: 'Region',
  capital: 'Capital city',
  city: 'City',
  town: 'Town',
  landmark: 'Place',
  address: 'Address',
  area: 'Area',
}

// -- The still -------------------------------------------------------------------------

/** Google's encoded polyline, at five decimal places, which is what the Static Images API reads a path as. */
export function encodePolyline(points: LngLat[]): string {
  let last = [0, 0]
  let out = ''
  for (const [longitude, latitude] of points) {
    const next = [Math.round(latitude * 1e5), Math.round(longitude * 1e5)]
    for (let axis = 0; axis < 2; axis += 1) {
      let value = next[axis] - last[axis]
      value = value < 0 ? ~(value << 1) : value << 1
      while (value >= 0x20) {
        out += String.fromCharCode((0x20 | (value & 0x1f)) + 63)
        value >>= 5
      }
      out += String.fromCharCode(value + 63)
    }
    last = next
  }
  return out
}

/** Every nth point, keeping both ends, so a long route fits in a picture's address. */
export function thinLine(points: LngLat[], most: number): LngLat[] {
  if (points.length <= most) return points
  const step = (points.length - 1) / (most - 1)
  return Array.from({ length: most }, (_, index) => points[Math.round(index * step)])
}

const fixed = ([longitude, latitude]: LngLat) => `${longitude.toFixed(4)},${latitude.toFixed(4)}`

/**
 * A Static Images API picture of a map block's view, in the night style the
 * live map is tuned toward. Only ever built with the public token: the browser
 * loads it.
 */
export function stillUrl(view: Pick<MapBlock, 'center' | 'zoom' | 'pins' | 'line' | 'bounds'>, publicToken: string, size: [number, number] = [640, 360]): string {
  const overlays: string[] = []
  if (view.line && view.line.length >= 2) overlays.push(`path-4+bfe9ff-0.9(${encodeURIComponent(encodePolyline(thinLine(view.line, 120)))})`)
  view.pins.slice(0, 10).forEach((pin, index) => overlays.push(`pin-s${view.pins.length > 1 ? `-${String.fromCharCode(97 + index)}` : ''}+bfe9ff(${fixed(pin.at)})`))
  const framing = (view.line && view.line.length >= 2) || view.pins.length > 1 ? 'auto' : `${fixed(view.center)},${Math.min(view.zoom, 16).toFixed(1)}`
  const query = new URLSearchParams({ access_token: publicToken, logo: 'true', attribution: 'true', ...(framing === 'auto' ? { padding: '48' } : {}) })
  return `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${overlays.join(',')}/${framing}/${size[0]}x${size[1]}@2x?${query}`
}

// -- Arithmetic that is shown ------------------------------------------------------------

/** The great-circle distance in kilometres. */
export function crowFlies([fromLongitude, fromLatitude]: LngLat, [toLongitude, toLatitude]: LngLat): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const deltaLatitude = radians(toLatitude - fromLatitude)
  const deltaLongitude = radians(toLongitude - fromLongitude)
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(radians(fromLatitude)) * Math.cos(radians(toLatitude)) * Math.sin(deltaLongitude / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** "3 h 7 min", "25 min", "under a minute". */
export function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
}

/** "315 km", "4.2 km", "650 m". */
export function distance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`
  const kilometres = metres / 1000
  return `${kilometres < 10 ? kilometres.toFixed(1).replace(/\.0$/, '') : Math.round(kilometres).toLocaleString('en-GB')} km`
}

/** "38.72° N, 9.14° W". */
export function coordinates([longitude, latitude]: LngLat): string {
  return `${Math.abs(latitude).toFixed(2)}° ${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(2)}° ${longitude >= 0 ? 'E' : 'W'}`
}

/** "GMT+1": how far a timezone is from GMT today, as the provider named it. */
export function offsetOf(timezone: string, now: number): string {
  try {
    const part = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(now).find((each) => each.type === 'timeZoneName')
    return part?.value ?? ''
  } catch {
    return ''
  }
}

/** The zoom at which a picture of this size holds the whole of these bounds, with a little room around them. */
export function zoomFor([west, south, east, north]: [number, number, number, number], [width, height]: [number, number] = [640, 360]): number {
  const mercator = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, latitude)) * Math.PI) / 360))
  const across = Math.log2((width * 360) / (512 * Math.max(east - west, 1e-4)))
  const down = Math.log2((height * 2 * Math.PI) / (512 * Math.max(mercator(north) - mercator(south), 1e-6)))
  return Math.round(Math.max(1, Math.min(16, Math.min(across, down) - 0.3)) * 10) / 10
}

/** The west, south, east and north that hold every point, a little wider. */
export function boundsOf(points: LngLat[]): [number, number, number, number] {
  const longitudes = points.map(([longitude]) => longitude)
  const latitudes = points.map(([, latitude]) => latitude)
  const pad = (low: number, high: number) => Math.max((high - low) * 0.08, 0.01)
  const west = Math.min(...longitudes)
  const east = Math.max(...longitudes)
  const south = Math.min(...latitudes)
  const north = Math.max(...latitudes)
  return [
    Math.max(west - pad(west, east), -180),
    Math.max(south - pad(south, north), -90),
    Math.min(east + pad(west, east), 180),
    Math.min(north + pad(south, north), 90),
  ]
}

// -- The cards ---------------------------------------------------------------------------

export interface PlaceCardInput {
  question: string
  place: MapPlace
  publicToken: string
  /** "24°C, sunny", when the weather there could be had in time. */
  weatherNow?: string
  now: number
}

export function placeCard({ question, place, publicToken, weatherNow, now }: PlaceCardInput): CardV2 {
  const pins: MapPin[] = [{ id: 'place', label: place.name, at: place.at }]
  const view = { center: place.at, zoom: place.bounds ? zoomFor(place.bounds) : ZOOM[place.kind], pins, ...(place.bounds ? { bounds: place.bounds } : {}) }
  const offset = place.timezone ? offsetOf(place.timezone, now) : ''
  const blocks: Block[] = [
    { id: 'headline', slot: 'head', type: 'headline', kicker: KIND_WORDS[place.kind], title: place.name, ...(place.detail ? { subtitle: place.detail } : {}) },
    { id: 'map', slot: 'data', type: 'map', view: 'pin', ...view, token: publicToken, still: stillUrl(view, publicToken) },
    {
      id: 'facts',
      slot: 'facts',
      type: 'facts',
      items: [
        { label: 'Coordinates', value: coordinates(place.at) },
        ...(place.timezone ? [{ label: 'Time zone', value: offset ? `${offset} (${place.timezone})` : place.timezone }] : []),
        ...(weatherNow ? [{ label: 'Weather now', value: weatherNow }] : []),
      ],
    },
  ]
  return { schema: 2, recipe: 'place', size: 'wide', query: question, title: place.name, blocks, sources: MAP_SOURCES, asOf: null, partial: false }
}

export type Travel = 'driving' | 'walking' | 'cycling'

export interface RouteCardInput {
  question: string
  from: MapPlace
  to: MapPlace
  travel: Travel
  /** Null when there is no way there by this kind of travel. */
  route: { seconds: number; metres: number; line: LngLat[]; steps: string[] } | null
  publicToken: string
}

/**
 * Turn-by-turn directions are worth a card's room for a walk or a ride across a
 * town, and not for a drive of hours, where the first turns out of a street are
 * no guide to the journey.
 */
export const STEPS_WITHIN_METRES = 30_000

const TRAVEL_WORDS: Record<Travel, { kicker: string; by: string }> = {
  driving: { kicker: 'By car', by: 'by road' },
  walking: { kicker: 'On foot', by: 'on foot' },
  cycling: { kicker: 'By bike', by: 'by bike' },
}

export function routeCard({ question, from, to, travel, route, publicToken }: RouteCardInput): CardV2 {
  const pins: MapPin[] = [
    { id: 'from', label: from.name, at: from.at },
    { id: 'to', label: to.name, at: to.at },
  ]
  const line = route?.line
  const bounds = boundsOf(line && line.length >= 2 ? line : [from.at, to.at])
  const view = { center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] as LngLat, zoom: 6, pins, bounds, ...(line && line.length >= 2 ? { line } : {}) }
  const straight = crowFlies(from.at, to.at)
  const words = TRAVEL_WORDS[travel]
  const blocks: Block[] = [
    { id: 'headline', slot: 'head', type: 'headline', kicker: words.kicker, title: `${from.name} to ${to.name}` },
    route
      ? { id: 'stat', slot: 'figure', type: 'stat', value: duration(route.seconds), label: `${distance(route.metres)} ${words.by}` }
      : { id: 'note', slot: 'figure', type: 'note', tone: 'info', text: `There is no way from ${from.name} to ${to.name} ${words.by}.` },
    { id: 'map', slot: 'data', type: 'map', view: 'route', ...view, token: publicToken, still: stillUrl(view, publicToken) },
    {
      id: 'facts',
      slot: 'facts',
      type: 'facts',
      items: [
        { label: 'From', value: from.detail ? `${from.name}, ${from.detail}` : from.name },
        { label: 'To', value: to.detail ? `${to.name}, ${to.detail}` : to.name },
        // Worked out here from the two points, not given by the provider.
        { label: 'As the crow flies', value: `${distance(straight * 1000)}, worked out` },
      ],
    },
  ]
  if (route?.steps.length && route.metres <= STEPS_WITHIN_METRES) blocks.push({ id: 'steps', slot: 'more', type: 'steps', items: route.steps.slice(0, 6) })
  return { schema: 2, recipe: 'route', size: 'wide', query: question, title: `${from.name} to ${to.name}`, blocks, sources: MAP_SOURCES, asOf: null, partial: false }
}
