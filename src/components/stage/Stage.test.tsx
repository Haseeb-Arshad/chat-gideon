// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../lib/cards'
import { fromLegacy } from '../../lib/cards/legacy'
import type { CardV2 } from '../../lib/cards/schema'
import { SIDE_MAX, Stage, type StageEntry } from './Stage'

/**
 * The stage drawing cards from their blocks. What is pinned here is what a
 * person sees: the same parts in the same order as the first card, each rising
 * after the one above it, and one broken card never taking the rest with it.
 */

afterEach(cleanup)

const einstein: Card = {
  kind: 'entity',
  query: 'Who was Albert Einstein?',
  title: 'Albert Einstein',
  subtitle: 'Theoretical physicist',
  summary: 'A German-born theoretical physicist.',
  figure: null,
  kicker: '',
  facts: [
    { label: 'Born', value: '14 March 1879, Ulm' },
    { label: 'Known for', value: 'Theory of relativity' },
  ],
  image: { url: 'https://upload.wikimedia.org/einstein.jpg', alt: 'Albert Einstein', credit: 'Wikipedia' },
  pictures: [],
  sources: [{ title: 'Britannica', url: 'https://www.britannica.com/biography/Albert-Einstein', host: 'britannica.com' }],
}

const entry = (id: string, card: CardV2 | null): StageEntry => ({
  id,
  query: card?.query ?? 'Looking',
  hint: card?.recipe === 'gallery' ? 'pictures' : 'web',
  card,
  leaving: false,
})

function stage(entries: StageEntry[], spoken = '') {
  return render(
    <Stage
      entries={entries}
      frontId={entries.at(-1)?.id ?? null}
      tucking={false}
      spoken={spoken}
      onFocus={() => undefined}
      onTuck={() => undefined}
    />,
  )
}

const rises = (elements: Element[]) => elements.map((element) => (element as HTMLElement).style.getPropertyValue('--i'))

describe('a card drawn from its blocks', () => {
  it('draws a person as the first card did, each part rising after the one above', () => {
    const { container } = stage([entry('t1:c1', fromLegacy(einstein))])
    const pane = container.querySelector('.glass-pane')!
    expect(pane.getAttribute('data-state')).toBe('ready')
    expect(pane.getAttribute('data-recipe')).toBe('profile')
    expect(pane.getAttribute('data-media')).toBe('tall')

    expect(pane.querySelector('.card-media img')?.getAttribute('src')).toBe(einstein.image!.url)
    const body = pane.querySelector('.card-body')!
    const parts = [...body.children].flatMap((child) =>
      child.classList.contains('card-facts') ? [...child.children] : [child],
    )
    expect(parts.map((part) => part.className)).toEqual([
      'card-title',
      'card-subtitle',
      'card-summary',
      'card-fact',
      'card-fact',
      'card-sources',
    ])
    expect(rises(parts)).toEqual(['0', '1', '2', '3', '4', '5'])
  })

  it('puts a figure under the headline, and a news date above it', () => {
    const figure = fromLegacy({ ...einstein, kind: 'figure', image: null, figure: { value: '$67,420', label: 'Price' } })
    let { container } = stage([entry('t1:c1', figure)])
    const classes = [...container.querySelector('.card-body')!.children].map((child) => child.className)
    expect(classes.slice(0, 4)).toEqual(['card-title', 'card-subtitle', 'card-figure', 'card-summary'])
    expect(container.querySelector('.card-figure strong')?.textContent).toBe('$67,420')
    cleanup()

    ;({ container } = stage([entry('t1:c1', fromLegacy({ ...einstein, kind: 'news', kicker: '9 September 2026' }))]))
    expect(container.querySelector('.card-body')!.firstElementChild?.className).toBe('card-kicker')
    expect(container.querySelector('.glass-pane')?.getAttribute('data-recipe')).toBe('news')
  })

  it('lays a gallery out under its heading, with the sources rising after the last tile', () => {
    const pictures = Array.from({ length: 4 }, (_, index) => ({
      url: `https://images.pexels.com/photos/${index}/a.jpeg?w=1600`,
      thumb: `https://images.pexels.com/photos/${index}/a.jpeg?w=720`,
      alt: `Cake ${index}`,
      pageUrl: `https://www.pexels.com/photo/${index}/`,
      host: 'pexels.com',
    }))
    const gallery = fromLegacy({ ...einstein, kind: 'gallery', image: null, facts: [], pictures })
    const { container } = stage([entry('t1:c1', gallery)])
    expect(rises([...container.querySelectorAll('.gallery-head > *')])).toEqual(['0', '1'])
    const grid = container.querySelector('.gallery-grid')!
    expect(grid.getAttribute('data-count')).toBe('4')
    expect(rises([...grid.children])).toEqual(['2', '3', '4', '5'])
    expect(rises([container.querySelector('.card-sources')!])).toEqual(['6'])
  })

  it('brightens a fact once GIDEON has said it', () => {
    const { container } = stage([entry('t1:c1', fromLegacy(einstein))], 'He was born in 1879, in Ulm.')
    const said = [...container.querySelectorAll('.card-fact')].map((fact) => fact.getAttribute('data-said'))
    expect(said).toEqual(['true', 'false'])
  })

  it('shows the question on a searching pane until its card arrives', () => {
    const { container } = stage([entry('t1:c1', null)])
    expect(container.querySelector('.glass-pane')?.getAttribute('data-state')).toBe('searching')
    expect(container.querySelector('.card-query')?.textContent).toBe('Looking')
  })

  it('keeps one broken card from taking the stage down with it', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Not something `readCard` would ever let through: a list that is not one.
    const broken = { ...fromLegacy(einstein), blocks: [{ id: 'f', slot: 'body', type: 'facts', items: null }] }
    const { container } = stage([
      entry('t1:c1', fromLegacy(einstein)),
      entry('t2:c1', broken as unknown as CardV2),
    ])
    expect(container.querySelectorAll('.glass-card')).toHaveLength(2)
    // The broken card is in front and draws nothing; the one beside it is whole.
    expect(container.querySelector('.glass-card[data-slot="side"] .compact-title')?.textContent).toBe('Albert Einstein')

    cleanup()
    const behind = stage([entry('t2:c1', broken as unknown as CardV2), entry('t1:c1', fromLegacy(einstein))])
    expect(behind.container.querySelectorAll('.card-title')).toHaveLength(1)
    quiet.mockRestore()
  })
})

