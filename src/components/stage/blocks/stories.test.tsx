// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardV2, StoriesBlock, StoryItem } from '../../../lib/cards/schema'
import { Stage } from '../Stage'

/**
 * The front page as a person reads it: the lead story with its picture, the
 * rest in a column, every story opening its own page, a dateline saying when,
 * and the story being briefed lit as it is said.
 */

const NOW = Date.UTC(2026, 8, 14, 12)
const HOUR = 3_600_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const story = (id: string, headline: string, extra: Partial<StoryItem> = {}): StoryItem => ({
  id,
  headline,
  deck: `${headline}, as the story opens.`,
  url: `https://${id}.example/story`,
  host: `${id}.example`,
  published: new Date(NOW - 2 * HOUR).toISOString(),
  outlets: 1,
  ...extra,
})

const page: CardV2 = {
  schema: 2,
  recipe: 'front-page',
  size: 'feature',
  query: "what's in the news",
  title: 'Top stories',
  blocks: [
    { id: 'headline', slot: 'head', type: 'headline', title: 'Top stories' },
    {
      id: 'stories',
      slot: 'body',
      type: 'stories',
      since: 'day',
      items: [
        story('harbour', 'Night ferries return to the harbour', { image: 'https://harbour.example/lead.jpg', outlets: 4 }),
        story('library', 'Library opens its reading room around the clock', { published: '2026-09-02' }),
        story('orchestra', 'Orchestra announces a free season in the park'),
      ],
    },
  ],
  sources: [],
  asOf: null,
  partial: false,
}

function stage(card: CardV2, spoken = '', front = true) {
  const entries = [{ id: 'a', query: 'q', hint: 'web' as const, card, leaving: false }]
  if (!front) entries.push({ id: 'b', query: 'q', hint: 'web' as const, card, leaving: false })
  return render(
    <Stage entries={entries} frontId={front ? 'a' : 'b'} tucking={false} spoken={spoken} onFocus={() => undefined} onTuck={() => undefined} />,
  )
}

describe('front page', () => {
  it('sets out a masthead, the lead with its picture, and the rest in a column', () => {
    const { container } = stage(page)
    const front = container.querySelector('.card-front')!
    expect(front.querySelector('.front-title')?.textContent).toBe('Top stories')
    // In whatever timezone the tests run, noon UTC on the 14th is the 14th or the 15th.
    expect(front.querySelector('.front-date')?.textContent).toMatch(/^(Monday 14|Tuesday 15) September · \w+ edition$/)

    const lead = front.querySelector('.front-lead')!
    expect(lead.querySelector('img')?.getAttribute('src')).toBe('https://harbour.example/lead.jpg')
    expect(lead.querySelector('.story-dateline')?.textContent).toBe('harbour.example2 hours ago4 outlets')
    expect(lead.querySelector('.story-deck')?.textContent).toBe('Night ferries return to the harbour, as the story opens.')

    const column = [...front.querySelectorAll('.front-more .front-story')]
    expect(column.map((each) => each.querySelector('.story-headline')?.textContent)).toEqual([
      'Library opens its reading room around the clock',
      'Orchestra announces a free season in the park',
    ])
    // A date with no time is said as a date; one outlet is not worth saying.
    expect(column[0].querySelector('.story-dateline')?.textContent).toBe('library.example2 September')
    // Every story credits its own outlet, so there is no row of sources under the page.
    expect(container.querySelector('.card-sources')).toBeNull()
  })

  it("opens each story's own page in a new tab, and only from the card in front", () => {
    const { container } = stage(page)
    const links = [...container.querySelectorAll<HTMLAnchorElement>('.story-headline a')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://harbour.example/story',
      'https://library.example/story',
      'https://orchestra.example/story',
    ])
    expect(links.every((link) => link.target === '_blank' && link.rel === 'noreferrer noopener' && link.tabIndex === 0)).toBe(true)

    cleanup()
    const behind = stage(page, '', false)
    const first = behind.container.querySelector('.glass-card[data-slot="peek"] .story-headline a') as HTMLAnchorElement
    expect(first.tabIndex).toBe(-1)
  })

  it('lets the lead go without its picture when the picture will not load', () => {
    const { container } = stage(page)
    const lead = container.querySelector('.front-lead')!
    fireEvent.error(lead.querySelector('img')!)
    expect(lead.getAttribute('data-picture')).toBe('none')
    expect(lead.querySelector('img')).toBeNull()
  })

  it('lights the story being briefed', () => {
    const { container } = stage(page, 'The night ferries are coming back to the harbour.')
    const lit = [...container.querySelectorAll('[data-said="true"]')]
    expect(lit).toHaveLength(1)
    expect(lit[0].classList.contains('front-lead')).toBe(true)
  })

  it('keeps a story that did not fit on the page out of reach, and never lights it', () => {
    // jsdom lays nothing out, so the column is given a width and the last story is placed past it,
    // where a story lands when it wraps out of a column that is full.
    const width = 300
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('front-more') ? width : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.story === 'orchestra' ? width + 60 : 24
    })
    const { container } = stage(page, 'And the orchestra announces a free season in the park.')

    const wrapped = container.querySelector('[data-story="orchestra"]')!
    expect(wrapped.getAttribute('data-off-page')).toBe('true')
    expect(wrapped.getAttribute('aria-hidden')).toBe('true')
    expect(wrapped.querySelector('a')!.tabIndex).toBe(-1)
    expect(wrapped.hasAttribute('data-said')).toBe(false)

    const shown = container.querySelector('[data-story="library"]')!
    expect(shown.hasAttribute('data-off-page')).toBe(false)
    expect(shown.querySelector('a')!.tabIndex).toBe(0)
  })

  it('runs the lead across the page when there is nothing to put beside it', () => {
    const single: CardV2 = { ...page, blocks: [page.blocks[0], { ...(page.blocks[1] as StoriesBlock), items: [story('harbour', 'Night ferries return')] }] }
    const { container } = stage(single)
    expect(container.querySelector('.front-grid')?.getAttribute('data-more')).toBe('0')
    expect(container.querySelector('.front-more')).toBeNull()
  })
})

describe('stories on another card', () => {
  it('are a list under its other blocks', () => {
    const answer: CardV2 = { ...page, recipe: 'answer', size: 'standard', blocks: [{ id: 'headline', slot: 'body', type: 'headline', title: 'Harbour' }, page.blocks[1]] }
    const { container } = stage(answer)
    expect(container.querySelector('.card-front')).toBeNull()
    const list = container.querySelector('.card-body .card-stories')!
    expect(list.querySelectorAll('.front-story')).toHaveLength(3)
  })
})
