import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WeatherMaterial } from '../cards/materials'
import type { CardV2, MapBlock } from '../cards/schema'
import type { CoarseLocation } from '../location'
import { findPlace, forgetMaps, runMap, withCardMap, type MapsDeps } from './maps'
import type { RecordMaterial } from '../cards/materials'
import type { Place, WeatherProvider } from './weather'

/**
 * The maps tool against Mapbox and Open-Meteo answering from fixtures cut from
 * what the live services returned on 15 September 2026. What is pinned: a name
 * gets the pin it surely means or a question, the secret token is used by the
 * server and never reaches a card, and a route with no way is said plainly.
 */

const PUBLIC = 'pk.eyJ1IjoidGVzdCIsImEiOiJwdWJsaWMifQ.cHVibGljc2lnbmF0dXJl'
const SECRET = 'sk.eyJ1IjoidGVzdCIsImEiOiJzZWNyZXQifQ.c2VjcmV0c2lnbmF0dXJl'

const town = (name: string, extra: Partial<Place> = {}): Place => ({
  name,
  region: '',
  country: 'United States',
  latitude: 0,
  longitude: 0,
  timezone: 'UTC',
  population: 100_000,
  capital: false,
  featureCode: 'PPL',
  ...extra,
})

interface Fixture {
  name: string
  feature_type: string
  place_formatted?: string
  full_address?: string
  country?: string
  poi_category?: string[]
  bbox?: number[]
  at: [number, number]
}

const features = (items: Fixture[]) => ({
  type: 'FeatureCollection',
  features: items.map(({ at, country, ...properties }) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: at },
    properties: { ...properties, ...(country ? { context: { country: { name: country } } } : {}) },
  })),
})

interface Article {
  title: string
  description: string
  at: [number, number]
}

