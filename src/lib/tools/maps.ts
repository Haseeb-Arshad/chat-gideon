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

import { MAP_SOURCES, STEPS_WITHIN_METRES, ZOOM, stillUrl, zoomFor, coordinates, crowFlies, distance, duration, placeCard, routeCard, thinLine, type MapPlace, type PlaceKind, type Travel } from '../cards/maps'
import { blockOf, type CardV2, type LngLat, type MapBlock } from '../cards/schema'
import type { Material, RecordMaterial } from '../cards/materials'
import { conditionOf, degrees, placeName } from '../cards/weather'
import { whereWords, type CoarseLocation } from '../location'
import type { ToolOutcome } from './registry'
import { TimedCache } from './desk/cache'
import { choosePlace, nameKey, qualifiedBy, qualifiersOf, unitFor, type Place, type WeatherProvider } from './weather'

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

// -- Naming a position ------------------------------------------------------------------

/** The kinds of feature a position is named by, the most useful first: a town before its suburb. */
const NAMING_ORDER = ['place', 'locality', 'neighborhood', 'district', 'region']

/**
 * The town a position is in, by Mapbox's reverse geocoder: "Rawalpindi, Punjab,
 * Pakistan" for 33.60, 73.05. Null when there is no token or no answer, and the
 * position is then only a position.
 */
export async function nameAt(latitude: number, longitude: number, deps: MapsDeps, signal: AbortSignal): Promise<{ city: string; region: string; country: string } | null> {
  if (!deps.publicToken && !deps.serverToken) return null
  const params = new URLSearchParams({ longitude: String(longitude), latitude: String(latitude), types: NAMING_ORDER.join(','), language: 'en' })
  const body = (await mapboxJson(deps, `https://api.mapbox.com/search/geocode/v6/reverse?${params}`, signal)) as {
    features?: Array<{ properties?: { name?: unknown; feature_type?: unknown; context?: Record<string, { name?: unknown }> } }>
  }
  const features = (body.features ?? []).map((feature) => feature.properties ?? {})
  const best = NAMING_ORDER.map((type) => features.find((feature) => feature.feature_type === type)).find(Boolean)
  if (!best || typeof best.name !== 'string') return null
  const part = (key: string) => (typeof best.context?.[key]?.name === 'string' ? (best.context[key].name as string) : '')
  return { city: best.name, region: best.feature_type === 'region' ? '' : part('region'), country: part('country') }
}