describe('several cards at once', () => {
  const titled = (id: string, title: string) => entry(id, { ...fromLegacy({ ...einstein, title, subtitle: `About ${title}` }), title })

  it('draws one card alone, and more than one as the card in front with the rest whole beside it, the most recent first', () => {
    const one = stage([titled('a', 'Ada Lovelace')])
    expect(one.container.querySelector('.research-stage')?.getAttribute('data-layout')).toBe('single')
    cleanup()

    const { container } = stage([titled('a', 'Ada Lovelace'), titled('b', 'Alan Turing'), titled('c', 'Grace Hopper')])
    expect(container.querySelector('.research-stage')?.getAttribute('data-layout')).toBe('split')
    expect(container.querySelector('.glass-card[data-slot="front"] .card-title')?.textContent).toBe('Grace Hopper')
    const side = [...container.querySelectorAll<HTMLElement>('.glass-card[data-slot="side"]')].sort(
      (a, b) => Number(a.style.getPropertyValue('--side-i')) - Number(b.style.getPropertyValue('--side-i')),
    )
    expect(side.map((card) => card.querySelector('.compact-title')?.textContent)).toEqual(['Alan Turing', 'Ada Lovelace'])
    expect(side.map((card) => card.querySelector('.compact-detail')?.textContent)).toEqual(['About Alan Turing', 'About Ada Lovelace'])
  })

  it('brings a card forward when it is pressed', () => {
    const focus = vi.fn()
    const entries = [titled('a', 'Ada Lovelace'), titled('b', 'Alan Turing')]
    const { getByRole } = render(<Stage entries={entries} frontId="b" tucking={false} spoken="" onFocus={focus} onTuck={() => undefined} />)
    fireEvent.click(getByRole('button', { name: 'Show Ada Lovelace' }))
    expect(focus).toHaveBeenCalledWith('a')
  })

  it(`keeps ${SIDE_MAX} beside the card in front, and counts the rest on the last`, () => {
    const names = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Katherine Johnson', 'Tim Berners-Lee', 'Margaret Hamilton']
    const { container, getByRole } = stage(names.map((name, index) => titled(String(index), name)))
    expect(container.querySelectorAll('.glass-card[data-slot="side"]')).toHaveLength(SIDE_MAX)
    expect(container.querySelectorAll('.glass-card[data-slot="behind"]')).toHaveLength(names.length - 1 - SIDE_MAX)
    expect(getByRole('button', { name: 'Show Grace Hopper, and 2 more' }).textContent).toBe('+2')
  })
})
