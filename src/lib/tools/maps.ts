/**
 * Maps: where a place is, and the way between two places.
 *
 * Finding the place is the part that can go wrong, and a wrong pin is worse
 * than no pin, so a name is looked up in three places at once and each is
 * trusted for what it is good at (see findPlace). Towns are judged by the rule
 * the weather uses: a capital, or five times the people of the next place with
 * the name, or else GIDEON asks, so the same "Portland" is Oregon on the map and
 * in the forecast. Routes, pictures and the live map are Mapbox's.
 *
 * Two tokens can be set. The secret one is for the server's own requests and
 * never leaves it; the public one is for the browser, which needs it for the
 * live map and loads the still with it anyway. A secret token without the scopes
 * a request needs is refused, and the public one is tried in its place.
 */

import { MAP_SOURCES, STEPS_WITHIN_METRES, coordinates, crowFlies, distance, duration, placeCard, routeCard, thinLine, type MapPlace, type PlaceKind, type Travel } from '../cards/maps'
import type { LngLat } from '../cards/schema'
import { conditionOf, degrees, placeName } from '../cards/weather'
import type { CoarseLocation } from '../location'
import type { ToolOutcome } from './registry'
import { TimedCache } from './desk/cache'
import { choosePlace, nameKey, unitFor, type Place, type WeatherProvider } from './weather'

const TIMEOUT_MS = 8_000
/** How long a place card waits for the weather there before going without it. */
const WEATHER_WAIT_MS = 2_500
/** A route's line, in as many points as the card keeps. */
const LINE_POINTS = 400

export interface MapsDeps {
  fetch: typeof fetch
  /** For the browser: the live map and the still. */
  publicToken: string
  /** For the server's own requests; the public token when there is none. */
  serverToken: string
  now: () => number
}

export interface MapsContext {
  signal: AbortSignal
  timezone: string
  location?: CoarseLocation | null
}

/** The token each pair of tokens has been found to work with, so a refusal is paid for once. */
const working = new Map<string, string>()

