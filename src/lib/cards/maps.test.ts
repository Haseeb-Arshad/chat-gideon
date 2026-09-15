import { describe, expect, it } from 'vitest'
import { digestOf } from './digest'
import { boundsOf, coordinates, crowFlies, distance, duration, encodePolyline, placeCard, routeCard, stillUrl, thinLine, zoomFor, type MapPlace } from './maps'
import { hear, saidPins } from './mentions'
import { readCard } from './read'
import type { LngLat, MapBlock } from './schema'

/**
 * Map cards. What is pinned: the arithmetic shown on them (the one figure not
 * from a provider is labelled as worked out), the still is a Mapbox picture of
 * the same view, and a card read back from the wire keeps a public token and
 * loses anything else.
 */

const PUBLIC = 'pk.eyJ1IjoidGVzdCIsImEiOiJ0ZXN0In0.dGVzdHNpZ25hdHVyZQ'
const lisbon: MapPlace = { name: 'Lisbon', detail: 'Portugal', kind: 'capital', at: [-9.1333, 38.7167], timezone: 'Europe/Lisbon' }
const porto: MapPlace = { name: 'Porto', detail: 'Portugal', kind: 'city', at: [-8.611, 41.1496], timezone: 'Europe/Lisbon' }
const mapOf = (card: { blocks: Array<{ type: string }> }) => card.blocks.find((block) => block.type === 'map') as MapBlock

describe('the arithmetic', () => {
  it('encodes a line the way the Static Images API reads one', () => {
    // Google's own worked example, as longitude and latitude.
    expect(encodePolyline([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]])).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
  })

  it('thins a long line to the points it can carry, keeping both ends', () => {
    const line = Array.from({ length: 1000 }, (_, index): LngLat => [index / 100, 0])
    const thin = thinLine(line, 120)
    expect(thin).toHaveLength(120)
    expect(thin[0]).toEqual(line[0])
    expect(thin.at(-1)).toEqual(line.at(-1))
  })

  it('says distances, times and coordinates as a person would', () => {
    expect(Math.round(crowFlies(lisbon.at, porto.at))).toBe(274)
    expect(distance(312_400)).toBe('312 km')
    expect(distance(4_240)).toBe('4.2 km')
    expect(distance(2_000)).toBe('2 km')
    expect(distance(648)).toBe('650 m')
    expect(duration(10_740)).toBe('2 h 59 min')
    expect(duration(3_600)).toBe('1 h')
    expect(duration(20)).toBe('under a minute')
    expect(coordinates([-9.1333, 38.7167])).toBe('38.72° N, 9.13° W')
  })

  it('frames a region by its extent: a country far out, a city close in', () => {
    const tuscany: [number, number, number, number] = [9.69, 42.32, 12.37, 44.47]
    const london: [number, number, number, number] = [-0.51, 51.29, 0.33, 51.69]
    expect(zoomFor(tuscany)).toBeGreaterThan(5)
    expect(zoomFor(tuscany)).toBeLessThan(8)
    expect(zoomFor(london)).toBeGreaterThan(zoomFor(tuscany))
    const [west, south, east, north] = boundsOf([lisbon.at, porto.at])
    expect(west).toBeLessThan(-9.1333)
    expect(east).toBeGreaterThan(-8.611)
    expect(south).toBeLessThan(38.7167)
    expect(north).toBeGreaterThan(41.1496)
  })
})

describe('the still', () => {
  it('centres one pin, fits a route, and carries only the token it was given', () => {
    const one = stillUrl({ center: lisbon.at, zoom: 10, pins: [{ id: 'place', label: 'Lisbon', at: lisbon.at }] }, PUBLIC)
    expect(one).toMatch(/^https:\/\/api\.mapbox\.com\/styles\/v1\/mapbox\/dark-v11\/static\/pin-s\+bfe9ff\(-9\.1333,38\.7167\)\/-9\.1333,38\.7167,10\.0\/640x360@2x\?/)
    expect(new URL(one).searchParams.get('access_token')).toBe(PUBLIC)
    const route = stillUrl({ center: [0, 0], zoom: 6, pins: [{ id: 'from', label: 'Lisbon', at: lisbon.at }, { id: 'to', label: 'Porto', at: porto.at }], line: [lisbon.at, porto.at] }, PUBLIC)
    expect(route).toContain('/path-4+bfe9ff-0.9(')
    expect(route).toContain('pin-s-a+bfe9ff')
    expect(route).toContain('/auto/')
  })
})

