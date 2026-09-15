import { describe, expect, it } from 'vitest'
import { compactOf } from './compact'
import { placeCard, routeCard, type MapPlace } from './maps'
import type { CardV2 } from './schema'

/**
 * A card drawn small beside the one in front. What is pinned: the name, what
 * kind of thing it is and one line of what it says, all taken from the card,
 * beside the picture that best says which card it is.
 */

const PUBLIC = 'pk.eyJ1IjoidGVzdCIsImEiOiJ0ZXN0In0.dGVzdHNpZ25hdHVyZQ'
const base = { schema: 2 as const, size: 'standard' as const, query: 'q', sources: [], asOf: null, partial: false }

describe('a card drawn small', () => {
  it('shows the weather by its sky, its temperature and what it is like', () => {
    const card: CardV2 = {
      ...base,
      recipe: 'weather',
      title: 'Weather, Rawalpindi',
      blocks: [
        { id: 'headline', slot: 'head', type: 'headline', kicker: 'Tuesday 15 September, 22:00', title: 'Rawalpindi' },
        { id: 'stat', slot: 'figure', type: 'stat', value: '26°C', label: 'Mainly clear' },
        { id: 'forecast', slot: 'data', type: 'forecast', unit: '°C', now: { code: 1, isDay: false }, hours: [], days: [] },
      ],
    }
    expect(compactOf(card)).toEqual({ kicker: 'Tuesday 15 September, 22:00', title: 'Rawalpindi', detail: '26°C · Mainly clear', thumb: { kind: 'sky', code: 1, isDay: false } })
  })

  it('shows a person by their portrait and what they were', () => {
    const card: CardV2 = {
      ...base,
      recipe: 'profile',
      title: 'Marie Curie',
      blocks: [
        { id: 'media', slot: 'media', type: 'media', image: { url: 'https://upload.wikimedia.org/curie.jpg', alt: 'Marie Curie', credit: 'Wikipedia' } },
        { id: 'headline', slot: 'head', type: 'headline', title: 'Marie Curie', subtitle: 'Physicist and chemist' },
        { id: 'facts', slot: 'facts', type: 'facts', items: [{ label: 'Born', value: '1867, Warsaw' }] },
      ],
    }
    expect(compactOf(card)).toEqual({ kicker: '', title: 'Marie Curie', detail: 'Physicist and chemist', thumb: { kind: 'image', url: 'https://upload.wikimedia.org/curie.jpg' } })
  })

  it('shows a map by its picture, and a route by how long it takes', () => {
    const lisbon: MapPlace = { name: 'Lisbon', detail: 'Portugal', kind: 'capital', at: [-9.13, 38.72] }
    const porto: MapPlace = { name: 'Porto', detail: 'Portugal', kind: 'city', at: [-8.61, 41.15] }
    const place = compactOf(placeCard({ question: 'where is Lisbon', place: lisbon, publicToken: PUBLIC, now: 0 }))
    expect(place).toMatchObject({ kicker: 'Capital city', title: 'Lisbon', detail: 'Portugal' })
    expect(place.thumb).toMatchObject({ kind: 'image', url: expect.stringMatching(/^https:\/\/api\.mapbox\.com\/styles\/v1\//) })
    const route = compactOf(routeCard({ question: 'Lisbon to Porto', from: lisbon, to: porto, travel: 'driving', route: { seconds: 10_740, metres: 312_400, line: [lisbon.at, porto.at], steps: [] }, publicToken: PUBLIC }))
    expect(route).toMatchObject({ kicker: 'By car', title: 'Lisbon to Porto', detail: '2 h 59 min · 312 km by road' })
  })

  it("names what kind of card it is when its headline does not, and survives a card with nothing to say", () => {
    const bare: CardV2 = { ...base, recipe: 'gallery', title: 'Chocolate cake', blocks: [] }
    expect(compactOf(bare)).toEqual({ kicker: 'Pictures', title: 'Chocolate cake', detail: '', thumb: null })
  })
})