/** A Mapbox request with the server's token, or the public one if Mapbox refuses the server's. */
async function mapbox(deps: MapsDeps, url: string, signal: AbortSignal): Promise<Response> {
  const pair = `${deps.serverToken}|${deps.publicToken}`
  const known = working.get(pair)
  const tokens = [...new Set([known, deps.serverToken, deps.publicToken].filter((token): token is string => Boolean(token)))]
  let last: Response | null = null
  for (const token of tokens) {
    const response = await deps.fetch(`${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
    if (response.status !== 401 && response.status !== 403) {
      working.set(pair, token)
      return response
    }
    void response.body?.cancel()
    last = response
  }
  if (last) return last
  throw new Error('no Mapbox token')
}

// -- Finding a place --------------------------------------------------------------------

interface Feature {
  name: string
  /** Mapbox's feature type: country, region, district, place, locality, neighborhood, poi, address. */
  type: string
  detail: string
  country: string
  categories: string[]
  at: LngLat
  bounds?: [number, number, number, number]
}

function readFeatures(body: unknown): Feature[] {
  const features = (body as { features?: Array<{ properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } }> }).features ?? []
  return features.flatMap((feature) => {
    const properties = feature.properties ?? {}
    const coordinates = feature.geometry?.coordinates
    if (typeof properties.name !== 'string' || !Array.isArray(coordinates) || coordinates.length < 2) return []
    const [longitude, latitude] = coordinates
    if (typeof longitude !== 'number' || typeof latitude !== 'number') return []
    const type = typeof properties.feature_type === 'string' ? properties.feature_type : ''
    // A landmark's street address says where it is; a town's "full address" only repeats its name first.
    const address = type === 'poi' || type === 'address' ? properties.full_address : properties.place_formatted
    const context = (properties.context ?? {}) as { country?: { name?: unknown } }
    const box = Array.isArray(properties.bbox) && properties.bbox.length === 4 && properties.bbox.every((value) => typeof value === 'number') ? (properties.bbox as [number, number, number, number]) : undefined
    const categories = Array.isArray(properties.poi_category) ? properties.poi_category.filter((each): each is string => typeof each === 'string') : []
    return [
      {
        name: properties.name,
        type,
        detail: typeof address === 'string' ? address : '',
        country: typeof context.country?.name === 'string' ? context.country.name : type === 'country' ? properties.name : '',
        categories,
        at: [longitude, latitude] as LngLat,
        ...(box ? { bounds: box } : {}),
      },
    ]
  })
}

async function mapboxJson(deps: MapsDeps, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await mapbox(deps, url, signal)
  if (!response.ok) {
    void response.body?.cancel()
    throw new Error(`mapbox ${response.status}`)
  }
  return response.json()
}

/** Countries, regions, towns and neighbourhoods by name, the most prominent first. */
async function geocode(query: string, deps: MapsDeps, signal: AbortSignal): Promise<Feature[]> {
  const params = new URLSearchParams({ q: query, limit: '5', language: 'en', types: 'country,region,district,place,locality,neighborhood' })
  return readFeatures(await mapboxJson(deps, `https://api.mapbox.com/search/geocode/v6/forward?${params}`, signal))
}

/**
 * Somewhere to eat, shop, sleep or park, which shares a name with a place far
 * more often than it is the place asked about: the Machu Picchu restaurants in
 * Chile, Malta and America, beside the mountain in Peru.
 */
const TRADE = /food|drink|restaurant|caf|bar\b|pub\b|shop|store|lodging|hotel|hostel|apartment|service|salon|cosmetic|gym|fitness|parking|clinic|dentist|office|bank|fuel/i

/** Landmarks and addresses by name, nearest the user first when they are known to be somewhere. */
async function landmarks(query: string, deps: MapsDeps, signal: AbortSignal, near?: LngLat): Promise<Feature[]> {
  const params = new URLSearchParams({ q: query, limit: '8', language: 'en', types: 'poi,address', ...(near ? { proximity: `${near[0]},${near[1]}` } : {}) })
  const found = readFeatures(await mapboxJson(deps, `https://api.mapbox.com/search/searchbox/v1/forward?${params}`, signal))
  return found.filter((feature) => !feature.categories.some((category) => TRADE.test(category)))
}

function kindOf(place: Place): PlaceKind {
  const code = place.featureCode ?? ''
  if (code.startsWith('PCL')) return 'country'
  if (code.startsWith('ADM')) return 'region'
  // A part of a city: Times Square, Hollywood in Los Angeles.
  if (code === 'PPLX') return 'area'
  if (place.capital) return 'capital'
  return place.population >= 100_000 ? 'city' : 'town'
}

/** Where a place is beyond its name, unless that is only its name again: Georgia is in Georgia. */
function beyond(name: string, detail: string): string {
  const rest = detail.startsWith(`${name},`) ? detail.slice(name.length + 1).trim() : detail.trim()
  return nameKey(rest) === nameKey(name) ? '' : rest
}

function fromPlace(place: Place): MapPlace {
  return { name: place.name, detail: beyond(place.name, placeName(place)), kind: kindOf(place), at: [place.longitude, place.latitude], timezone: place.timezone }
}

/**
 * What each of Mapbox's feature types is called on the card. A "place" that
 * only Mapbox knew by the name is seldom a plain town (the Lake District is
 * one), so it is an area, framed by its own extent.
 */
const FEATURE_KINDS: Record<string, PlaceKind> = { country: 'country', region: 'region', district: 'region', place: 'area', locality: 'area', neighborhood: 'area', poi: 'landmark', address: 'address' }

function fromFeature(feature: Feature): MapPlace {
  const kind = FEATURE_KINDS[feature.type] ?? 'area'
  const framed = feature.bounds && kind !== 'landmark' && kind !== 'address'
  return { name: feature.name, detail: beyond(feature.name, feature.detail), kind, at: feature.at, ...(framed ? { bounds: feature.bounds } : {}) }
}

/** A town a place search found, or a county, a state or a country: not a heliport or a park that shares the name. */
const PEOPLED = /^(PPL|ADM|PCL)/

/** A place big enough that no region of the same name elsewhere is likelier: a capital, or a city of a million. */
const MAJOR = 1_000_000

/**
 * Fewer people than this, and a town is only a town by that name when Mapbox
 * agrees: the Machu Picchu with thirty people is a research station in
 * Antarctica, and the Lake District with none is a corner of San Francisco.
 */
const HAMLET = 1_000

/** How far apart two answers can be and still be the same place, in kilometres. */
const SAME_PLACE = 50

/** The one place a set of landmarks by the same name points to: all of them, or most of them, in one country. */
function oneLandmark(named: Feature[], key: string): Feature | null {
  const counts = new Map<string, number>()
  for (const feature of named) counts.set(feature.country, (counts.get(feature.country) ?? 0) + 1)
  const [country, count] = [...counts].sort((a, b) => b[1] - a[1])[0]
  if (counts.size > 1 && (count < 2 || count * 2 <= named.length)) return null
  const there = named.filter((feature) => feature.country === country)
  return there.find((feature) => nameKey(feature.name) === key) ?? [...there].sort((a, b) => a.name.length - b.name.length)[0]
}

/** How many words a name has: "Louvre Abu Dhabi" has three. */
const wordsIn = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length

/**
 * A landmark whose name holds the one asked for, and is a landmark's name
 * rather than a listing's: "Louvre Museum" for "Louvre", and not "Across from
 * the British Museum. The heart of London.", a flat to let, which has no
 * category and nine words.
 */
function holds(feature: Feature, name: string, key: string): boolean {
  return feature.categories.length > 0 && wordsIn(feature.name) <= wordsIn(name) + 2 && nameKey(feature.name).includes(key)
}

function askAbout(name: string, options: string[]): Found {
  return { ask: `${name} could be ${options.join(', or ')}. Ask the user which one they mean.` }
}

export type Found = { place: MapPlace } | { ask: string } | { none: string }

/**
 * The place a name surely means, a question to ask when it could be several,
 * or why there is none. Three searches run at once: Open-Meteo's places, which
 * know how many people live in each town; Mapbox's geocoder, which knows
 * countries, regions and neighbourhoods and ranks them by prominence; and
 * Mapbox's landmarks, which are searched by the name alone: asked for "British
 * Museum, London", the landmark search finds only flats to let near it, so a
 * region or country after a comma only filters what the name found. Then, in
 * order:
 *
 * 1. A country or a region by exactly that name: Tuscany, Georgia.
 * 2. Several towns by that name, none clearly the one: ask (Springfield).
 * 3. A town by that name with people in it, or one Mapbox puts in the same spot: Lisbon, Porto.
 * 4. A landmark by exactly that name, when those by that name are in one country: the Eiffel Tower.
 * 5. Any other place Mapbox knows by exactly that name: the Lake District, Times Square.
 * 6. A landmark whose name holds it, the same way, or the plainest name among them: the Louvre Museum.
 * 7. Last, the tiny town by that name.
 */
export async function findPlace(asked: string, deps: MapsDeps, weather: WeatherProvider, context: MapsContext): Promise<Found> {
  const name = asked.split(',')[0].trim()
  const qualifier = asked.split(',').slice(1).join(',').trim().toLowerCase()
  const key = nameKey(name)
  const near = context.location ? ([context.location.longitude, context.location.latitude] as LngLat) : undefined
  const [places, admin, found] = await Promise.all([
    weather.places(name, context.signal).catch(() => [] as Place[]),
    geocode(asked, deps, context.signal).catch(() => [] as Feature[]),
    landmarks(name, deps, context.signal, near).catch(() => [] as Feature[]),
  ])
  const sights = qualifier ? found.filter((feature) => `${feature.detail}, ${feature.country}`.toLowerCase().includes(qualifier)) : found

  const chosen = choosePlace(asked, places.filter((place) => PEOPLED.test(place.featureCode ?? 'PPL')))
  const town = chosen && 'place' in chosen && nameKey(chosen.place.name) === key ? chosen.place : null
  const area = admin.find((feature) => nameKey(feature.name) === key)

  if (area && (area.type === 'country' || area.type === 'region') && !(town && (town.capital || town.population >= MAJOR))) {
    return { place: fromFeature(area) }
  }
  if (chosen && 'options' in chosen) return askAbout(name, chosen.options.map(placeName))
  if (town && (town.population >= HAMLET || (area && crowFlies(area.at, [town.longitude, town.latitude]) < SAME_PLACE))) {
    return { place: fromPlace(town) }
  }

  const exact = sights.filter((feature) => nameKey(feature.name) === key)
  const landmark = exact.length ? oneLandmark(exact, key) : null
  if (landmark) return { place: fromFeature(landmark) }
  if (area) return { place: fromFeature(area) }

  const holding = key.length >= 5 ? sights.filter((feature) => holds(feature, name, key)) : []
  if (holding.length) {
    // Spread across countries, the plainest name is the one people mean: the Louvre Museum, not the Louvre Abu Dhabi.
    const one = oneLandmark(holding, key) ?? [...holding].sort((a, b) => a.name.length - b.name.length)[0]
    return { place: fromFeature(one) }
  }
  if (exact.length) return askAbout(name, exact.slice(0, 3).map((feature) => [feature.name, feature.detail].filter(Boolean).join(', ')))
  if (chosen && 'place' in chosen) return { place: fromPlace(chosen.place) }
  return { none: `No place called ${asked} could be found. Ask the user where they mean.` }
}

// -- The brief --------------------------------------------------------------------------

const KIND_PHRASE: Record<PlaceKind, string> = {
  country: 'a country',
  region: 'a region',
  capital: 'a capital city',
  city: 'a city',
  town: 'a town',
  landmark: 'a place',
  address: 'an address',
  area: 'an area',
}

async function weatherNow(pinned: MapPlace, weather: WeatherProvider, context: MapsContext): Promise<string | undefined> {
  const unit = unitFor(undefined, context.timezone)
  // The forecast is asked by coordinates, and finds the place's timezone itself.
  const place: Place = { name: pinned.name, region: '', country: '', latitude: pinned.at[1], longitude: pinned.at[0], timezone: pinned.timezone ?? 'UTC', population: 0, capital: false }
  const forecast = weather.forecast(place, unit, context.signal).catch(() => null)
  const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), WEATHER_WAIT_MS))
  const material = await Promise.race([forecast, late])
  if (!material) return undefined
  return `${degrees(material.current.temperature)}${unit === '°F' ? 'F' : 'C'}, ${conditionOf(material.current.code, material.current.isDay).text.toLowerCase()}`
}