/** The user's own position as a location, named when it can be, for the tools that need to know where "here" is. */
export async function locateDevice(position: { latitude: number; longitude: number }, timezone: string, deps: MapsDeps, signal: AbortSignal): Promise<CoarseLocation> {
  const named = await nameAt(position.latitude, position.longitude, deps, signal).catch(() => null)
  return { city: named?.city || 'their location', region: named?.region ?? '', country: named?.country ?? '', ...position, timezone: timezone || 'UTC', from: 'device' }
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

/** Wikipedia asks to be told who is asking. */
const WIKIPEDIA_AGENT = 'GIDEON/1.0 (voice companion; maps)'
const articles = new TimedCache<Article | null>(24 * 60 * 60_000)

interface Article {
  title: string
  /** Wikipedia's own line for it: "World's sixth-largest mosque in Islamabad, Pakistan". */
  description: string
  at: LngLat
}

/**
 * The Wikipedia article by exactly that name, when it is about one place and
 * has its coordinates. A notable place almost always has one, and an article is
 * about the famous one: "Faisal Mosque" is the mosque in Islamabad, where a
 * search of businesses finds a King Faisal Mosque in Sharjah first. A name
 * that could be several things is a disambiguation page, and counts for nothing.
 */
async function article(name: string, deps: MapsDeps, signal: AbortSignal): Promise<Article | null> {
  return articles.get(nameKey(name), async () => {
    const response = await deps.fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}?redirect=true`, {
      headers: { 'Api-User-Agent': WIKIPEDIA_AGENT, 'User-Agent': WIKIPEDIA_AGENT },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
    if (!response.ok) {
      void response.body?.cancel()
      return null
    }
    const body = (await response.json()) as { type?: unknown; title?: unknown; description?: unknown; coordinates?: { lat?: unknown; lon?: unknown } }
    const { lat, lon } = body.coordinates ?? {}
    if (body.type !== 'standard' || typeof body.title !== 'string' || typeof lat !== 'number' || typeof lon !== 'number') return null
    return { title: body.title, description: typeof body.description === 'string' ? body.description : '', at: [lon, lat] }
  })
}

/** What an article's description says the place is, for how close to show it. */
function kindFromDescription(description: string): PlaceKind {
  if (/\bcountry\b/i.test(description)) return 'country'
  if (/\b(region|province|state|valley|district|county|national park|mountain range|island|lake|desert)\b/i.test(description)) return 'region'
  if (/\b(capital|city|town|village|neighbourhood|neighborhood|suburb)\b/i.test(description)) return 'city'
  return 'landmark'
}

function fromArticle(found: Article): MapPlace {
  return { name: found.title, detail: found.description, kind: kindFromDescription(found.description), at: found.at }
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
 * region or country after a comma only filters what the name found. Wikipedia
 * is the fourth, for the famous place a name means. Then, in order:
 *
 * 1. A country or a region by exactly that name: Tuscany, Georgia.
 * 2. Several towns by that name, none clearly the one: ask (Springfield).
 * 3. A town by that name with people in it, or one Mapbox puts in the same spot: Lisbon, Porto.
 * 4. A landmark by exactly that name, when those by that name are in one country: the Eiffel Tower.
 * 5. Any other place Mapbox knows by exactly that name, when Wikipedia's article by that name agrees: the Lake District.
 * 6. The place Wikipedia's article by that name is about: the Louvre, the Faisal Mosque.
 * 7. A landmark whose name holds it, when most of those are in one country; a question when they are spread out.
 * 8. Last, the tiny town by that name.
 */
export async function findPlace(asked: string, deps: MapsDeps, weather: WeatherProvider, context: MapsContext): Promise<Found> {
  const name = asked.split(',')[0].trim()
  const qualifiers = qualifiersOf(asked)
  const key = nameKey(name)
  const near = context.location ? ([context.location.longitude, context.location.latitude] as LngLat) : undefined
  const [places, admin, found, wiki] = await Promise.all([
    weather.places(name, context.signal).catch(() => [] as Place[]),
    geocode(asked, deps, context.signal).catch(() => [] as Feature[]),
    landmarks(name, deps, context.signal, near).catch(() => [] as Feature[]),
    article(name, deps, context.signal).catch(() => null),
  ])
  const sights = found.filter((feature) => qualifiedBy(qualifiers, feature.detail, feature.country))

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
  // A region after a comma has to be where the article says the place is.
  const famous = wiki && qualifiedBy(qualifiers, wiki.description) ? wiki : null
  // Where the two agree, Mapbox's answer has the extent and the country; where they do not, the article is about the famous one.
  if (area && (!famous || crowFlies(area.at, famous.at) < SAME_PLACE)) return { place: fromFeature(area) }
  if (famous) return { place: fromArticle(famous) }

  // "Faisal Mosque Islamabad": the town the model knew it was in, without the comma that says so. Tried
  // before names that only hold the words, which would take "Eiffel Tower Paris" to a replica in Texas.
  const words = asked.split(/\s+/)
  if (!asked.includes(',') && words.length >= 3) {
    for (const tail of [1, 2]) {
      if (words.length - tail < 2) break
      const retried = await findPlace(`${words.slice(0, -tail).join(' ')}, ${words.slice(-tail).join(' ')}`, deps, weather, context)
      if (!('none' in retried)) return retried
    }
  }

  const holding = key.length >= 5 ? sights.filter((feature) => holds(feature, name, key)) : []
  if (holding.length) {
    const one = oneLandmark(holding, key)
    if (one) return { place: fromFeature(one) }
    // Spread across countries, "the plainest name" once put the Faisal Mosque in Sharjah: ask instead.
    return askAbout(name, holding.slice(0, 3).map((feature) => [feature.name, feature.detail].filter(Boolean).join(', ')))
  }
  if (exact.length) return askAbout(name, exact.slice(0, 3).map((feature) => [feature.name, feature.detail].filter(Boolean).join(', ')))
  if (chosen && 'place' in chosen) return { place: fromPlace(chosen.place) }

  // "Lake Saiful Muluk, Rawalpindi, Pakistan": where the user is, added to a place that is not there. Searched again without it.
  const here = context.location
  const theirs = new Set([here?.city, here?.region, here?.country].filter((part): part is string => Boolean(part)).map(nameKey))
  if (qualifiers.length && qualifiers.every((part) => theirs.has(part))) return findPlace(name, deps, weather, context)
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

/** The longest a map may keep an answer waiting. Each lookup has its own limit; a name tried several ways adds them up. */
const MAP_DEADLINE_MS = 12_000

export async function runMap(args: Record<string, unknown>, context: MapsContext, deps: MapsDeps, weather: WeatherProvider): Promise<ToolOutcome> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([context.signal, deadline.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<ToolOutcome>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort()
      resolve({ ok: false, content: 'Finding that place took too long. Say so in one short sentence, and ask which place they mean.', summary: 'The map took too long' })
    }, MAP_DEADLINE_MS)
  })
  try {
    return await Promise.race([drawMap(args, { ...context, signal }, deps, weather), late])
  } catch (error) {
    // Given up on by the deadline rather than the turn: the deadline's answer stands.
    if (deadline.signal.aborted && !context.signal.aborted) return late
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function drawMap(args: Record<string, unknown>, context: MapsContext, deps: MapsDeps, weather: WeatherProvider): Promise<ToolOutcome> {
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
        if ('none' in found) return { ok: false, content: found.none, summary: `Place not found: ${found === start ? fromName : to}` }
      }
      const from = (start as { place: MapPlace }).place
      const dest = (end as { place: MapPlace }).place
      const route = await directions(from.at, dest.at, travel, deps, context.signal)
      const straight = distance(crowFlies(from.at, dest.at) * 1000)
      const how = travel === 'driving' ? 'by car' : travel === 'walking' ? 'on foot' : 'by bike'
      const guessed = !fromName && context.location ? `No starting point was given, so this starts from ${whereWords(context.location)}.\n` : ''
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
  if (!asked && !context.location) {
    return { ok: false, content: 'No place was given, and where the user is could not be found (they may not have allowed it). Ask them which place they mean.' }
  }
  try {
    const here = context.location
    const found: Found = asked
      ? await findPlace(asked, deps, weather, context)
      : { place: { name: here!.city, detail: [here!.region, here!.country].filter(Boolean).join(', '), kind: 'city', at: [here!.longitude, here!.latitude], timezone: here!.timezone } }
    if ('ask' in found) return { ok: false, content: found.ask }
    if ('none' in found) return { ok: false, content: found.none, summary: `Place not found: ${asked}` }
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

// -- A map for a card about a place ----------------------------------------------------------

/** How long a card about a place waits for its map before going without. */
const CARD_MAP_WAIT_MS = 3_000

/** A where question, however it is put: "where is", "where's", "whereabouts". */
const ASKS_WHERE = /\bwhere(?:'s|abouts)?\b/i

function mapBlock(label: string, at: LngLat, zoom: number, publicToken: string, bounds?: [number, number, number, number]): MapBlock {
  const view = { center: at, zoom, pins: [{ id: 'place', label, at }], ...(bounds ? { bounds } : {}) }
  return { id: 'map', slot: 'data', type: 'map', view: 'pin', ...view, token: publicToken, still: stillUrl(view, publicToken) }
}

/**
 * A research card about a place, with the place on a map. From the place's own
 * record when it has coordinates, which is certain; then from the Wikipedia
 * article the card is named after, when it has coordinates, which only a place's
 * article has, so "Faisal Mosque" gets its map and "Marie Curie" none. Last,
 * when the question asked where, from the same search the maps tool uses, and
 * only when that is sure which place it is: a card with no map is better than
 * one with the wrong town on it. The card goes out as it was if the map is slow.
 */
export async function withCardMap(card: CardV2, question: string, materials: Material[], deps: MapsDeps, weather: WeatherProvider, context: MapsContext): Promise<CardV2> {
  if (!deps.publicToken || blockOf(card, 'map') || blockOf(card, 'forecast') || blockOf(card, 'stories')) return card
  const record = materials.find((material): material is RecordMaterial => material.kind === 'record' && material.subject === card.title)
  if (record?.coordinates && (record.type === 'place' || record.type === 'country')) {
    const at: LngLat = [record.coordinates.longitude, record.coordinates.latitude]
    return { ...card, blocks: [...card.blocks, mapBlock(card.title, at, record.type === 'country' ? ZOOM.country : ZOOM.landmark - 2, deps.publicToken)] }
  }
  const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), CARD_MAP_WAIT_MS))
  const famous = await Promise.race([article(card.title, deps, context.signal).catch(() => null), late])
  if (famous) {
    const kind = kindFromDescription(famous.description)
    return { ...card, blocks: [...card.blocks, mapBlock(card.title, famous.at, kind === 'landmark' ? ZOOM.landmark - 1 : ZOOM[kind], deps.publicToken)] }
  }
  if (!ASKS_WHERE.test(question)) return card
  const found = await Promise.race([findPlace(card.title, deps, weather, context).catch(() => null), late])
  if (!found || !('place' in found)) return card
  const { place } = found
  return { ...card, blocks: [...card.blocks, mapBlock(card.title, place.at, place.bounds ? zoomFor(place.bounds) : ZOOM[place.kind], deps.publicToken, place.bounds)] }
}

/** For tests: forget which token works, every route and every article. */
export function forgetMaps() {
  working.clear()
  routes.clear()
  articles.clear()
}

