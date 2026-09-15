import { beforeEach, describe, expect, it } from 'vitest'
import type { WeatherMaterial } from '../cards/materials'
import type { CardV2, MapBlock } from '../cards/schema'
import { findPlace, forgetMaps, runMap, type MapsDeps } from './maps'
import type { Place, WeatherProvider } from './weather'

/**
 * The maps tool against Mapbox and Open-Meteo answering from fixtures cut from
 * what the live services returned on 15 September 2026. What is pinned: a name
 * gets the pin it surely means or a question, the secret token is used by the
 * server and never reaches a card, and a route with no way is said plainly.
 */

const PUBLIC = 'pk.eyJ1IjoidGVzdCJ9.cHVibGlj.c2ln'
const SECRET = 'sk.eyJ1IjoidGVzdCJ9.c2VjcmV0.c2ln'

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

/** What each name finds: Open-Meteo's places, Mapbox's geocoder, and Mapbox's landmarks. */
const WORLD: Record<string, { places?: Place[]; admin?: Fixture[]; sights?: Fixture[] }> = {
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

  it('goes where most landmarks holding the name are, by the plainest name there, past a restaurant called exactly it', async () => {
    expect(await place('Louvre')).toMatchObject({ place: { name: 'Louvre Museum' } })
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
    expect(seen.urls.every((url) => new URL(url).searchParams.get('access_token') === SECRET)).toBe(true)

    forgetMaps()
    const refused: Seen = { urls: [] }
    const outcome = await runMap({ mode: 'place', place: 'Tuscany' }, context, deps({ secretRefused: true }, refused), weather)
    expect(outcome.ok).toBe(true)
    expect(refused.urls.some((url) => new URL(url).searchParams.get('access_token') === PUBLIC)).toBe(true)
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

  it('says maps are not set up when there is no public token', async () => {
    const outcome = await runMap({ mode: 'place', place: 'Lisbon' }, context, { ...deps(), publicToken: '' }, weather)
    expect(outcome.content).toContain('not set up')
  })
})