// -- The tool ---------------------------------------------------------------------------

const PROFILES: Record<Travel, string> = { driving: 'driving-traffic', walking: 'walking', cycling: 'cycling' }
const routes = new TimedCache<{ seconds: number; metres: number; line: LngLat[]; steps: string[] } | null>(10 * 60_000)

async function directions(from: LngLat, to: LngLat, travel: Travel, deps: MapsDeps, signal: AbortSignal) {
  const key = `${travel}|${from.map((value) => value.toFixed(4)).join(',')}|${to.map((value) => value.toFixed(4)).join(',')}`
  return routes.get(key, async () => {
    const params = new URLSearchParams({ geometries: 'geojson', overview: 'simplified', steps: 'true', language: 'en' })
    const response = await mapbox(deps, `https://api.mapbox.com/directions/v5/mapbox/${PROFILES[travel]}/${from.join(',')};${to.join(',')}?${params}`, signal)
    const body = (await response.json()) as {
      code?: string
      routes?: Array<{ duration: number; distance: number; geometry?: { coordinates?: LngLat[] }; legs?: Array<{ steps?: Array<{ maneuver?: { instruction?: string } }> }> }>
    }
    // A request between places no road joins is answered, with no route in it.
    if (!response.ok && body.code !== 'NoRoute') throw new Error(`mapbox directions ${response.status}`)
    const route = body.routes?.[0]
    if (!route) return null
    return {
      seconds: route.duration,
      metres: route.distance,
      line: thinLine(route.geometry?.coordinates ?? [], LINE_POINTS),
      steps: (route.legs?.[0]?.steps ?? []).map((step) => step.maneuver?.instruction ?? '').filter(Boolean),
    }
  })
}

