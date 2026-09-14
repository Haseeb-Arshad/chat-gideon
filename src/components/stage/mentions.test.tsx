// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CardV2 } from '../../lib/cards/schema'
import { GLANCE_EVENT, gazeToward } from './glance'
import { Stage } from './Stage'

/**
 * A card read aloud: what GIDEON mentions lights up where it is, only on the
 * card in front, and the face is told where to glance.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const card: CardV2 = {
  schema: 2,
  recipe: 'compare',
  size: 'wide',
  query: 'q',
  title: 'Population',
  blocks: [
    { id: 'headline', slot: 'head', type: 'headline', title: 'Japan and China' },
    {
      id: 'chart',
      slot: 'data',
      type: 'chart',
      form: 'line',
      title: 'Population',
      x: ['1960', '2010', '2025'],
      series: [
        { key: 'jpn', label: 'Japan', values: [93, 128, 123] },
        { key: 'chn', label: 'China', values: [667, 1338, 1409] },
      ],
    },
    {
      id: 'table',
      slot: 'data',
      type: 'table',
      rowHeaders: true,
      columns: [
        { key: 'subject', label: '', kind: 'text' },
        { key: 'latest', label: 'Latest', kind: 'text' },
      ],
      rows: [
        { id: 'jpn', cells: [{ text: 'Japan' }, { text: '123.4 million' }] },
        { id: 'chn', cells: [{ text: 'China' }, { text: '1.41 billion' }] },
      ],
    },
    {
      id: 'timeline',
      slot: 'more',
      type: 'timeline',
      events: [
        { id: 'a', date: '1960', label: 'First count' },
        { id: 'b', date: '2010', label: 'Japan peaks' },
        { id: 'c', date: '2025', label: 'Latest count' },
      ],
    },
  ],
  sources: [],
  asOf: null,
  partial: false,
}

function stage(spoken: string, entries = [{ id: 'a', query: 'q', hint: 'web' as const, card, leaving: false }]) {
  return render(
    <Stage entries={entries} frontId={entries.at(-1)!.id} tucking={false} spoken={spoken} onFocus={() => undefined} onTuck={() => undefined} />,
  )
}

describe('mentioned aloud', () => {
  it('lights the row, the point and the event GIDEON has just said', () => {
    const { container } = stage('Japan peaked in 2010.')
    const front = container.querySelector('.glass-card[data-slot="front"]')!
    expect([...front.querySelectorAll('.card-table tbody tr')].map((row) => row.getAttribute('data-said'))).toEqual(['true', null])
    expect([...front.querySelectorAll('.timeline-event')].map((event) => event.getAttribute('data-said'))).toEqual([null, 'true', null])
    // A ring on each line's point at 2010.
    expect(front.querySelectorAll('.chart-said-ring')).toHaveLength(2)
  })

  it('lights nothing on a card that is not in front', () => {
    const { container } = stage('Japan peaked in 2010.', [
      { id: 'a', query: 'q', hint: 'web', card, leaving: false },
      { id: 'b', query: 'q', hint: 'web', card: { ...card, blocks: card.blocks.slice(0, 1) }, leaving: false },
    ])
    const behind = container.querySelector('.glass-card[data-slot="peek"]')!
    expect(behind.querySelectorAll('[data-said="true"]')).toHaveLength(0)
    expect(behind.querySelectorAll('.chart-said-ring')).toHaveLength(0)
  })

  it('tells the face where to glance when something new lights up', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 600, top: 400, width: 80, height: 20, right: 680, bottom: 420, x: 600, y: 400, toJSON: () => ({}) })
    const glances: Array<{ x: number; y: number }> = []
    const listen = (event: Event) => glances.push((event as CustomEvent<{ x: number; y: number }>).detail)
    window.addEventListener(GLANCE_EVENT, listen)
    const view = stage('Japan')
    view.rerender(<Stage entries={[{ id: 'a', query: 'q', hint: 'web', card, leaving: false }]} frontId="a" tucking={false} spoken="Japan peaked in 2010." onFocus={() => undefined} onTuck={() => undefined} />)
    window.removeEventListener(GLANCE_EVENT, listen)
    expect(glances.length).toBeGreaterThan(0)
    expect(glances[0]).toEqual({ x: 640, y: 410 })
  })
})

describe('where a glance lands', () => {
  it('turns a point on the screen into a direction from the face', () => {
    const face = { left: 20, top: 20, width: 160, height: 80 } as DOMRect
    const gaze = gazeToward(face, { x: 780, y: 440 }, { width: 1440, height: 900 })
    // A card in the middle, seen from the corner: across and down.
    expect(gaze.x).toBeCloseTo(0.86, 1)
    expect(gaze.y).toBeCloseTo(0.44, 1)
    expect(gazeToward(face, { x: 99_999, y: -99_999 }, { width: 1440, height: 900 })).toEqual({ x: 1.2, y: -1.2 })
  })
})