describe('the cards', () => {
  it('puts a place on a map, with the facts the providers gave', () => {
    const card = placeCard({ question: 'where is Lisbon', place: lisbon, publicToken: PUBLIC, weatherNow: '24°C, sunny', now: Date.UTC(2026, 8, 15, 12) })
    expect(card.recipe).toBe('place')
    expect(card.blocks.map((block) => block.type)).toEqual(['headline', 'map', 'facts'])
    const facts = card.blocks.find((block) => block.type === 'facts')
    expect(facts).toMatchObject({ items: [{ label: 'Coordinates' }, { label: 'Time zone', value: 'GMT+1 (Europe/Lisbon)' }, { label: 'Weather now', value: '24°C, sunny' }] })
    expect(mapOf(card)).toMatchObject({ view: 'pin', center: lisbon.at, zoom: 10, token: PUBLIC })
    expect(digestOf(card)).toContain('Map of Lisbon')
  })

  it('frames a region by its bounds rather than a zoom for its kind', () => {
    const region: MapPlace = { name: 'Tuscany', detail: 'Italy', kind: 'region', at: [11.26, 43.77], bounds: [9.69, 42.32, 12.37, 44.47] }
    const map = mapOf(placeCard({ question: 'where is Tuscany', place: region, publicToken: PUBLIC, now: 0 }))
    expect(map.bounds).toEqual(region.bounds)
    expect(map.zoom).toBe(zoomFor(region.bounds!))
  })

  it('draws a route with its time and distance, and the distance as the crow flies labelled as worked out', () => {
    const card = routeCard({
      question: 'Lisbon to Porto',
      from: lisbon,
      to: porto,
      travel: 'driving',
      route: { seconds: 10_740, metres: 312_400, line: [lisbon.at, [-8.9, 39.9], porto.at], steps: ['Drive north.', 'Take the A1.'] },
      publicToken: PUBLIC,
    })
    // A drive of hours leaves its first turns off the card.
    expect(card.blocks.map((block) => block.type)).toEqual(['headline', 'stat', 'map', 'facts'])
    expect(card.blocks.find((block) => block.type === 'stat')).toMatchObject({ value: '2 h 59 min', label: '312 km by road' })
    expect(card.blocks.find((block) => block.type === 'facts')).toMatchObject({ items: [{}, {}, { label: 'As the crow flies', value: '274 km, worked out' }] })
    expect(mapOf(card).line).toHaveLength(3)
  })

  it('lists the turns for a walk across a town', () => {
    const walk = routeCard({ question: 'walk', from: lisbon, to: porto, travel: 'walking', route: { seconds: 1_500, metres: 2_000, line: [lisbon.at, porto.at], steps: ['Walk north.', 'Turn left.'] }, publicToken: PUBLIC })
    expect(walk.blocks.find((block) => block.type === 'steps')).toMatchObject({ items: ['Walk north.', 'Turn left.'] })
    expect(walk.blocks.find((block) => block.type === 'stat')).toMatchObject({ label: '2 km on foot' })
  })

  it('says plainly when there is no way there', () => {
    const newYork: MapPlace = { name: 'New York', detail: 'United States', kind: 'city', at: [-74.006, 40.7128] }
    const card = routeCard({ question: 'London to New York', from: lisbon, to: newYork, travel: 'driving', route: null, publicToken: PUBLIC })
    expect(card.blocks.map((block) => block.type)).toEqual(['headline', 'note', 'map', 'facts'])
    expect(mapOf(card).line).toBeUndefined()
  })
})

describe('reading a map block back', () => {
  const card = placeCard({ question: 'where is Lisbon', place: lisbon, publicToken: PUBLIC, now: 0 })

  it('keeps a card it drew exactly', () => {
    expect(readCard(JSON.parse(JSON.stringify(card)))).toEqual(card)
  })

  it('drops a map with a secret token, or a still from anywhere but Mapbox', () => {
    const withMap = (change: Partial<MapBlock>) => ({ ...card, blocks: card.blocks.map((block) => (block.type === 'map' ? { ...block, ...change } : block)) })
    const types = (value: unknown) => readCard(value)?.blocks.map((block) => block.type)
    expect(types(withMap({ token: 'sk.eyJ1IjoidGVzdCIsImEiOiJ0ZXN0In0.c2VjcmV0c2lnbmF0dXJl' }))).toEqual(['headline', 'facts'])
    expect(types(withMap({ still: 'https://example.com/map.png' }))).toEqual(['headline', 'facts'])
    expect(types(withMap({ still: mapOf(card).still.replace(PUBLIC, 'sk.eyJ1IjoidGVzdCIsImEiOiJ0ZXN0In0.c2VjcmV0c2lnbmF0dXJl') }))).toEqual(['headline', 'facts'])
  })
})

describe('lighting pins', () => {
  it('lights the pin whose place was named', () => {
    const card = routeCard({ question: 'Lisbon to Porto', from: lisbon, to: porto, travel: 'driving', route: null, publicToken: PUBLIC })
    expect([...saidPins(mapOf(card), hear('Porto is about three hours north'))]).toEqual(['to'])
  })
})