const onScreen = (what: string) => `On the user's screen now: ${what}. Do not read out coordinates or the card.`

export async function runMap(args: Record<string, unknown>, context: MapsContext, deps: MapsDeps, weather: WeatherProvider): Promise<ToolOutcome> {
  if (!deps.publicToken) return { ok: false, content: 'Maps are not set up here. Say so in one short sentence.' }
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).replace(/\s+/g, ' ').trim().slice(0, 120) : '')
  const failed = (error: unknown): ToolOutcome => {
    if (context.signal.aborted) throw error
    return { ok: false, content: 'The map could not be reached just now. Say so in one short sentence.', summary: 'Could not get the map' }
  }
  const now = deps.now()

  if (args.mode === 'route') {
    const to = text('to')
    if (!to) return { ok: false, content: 'No destination was given. Ask the user where they want to go.' }
    const travel: Travel = args.travel === 'walking' || args.travel === 'cycling' ? args.travel : 'driving'
    const fromName = text('from')
    try {
      const [start, end] = await Promise.all([
        fromName
          ? findPlace(fromName, deps, weather, context)
          : Promise.resolve<Found>(
              context.location
                ? { place: { name: context.location.city, detail: [context.location.region, context.location.country].filter(Boolean).join(', '), kind: 'city', at: [context.location.longitude, context.location.latitude], timezone: context.location.timezone } }
                : { ask: 'No starting point was given, and where the user is is not known. Ask them where they are starting from.' },
            ),
        findPlace(to, deps, weather, context),
      ])
      for (const found of [start, end]) {
        if ('ask' in found) return { ok: false, content: found.ask }
        if ('none' in found) return { ok: false, content: found.none, summary: 'Place not found' }
      }
      const from = (start as { place: MapPlace }).place
      const dest = (end as { place: MapPlace }).place
      const route = await directions(from.at, dest.at, travel, deps, context.signal)
      const straight = distance(crowFlies(from.at, dest.at) * 1000)
      const how = travel === 'driving' ? 'by car' : travel === 'walking' ? 'on foot' : 'by bike'
      const guessed = !fromName ? `No starting point was given, so this starts from where the user's connection places them, roughly: ${from.name}. Say so, in case that is wrong.\n` : ''
      const shortWay = Boolean(route?.steps.length && route.metres <= STEPS_WITHIN_METRES)
      const card = routeCard({ question: `${fromName || from.name} to ${to}`, from, to: dest, travel, route, publicToken: deps.publicToken })
      const content = route
        ? `${guessed}${from.name} to ${dest.name} ${how}: ${duration(route.seconds)}, ${distance(route.metres)}${travel === 'driving' ? ', with traffic as it is now' : ''}. As the crow flies, ${straight} (worked out).${shortWay ? ` First directions: ${route.steps.slice(0, 3).join(' ')}` : ''}\n${onScreen(shortWay ? 'a map of the route with the time, the distance and the first directions' : 'a map of the route with the time and the distance')} Say how long it takes and how far it is, in one sentence.`
        : `${guessed}There is no way from ${from.name} to ${dest.name} ${how}. As the crow flies they are ${straight} apart (worked out).\n${onScreen('a map with both places')} Say so plainly, and do not guess at a flight.`
      return {
        ok: true,
        content,
        summary: route ? `${from.name} to ${dest.name}: ${duration(route.seconds)}` : `No route from ${from.name} to ${dest.name}`,
        links: MAP_SOURCES.map((source) => ({ title: source.title, url: source.url })),
        card: Promise.resolve(card),
      }
    } catch (error) {
      return failed(error)
    }
  }

  const asked = text('place')
  if (!asked) return { ok: false, content: 'No place was given. Ask the user which place they mean.' }
  try {
    const found = await findPlace(asked, deps, weather, context)
    if ('ask' in found) return { ok: false, content: found.ask }
    if ('none' in found) return { ok: false, content: found.none, summary: 'Place not found' }
    const { place } = found
    const wanted = place.kind !== 'country' && place.kind !== 'region' ? await weatherNow(place, weather, context) : undefined
    const card = placeCard({ question: asked, place, publicToken: deps.publicToken, ...(wanted ? { weatherNow: wanted } : {}), now })
    return {
      ok: true,
      content: `${place.name}${place.detail ? `, ${place.detail}` : ''}: ${KIND_PHRASE[place.kind]}, at ${coordinates(place.at)}.${wanted ? ` The weather there now: ${wanted}.` : ''}\n${onScreen(`a map of ${place.name}`)} Say where it is in one sentence, such as its region and country and what it is near, only as far as you are sure.`,
      summary: `Map of ${place.name}`,
      links: MAP_SOURCES.map((source) => ({ title: source.title, url: source.url })),
      card: Promise.resolve(card),
    }
  } catch (error) {
    return failed(error)
  }
}

/** For tests: forget which token works and every route. */
export function forgetMaps() {
  working.clear()
  routes.clear()
}