/** What each name finds: Open-Meteo's places, Mapbox's geocoder, Mapbox's landmarks, and Wikipedia's article. */
const WORLD: Record<string, { places?: Place[]; admin?: Fixture[]; sights?: Fixture[]; wiki?: Article }> = {
  lisbon: {
    places: [town('Lisbon', { country: 'Portugal', capital: true, latitude: 38.72, longitude: -9.13, timezone: 'Europe/Lisbon', featureCode: 'PPLC' }), town('Lisbon', { region: 'Maine', population: 9_000 })],
    admin: [{ name: 'Lisbon', feature_type: 'place', place_formatted: 'Portugal', at: [-9.14, 38.71] }],
  },
  tuscany: {
    places: [town('Tuscany', { region: 'Alberta', country: 'Canada', population: 0, featureCode: 'PPLX' })],
    admin: [{ name: 'Tuscany', feature_type: 'region', place_formatted: 'Italy', country: 'Italy', bbox: [9.69, 42.32, 12.37, 44.47], at: [11.26, 43.77] }],
  },
  springfield: {
    places: [town('Springfield', { region: 'Missouri', population: 169_000 }), town('Springfield', { region: 'Illinois', population: 114_000 })],
    admin: [{ name: 'Springfield', feature_type: 'place', place_formatted: 'Missouri, United States', at: [-93.29, 37.21] }],
    sights: [{ name: 'Springfield Park', feature_type: 'poi', full_address: 'London E5, United Kingdom', country: 'United Kingdom', poi_category: ['park'], at: [-0.06, 51.57] }],
  },
  'lake district': {
    places: [town('Lake District', { region: 'California', population: 0, featureCode: 'PPLX', latitude: 37.79, longitude: -122.47 })],
    admin: [{ name: 'Lake District', feature_type: 'place', place_formatted: 'England, United Kingdom', country: 'United Kingdom', bbox: [-3.64, 54, -2.49, 55], at: [-3.17, 54.5] }],
  },
  'machu picchu': {
    places: [town('Machu Picchu', { country: '', population: 30, latitude: -62.09, longitude: -58.47 })],
    admin: [{ name: 'Machu Picchu', feature_type: 'place', place_formatted: 'Cusco, Peru', country: 'Peru', at: [-72.52, -13.15] }],
    sights: [
      { name: 'Machu Picchu', feature_type: 'poi', full_address: 'Santiago, Chile', country: 'Chile', poi_category: ['food', 'food and drink'], at: [-70.6, -33.4] },
      { name: 'Machu Picchu', feature_type: 'poi', full_address: 'Machu Picchu, 08680, Peru', country: 'Peru', poi_category: ['mountain'], at: [-72.54, -13.17] },
    ],
  },
  louvre: {
    sights: [
      { name: 'Louvre', feature_type: 'poi', full_address: 'Klingengasse 15, Rothenburg ob der Tauber, Germany', country: 'Germany', poi_category: ['food', 'food and drink', 'japanese restaurant', 'restaurant'], at: [10.18, 49.38] },
      { name: 'Musee du Louvre - Departement des Antiquites Orientales', feature_type: 'poi', full_address: '75001 Paris, France', country: 'France', poi_category: ['museum'], at: [2.337, 48.861] },
      { name: 'Louvre Museum', feature_type: 'poi', full_address: '1 Av. du Général Lemonnier, 75001 Paris, France', country: 'France', poi_category: ['museum'], at: [2.3376, 48.8606] },
      { name: 'Louvre Abu Dhabi', feature_type: 'poi', full_address: 'Saadiyat Island, Abu Dhabi, United Arab Emirates', country: 'United Arab Emirates', poi_category: ['museum'], at: [54.4, 24.53] },
    ],
    wiki: { title: 'Louvre', description: 'Art museum in Paris, France', at: [2.3358, 48.8611] },
  },
  // Mapbox has no Faisal Mosque in Islamabad by that name, and several King Faisal Mosques elsewhere.
  'faisal mosque': {
    sights: [
      { name: 'King Faisal Mosque', feature_type: 'poi', full_address: 'King Abdul Aziz St, Sharjah, United Arab Emirates', country: 'United Arab Emirates', poi_category: ['mosque'], at: [55.388, 25.349] },
      { name: 'King Faisal Mosque', feature_type: 'poi', full_address: '175-177 Commonwealth St, Sydney 2010, Australia', country: 'Australia', poi_category: ['mosque'], at: [151.21, -33.88] },
    ],
    wiki: { title: 'Faisal Mosque', description: "World's sixth-largest mosque in Islamabad, Pakistan", at: [73.0372, 33.7297] },
  },
  'king faisal mosque': {
    sights: [
      { name: 'King Faisal Mosque', feature_type: 'poi', full_address: 'King Abdul Aziz St, Sharjah, United Arab Emirates', country: 'United Arab Emirates', poi_category: ['mosque'], at: [55.388, 25.349] },
      { name: 'King Faisal Mosque', feature_type: 'poi', full_address: '175-177 Commonwealth St, Sydney 2010, Australia', country: 'Australia', poi_category: ['mosque'], at: [151.21, -33.88] },
    ],
  },
  'british museum': {
    sights: [
      { name: 'Across from the British Museum. The heart of London.', feature_type: 'poi', full_address: 'London, United Kingdom', country: 'United Kingdom', poi_category: [], at: [-0.126, 51.518] },
      { name: 'The British Museum', feature_type: 'poi', full_address: 'Great Russell Street, London, WC1B 3DG, United Kingdom', country: 'United Kingdom', poi_category: ['museum', 'tourist attraction'], at: [-0.1269, 51.5194] },
    ],
  },
  'eiffel tower': {
    sights: [{ name: 'Eiffel Tower', feature_type: 'poi', full_address: 'Champ de Mars, 75007 Paris, France', country: 'France', poi_category: ['monument'], at: [2.2945, 48.8584] }],
  },
  porto: {
    places: [town('Porto', { country: 'Portugal', population: 249_600, latitude: 41.15, longitude: -8.61, timezone: 'Europe/Lisbon' })],
  },
  atlantis: {},
}

