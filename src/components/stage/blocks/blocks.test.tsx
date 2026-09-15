// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CardV2 } from '../../../lib/cards/schema'
import { Stage } from '../Stage'

/**
 * The newer blocks on a card, as a person uses them: a table that sorts, a
 * question that asks itself, a number whose change is marked as worked out.
 */

afterEach(cleanup)

function card(blocks: CardV2['blocks'], size: CardV2['size'] = 'wide'): CardV2 {
  return {
    schema: 2,
    recipe: 'compare',
    size,
    query: 'q',
    title: 'Cities',
    blocks: [{ id: 'headline', slot: 'body', type: 'headline', title: 'Cities' }, ...blocks],
    sources: [],
    asOf: null,
    partial: false,
  }
}

function stage(value: CardV2, onAsk?: (text: string) => void, front = true) {
  const entries = [{ id: 'a', query: 'q', hint: 'web' as const, card: value, leaving: false }]
  if (!front) entries.push({ id: 'b', query: 'q', hint: 'web' as const, card: value, leaving: false })
  return render(
    <Stage
      entries={entries}
      frontId={front ? 'a' : 'b'}
      tucking={false}
      spoken=""
      onFocus={() => undefined}
      onTuck={() => undefined}
      onAsk={onAsk}
    />,
  )
}

describe('table', () => {
  const table = card([
    {
      id: 't',
      slot: 'body',
      type: 'table',
      rowHeaders: true,
      columns: [
        { key: 'city', label: 'City', kind: 'text' },
        { key: 'people', label: 'Population', kind: 'number', unit: 'thousands' },
      ],
      rows: [
        { id: 'porto', cells: [{ text: 'Porto' }, { text: '232', value: 232 }] },
        { id: 'lisbon', cells: [{ text: 'Lisbon' }, { text: '545', value: 545 }] },
        { id: 'faro', cells: [{ text: 'Faro' }, { text: '64', value: 64 }] },
      ],
    },
  ])

  const order = (container: HTMLElement) =>
    [...container.querySelectorAll('.card-table tbody th')].map((cell) => cell.textContent)

  it('sorts a number column largest first, then smallest first, then as it came', () => {
    const { container, getByRole } = stage(table)
    expect(order(container)).toEqual(['Porto', 'Lisbon', 'Faro'])
    const header = getByRole('columnheader', { name: /Population/ })
    expect(header.getAttribute('aria-sort')).toBe('none')

    fireEvent.click(header.querySelector('button')!)
    expect(order(container)).toEqual(['Lisbon', 'Porto', 'Faro'])
    expect(header.getAttribute('aria-sort')).toBe('descending')

    fireEvent.click(header.querySelector('button')!)
    expect(order(container)).toEqual(['Faro', 'Porto', 'Lisbon'])

    fireEvent.click(header.querySelector('button')!)
    expect(order(container)).toEqual(['Porto', 'Lisbon', 'Faro'])
    expect(header.getAttribute('aria-sort')).toBe('none')
  })

  it('names each row in its first column, and right-aligns the numbers', () => {
    const { container, getByRole } = stage(table)
    expect(container.querySelectorAll('.card-table tbody th[scope="row"]')).toHaveLength(3)
    expect(container.querySelector('.card-table td')?.getAttribute('data-kind')).toBe('number')
    // A text column is not offered for sorting.
    expect(getByRole('columnheader', { name: 'City' }).querySelector('button')).toBeNull()
  })
})

describe('questions to ask next', () => {
  const chips = card([{ id: 'c', slot: 'body', type: 'chips', items: [{ label: 'Her daughter', ask: 'Tell me about Irène Joliot-Curie' }] }])

  it('asks the question as if it had been typed', () => {
    const ask = vi.fn()
    const { getByRole } = stage(chips, ask)
    fireEvent.click(getByRole('button', { name: 'Her daughter' }))
    expect(ask).toHaveBeenCalledWith('Tell me about Irène Joliot-Curie')
  })

  it('cannot be pressed on a card that is not in front', () => {
    const ask = vi.fn()
    const { container } = stage(chips, ask, false)
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.card-chips button')]
    // One card in front, and beside it one drawn small, with nothing on it to press but itself.
    expect(buttons.map((button) => button.disabled)).toEqual([false])
    expect(container.querySelectorAll('.glass-card[data-slot="side"] button:not(.side-hit)')).toHaveLength(0)
  })
})

describe('a number that moved', () => {
  it('marks the change as worked out, and draws its recent line ending on a point', () => {
    const { container } = stage(
      card([
        {
          id: 's',
          slot: 'body',
          type: 'stat',
          value: '4.9 M',
          label: 'Passengers',
          change: { value: '+58%', direction: 'up', period: 'since 2014', formula: '(4.9 − 3.1) ÷ 3.1' },
          spark: [3.1, 3.6, 1.9, 4.9],
        },
      ]),
    )
    const change = container.querySelector('.card-change')!
    expect(change.getAttribute('data-direction')).toBe('up')
    expect(change.querySelector('abbr')?.getAttribute('title')).toBe('Worked out: (4.9 − 3.1) ÷ 3.1')
    expect(container.querySelector('.card-spark polyline')?.getAttribute('points')?.split(' ')).toHaveLength(4)
    expect(container.querySelectorAll('.card-spark circle')).toHaveLength(1)
  })
})

describe('sequences and asides', () => {
  it('draws a timeline, steps, a list that links out, a note and a quote', () => {
    const { container } = stage(
      card([
        { id: 'tl', slot: 'body', type: 'timeline', events: [{ id: 'a', date: '1867', label: 'Born' }, { id: 'b', date: '1934', label: 'Died' }] },
        { id: 'st', slot: 'body', type: 'steps', items: ['Loop', 'Rabbit'] },
        { id: 'li', slot: 'body', type: 'list', ordered: false, items: [{ id: 'x', title: 'Page', url: 'https://a.example' }] },
        { id: 'no', slot: 'body', type: 'note', tone: 'stale', text: 'From 2023.' },
        { id: 'qu', slot: 'body', type: 'quote', text: 'Be less curious about people.', who: 'Marie Curie' },
      ]),
    )
    expect([...container.querySelectorAll('.timeline-event time')].map((time) => time.textContent)).toEqual(['1867', '1934'])
    expect(container.querySelectorAll('.card-steps li')).toHaveLength(2)
    const link = container.querySelector('.card-list a')!
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(container.querySelector('.card-note')?.getAttribute('data-tone')).toBe('stale')
    expect(container.querySelector('.card-quote footer')?.textContent).toBe('Marie Curie')
  })
})
