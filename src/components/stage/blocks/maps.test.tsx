// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { placeCard, routeCard, type MapPlace } from '../../../lib/cards/maps'
import type { CardV2 } from '../../../lib/cards/schema'
import { Stage } from '../Stage'

/**
 * A map card as it is read: the picture of the map named for anyone who
 * cannot see it, lettered pins listed under a route, and a place lighting up
 * as it is named. The live map needs WebGL and the network, so it is checked
 * in the lab rather than here.
 */

afterEach(cleanup)

const PUBLIC = 'pk.eyJ1IjoidGVzdCJ9.dGVzdA.c2ln'
const lisbon: MapPlace = { name: 'Lisbon', detail: 'Portugal', kind: 'capital', at: [-9.1333, 38.7167], timezone: 'Europe/Lisbon' }
const porto: MapPlace = { name: 'Porto', detail: 'Portugal', kind: 'city', at: [-8.611, 41.1496], timezone: 'Europe/Lisbon' }

function stage(card: CardV2, spoken = '') {
  return render(
    <Stage
      entries={[{ id: 'a', query: 'q', hint: 'web', card, leaving: false }]}
      frontId="a"
      tucking={false}
      spoken={spoken}
      onFocus={() => undefined}
      onTuck={() => undefined}
    />,
  )
}

describe('map cards', () => {
  it('shows a place as a named picture of its map, with no pin list for one pin', () => {
    const { container } = stage(placeCard({ question: 'where is Lisbon', place: lisbon, publicToken: PUBLIC, now: 0 }))
    const map = container.querySelector('.card-map')!
    expect(map.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Map of Lisbon')
    expect(map.querySelector('img.card-map-still')?.getAttribute('src')).toMatch(/^https:\/\/api\.mapbox\.com\/styles\/v1\/mapbox\/dark-v11\/static\//)
    expect(map.querySelector('.card-map-pins')).toBeNull()
    expect(container.querySelector('.card-title')?.textContent).toBe('Lisbon')
  })

  it('lists a route’s ends by letter, and lights the one that is named', () => {
    const card = routeCard({ question: 'Lisbon to Porto', from: lisbon, to: porto, travel: 'driving', route: { seconds: 10_740, metres: 312_400, line: [lisbon.at, porto.at], steps: [] }, publicToken: PUBLIC })
    const { container } = stage(card, 'Porto is about three hours up the coast.')
    const map = container.querySelector('.card-map')!
    expect(map.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Map of the way from Lisbon to Porto')
    const ends = [...map.querySelectorAll('.card-map-pins li')]
    expect(ends.map((each) => each.textContent)).toEqual(['ALisbon', 'BPorto'])
    expect(ends.map((each) => each.getAttribute('data-said'))).toEqual([null, 'true'])
  })
})