const weather: WeatherProvider = {
  name: 'fixture',
  async places(name) {
    return WORLD[name.toLowerCase()]?.places ?? []
  },
  async forecast() {
    return { current: { temperature: 24.4, code: 0, isDay: true } } as unknown as WeatherMaterial
  },
}

interface Seen {
  urls: string[]
}

function deps(options: { secretRefused?: boolean; route?: 'found' | 'none' } = {}, seen: Seen = { urls: [] }): MapsDeps {
  return {
    publicToken: PUBLIC,
    serverToken: SECRET,
    now: () => Date.UTC(2026, 8, 15, 12),
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      seen.urls.push(url.toString())
      if (url.hostname === 'en.wikipedia.org') {
        const name = decodeURIComponent(url.pathname.split('/').pop() ?? '').toLowerCase()
        const found = WORLD[name]?.wiki
        return found
          ? Response.json({ type: 'standard', title: found.title, description: found.description, coordinates: { lat: found.at[1], lon: found.at[0] } })
          : Response.json({ type: 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found' }, { status: 404 })
      }
      if (options.secretRefused && url.searchParams.get('access_token') === SECRET) return new Response('{"message":"Forbidden"}', { status: 403 })
      const query = (url.searchParams.get('q') ?? '').toLowerCase()
      if (url.pathname.startsWith('/search/geocode/v6/')) return Response.json(features(WORLD[query]?.admin ?? []))
      if (url.pathname.startsWith('/search/searchbox/v1/')) return Response.json(features(WORLD[query]?.sights ?? []))
      if (url.pathname.startsWith('/directions/v5/')) {
        if (options.route === 'none') return Response.json({ code: 'NoRoute', message: 'No route found', routes: [] }, { status: 422 })
        return Response.json({
          code: 'Ok',
          routes: [
            {
              duration: 10_740,
              distance: 312_400,
              geometry: { coordinates: [[-9.13, 38.72], [-8.9, 39.9], [-8.61, 41.15]] },
              legs: [{ steps: [{ maneuver: { instruction: 'Drive north.' } }, { maneuver: { instruction: 'Take the A1.' } }] }],
            },
          ],
        })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch,
  }
}

const context = { signal: new AbortController().signal, timezone: 'Europe/London' }
const place = async (name: string) => findPlace(name, deps(), weather, context)

beforeEach(() => forgetMaps())

describe('finding a place', () => {
  it('takes the capital, and a region over a hamlet sharing its name', async () => {
    expect(await place('Lisbon')).toMatchObject({ place: { name: 'Lisbon', detail: 'Portugal', kind: 'capital', timezone: 'Europe/Lisbon' } })
    expect(await place('Tuscany')).toMatchObject({ place: { name: 'Tuscany', detail: 'Italy', kind: 'region', bounds: [9.69, 42.32, 12.37, 44.47] } })
  })

  it('asks about towns sharing a name, and does not settle for a park with it', async () => {
    const found = await place('Springfield')
    expect(found).toHaveProperty('ask')
    expect('ask' in found && found.ask).toContain('Missouri')
    expect('ask' in found && found.ask).toContain('Illinois')
  })

  it('takes the place Mapbox knows over a nameless corner of another city', async () => {
    expect(await place('Lake District')).toMatchObject({ place: { detail: 'England, United Kingdom', kind: 'area' } })
  })

  it('takes a landmark over restaurants and a research station with its name, without its name again in where it is', async () => {
    expect(await place('Machu Picchu')).toMatchObject({ place: { kind: 'landmark', detail: '08680, Peru', at: [-72.54, -13.17] } })
    expect(await place('Eiffel Tower')).toMatchObject({ place: { name: 'Eiffel Tower', kind: 'landmark' } })
  })

  it('goes where the article by the name is about, past a restaurant called exactly it', async () => {
    expect(await place('Louvre')).toMatchObject({ place: { name: 'Louvre', detail: 'Art museum in Paris, France', kind: 'landmark', at: [2.3358, 48.8611] } })
  })

  it('takes the famous place over businesses with the name in theirs, and asks when there is nothing famous to go by', async () => {
    expect(await place('Faisal Mosque')).toMatchObject({ place: { name: 'Faisal Mosque', at: [73.0372, 33.7297] } })
    expect(await place('King Faisal Mosque')).toHaveProperty('ask')
    // Explicit qualifiers are never discarded just because they match the user location.
    const location = { city: 'Rawalpindi', region: 'Punjab', country: 'Pakistan', latitude: 33.6, longitude: 73.05, timezone: 'Asia/Karachi' }
    expect(await findPlace('Faisal Mosque, Punjab', deps(), weather, { ...context, location })).toHaveProperty('none')
    expect(await findPlace('Faisal Mosque, Punjab, Pakistan', deps(), weather, { ...context, location })).toHaveProperty('none')
    expect(await findPlace('Faisal Mosque, Sindh', deps(), weather, { ...context, location })).toHaveProperty('none')
    // Unverified combined qualifiers do not justify guessing.
    expect(await findPlace('Faisal Mosque, Pakistan Islamabad Capital Territory', deps(), weather, context)).toHaveProperty('none')
    // Every explicit region must be supported.
    expect(await findPlace('Faisal Mosque, Margalla Hills, Islamabad Capital Territory, Pakistan', deps(), weather, context)).toHaveProperty('none')
    // The town the model added without a comma is read as one.
    expect(await place('Faisal Mosque Islamabad')).toMatchObject({ place: { name: 'Faisal Mosque', at: [73.0372, 33.7297] } })
  })

  it('searches landmarks by the name alone, and lets what follows a comma only filter them', async () => {
    expect(await place('British Museum, London')).toMatchObject({ place: { name: 'The British Museum', kind: 'landmark' } })
    expect(await place('Eiffel Tower, Japan')).toHaveProperty('none')
  })

  it('says when there is no such place', async () => {
    expect(await place('Atlantis')).toHaveProperty('none')
  })
})

describe('the tool', () => {
  it('puts a place on screen with only the public token on the card', async () => {
    const outcome = await runMap({ mode: 'place', place: 'Lisbon' }, context, deps(), weather)
    expect(outcome.ok).toBe(true)
    expect(outcome.content).toContain('Lisbon, Portugal: a capital city')
    expect(outcome.content).toContain('The weather there now: 24°C, sunny')
    const card = (await outcome.card) as CardV2
    const text = JSON.stringify(card)
    expect(text).toContain(PUBLIC)
    expect(text).not.toContain(SECRET)
  })

  it('uses the secret token for its own requests, and the public one when Mapbox refuses the secret', async () => {
    const seen: Seen = { urls: [] }
    await runMap({ mode: 'place', place: 'Tuscany' }, context, deps({}, seen), weather)
    const mapbox = (urls: string[]) => urls.filter((url) => new URL(url).hostname === 'api.mapbox.com')
    expect(mapbox(seen.urls).every((url) => new URL(url).searchParams.get('access_token') === SECRET)).toBe(true)

    forgetMaps()
    const refused: Seen = { urls: [] }
    const outcome = await runMap({ mode: 'place', place: 'Tuscany' }, context, deps({ secretRefused: true }, refused), weather)
    expect(outcome.ok).toBe(true)
    expect(mapbox(refused.urls).some((url) => new URL(url).searchParams.get('access_token') === PUBLIC)).toBe(true)
  })

  it('draws a route, and starts from where the user is, saying so, when no start is given', async () => {
    const location = { city: 'Lisbon', region: 'Lisbon', country: 'Portugal', latitude: 38.72, longitude: -9.13, timezone: 'Europe/Lisbon' }
    const outcome = await runMap({ mode: 'route', to: 'Porto' }, { ...context, location }, deps(), weather)
    expect(outcome.ok).toBe(true)
    expect(outcome.content).toContain('starts from where the user')
    expect(outcome.content).toContain('Lisbon to Porto by car: 2 h 59 min, 312 km')
    const card = (await outcome.card) as CardV2
    expect(card.recipe).toBe('route')
    expect((card.blocks.find((block) => block.type === 'map') as MapBlock).line).toHaveLength(3)
  })

  it('asks where to start when no start is given and where the user is is not known', async () => {
    const outcome = await runMap({ mode: 'route', to: 'Porto' }, context, deps(), weather)
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.content).toContain('Ask them where they are starting from')
  })

  it('says plainly when no road joins two places', async () => {
    const outcome = await runMap({ mode: 'route', from: 'Lisbon', to: 'Porto', travel: 'walking' }, context, deps({ route: 'none' }), weather)
    expect(outcome.ok).toBe(true)
    expect(outcome.content).toContain('There is no way from Lisbon to Porto on foot')
  })

  it('passes a question back rather than guessing', async () => {
    const outcome = await runMap({ mode: 'place', place: 'Springfield' }, context, deps(), weather)
    expect(outcome.ok).toBe(false)
    expect(outcome.card).toBeUndefined()
  })

  it('gives up on a place that takes too long, rather than holding the answer', async () => {
    vi.useFakeTimers()
    try {
      const hanging: MapsDeps = {
        ...deps(),
        fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch,
      }
      const pending = runMap({ mode: 'place', place: 'Lisbon' }, context, hanging, { ...weather, places: () => new Promise<Place[]>(() => undefined) })
      await vi.advanceTimersByTimeAsync(12_000)
      expect(await pending).toMatchObject({ ok: false, summary: 'The map took too long' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('says maps are not set up when there is no public token', async () => {
    const outcome = await runMap({ mode: 'place', place: 'Lisbon' }, context, { ...deps(), publicToken: '' }, weather)
    expect(outcome.content).toContain('not set up')
  })
})

describe('a research card about a place', () => {
  const profile = (title: string): CardV2 => ({
    schema: 2,
    recipe: 'profile',
    size: 'standard',
    query: 'q',
    title,
    blocks: [{ id: 'headline', slot: 'head', type: 'headline', title }],
    sources: [],
    asOf: null,
    partial: false,
  })
  const mapOf = (card: CardV2) => card.blocks.find((block) => block.type === 'map') as MapBlock | undefined

  it("puts the place on a map from its own record's coordinates", async () => {
    const record: RecordMaterial = {
      id: 'wikidata:Q1', kind: 'record', type: 'place', subject: 'Faisal Mosque', description: 'mosque in Islamabad', fields: [], events: [],
      coordinates: { latitude: 33.7297, longitude: 73.0372 },
      source: { title: 'Wikidata', url: 'https://www.wikidata.org/wiki/Q1', fetchedAt: '2026-09-15T00:00:00.000Z' },
    }
    const card = await withCardMap(profile('Faisal Mosque'), 'tell me about the Faisal Mosque', [record], deps(), weather, context)
    expect(mapOf(card)).toMatchObject({ view: 'pin', center: [73.0372, 33.7297], token: PUBLIC, pins: [{ label: 'Faisal Mosque' }] })
  })

  it('asked where, finds the place the way the maps tool does, and adds nothing when unsure or not asked where', async () => {
    expect(mapOf(await withCardMap(profile('Faisal Mosque'), 'Where is the Faisal Mosque?', [], deps(), weather, context))?.center).toEqual([73.0372, 33.7297])
    expect(mapOf(await withCardMap(profile('Springfield'), 'where is Springfield', [], deps(), weather, context))).toBeUndefined()
    // A card named after a place's article gets its map whatever was asked; one named after nothing with coordinates does not.
    expect(mapOf(await withCardMap(profile('Faisal Mosque'), 'who built the Faisal Mosque', [], deps(), weather, context))?.center).toEqual([73.0372, 33.7297])
    expect(mapOf(await withCardMap(profile('Ada Lovelace'), 'who was Ada Lovelace', [], deps(), weather, context))).toBeUndefined()
    expect(mapOf(await withCardMap(profile('Faisal Mosque'), 'Where is the Faisal Mosque?', [], { ...deps(), publicToken: '' }, weather, context))).toBeUndefined()
  })
})

describe('what is nearby', () => {
  interface Listing {
    name: string
    detail: string
    metres: number
    at: [number, number]
  }

  /** Category ids answered from a fixture, everything else (finding "near") from the ordinary deps. */
  function withCategories(byId: Record<string, Listing[]>): MapsDeps {
    const base = deps()
    return {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const match = url.pathname.match(/\/search\/searchbox\/v1\/category\/([\w]+)$/)
        if (!match) return base.fetch(input, init)
        const items = byId[match[1]] ?? []
        return Response.json({
          type: 'FeatureCollection',
          features: items.map((item) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: item.at },
            properties: { name: item.name, place_formatted: item.detail, distance: item.metres },
          })),
        })
      }) as typeof fetch,
    }
  }

  const islamabad: CoarseLocation = { city: 'Islamabad', region: 'Islamabad Capital Territory', country: 'Pakistan', latitude: 33.7, longitude: 73.05, timezone: 'Asia/Karachi' }

  it('asks for a common kind of place, and never guesses at one it does not know', async () => {
    const outcome = await runMap({ mode: 'nearby', category: 'haunted houses', near: 'Lisbon' }, context, deps(), weather)
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toContain('not a kind of place this can search for')
    expect(outcome.card).toBeUndefined()
  })

  it('finds the place first, then searches every canonical id the category means, merges and sorts them', async () => {
    const nearby = withCategories({
      cafe: [{ name: 'Copenhagen Coffee', detail: 'Chiado', metres: 900, at: [-9.14, 38.71] }],
      coffee_shop: [{ name: 'Fabrica Coffee Roasters', detail: 'Baixa', metres: 300, at: [-9.139, 38.709] }],
    })
    const outcome = await runMap({ mode: 'nearby', category: 'cafes', near: 'Lisbon' }, context, nearby, weather)
    expect(outcome.ok).toBe(true)
    expect(outcome.content).toContain('Fabrica Coffee Roasters, Copenhagen Coffee')
    const card = await outcome.card
    expect(card?.recipe).toBe('nearby')
    const map = card?.blocks.find((block) => block.type === 'map') as MapBlock
    // Nearest first: the second query's result outranks the first's.
    expect(map.pins.map((pin) => pin.label)).toEqual(['Fabrica Coffee Roasters', 'Copenhagen Coffee'])
  })

  it('knows a kind of food by how people say it', async () => {
    const nearby = withCategories({ pizza_restaurant: [{ name: 'Da Michele', detail: 'Trastevere', metres: 700, at: [12.47, 41.89] }] })
    const outcome = await runMap({ mode: 'nearby', category: 'pizza places', near: 'Lisbon' }, context, nearby, weather)
    expect(outcome.ok).toBe(true)
    expect(outcome.content).toContain('Da Michele')
  })

  it('says plainly when nothing is close enough to call nearby, and names how far the nearest actually is', async () => {
    const farAway = withCategories({ restaurant: [{ name: 'Quality Restaurant', detail: 'Poonch', metres: 98_000, at: [74.3, 33.7] }] })
    const outcome = await runMap({ mode: 'nearby', category: 'restaurants', near: 'Lisbon' }, context, farAway, weather)
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toContain('98 km away')
    expect(outcome.content).toContain('do not name any from memory')
    expect(outcome.card).toBeUndefined()
  })

  it('searches around the user when no place was given, and says so', async () => {
    const nearby = withCategories({ pharmacy: [{ name: 'Al Shifa Pharmacy', detail: 'F-7 Markaz', metres: 500, at: [73.06, 33.71] }] })
    const outcome = await runMap({ mode: 'nearby', category: 'pharmacies' }, { ...context, location: islamabad }, nearby, weather)
    expect(outcome.ok).toBe(true)
    expect(outcome.content).toContain("where the user's connection places them")
    expect(outcome.content).toContain('Al Shifa Pharmacy')
  })

  it('asks where to search when no place was given and where the user is is not known', async () => {
    const outcome = await runMap({ mode: 'nearby', category: 'restaurants' }, context, deps(), weather)
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toContain('where the user is is not known')
  })
})
