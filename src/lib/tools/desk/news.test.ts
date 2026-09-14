import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanHeadline, deckFrom, forgetNews, frontPage, topStories, type NewsDeps } from './news'

/**
 * A front page from the news search. The headlines and openings are the
 * publishers' own words, so what is tested is that cleaning them never takes
 * away a word that was part of the story, and that the lead is the story most
 * outlets are carrying.
 */

describe('cleanHeadline', () => {
  it("takes the publisher's name off a title, at either end", () => {
    expect(cleanHeadline('Trump dismisses report on Iran | Reuters', 'reuters.com')).toBe('Trump dismisses report on Iran')
    expect(cleanHeadline('Diplomacy stumbles over Hormuz proposal | The Straits Times', 'straitstimes.com')).toBe('Diplomacy stumbles over Hormuz proposal')
    expect(cleanHeadline('Airman shares rescue story | CNN Politics', 'cnn.com')).toBe('Airman shares rescue story')
    expect(cleanHeadline('Bangkok Post - Poland, Ukraine slam strikes near border', 'bangkokpost.com')).toBe('Poland, Ukraine slam strikes near border')
    expect(cleanHeadline('Zverev wins US Open - BBC News', 'bbc.co.uk')).toBe('Zverev wins US Open')
    // A site named by its publisher's initials.
    expect(cleanHeadline('What Amodei argued in his call for a slowdown - The New York Times', 'nytimes.com')).toBe(
      'What Amodei argued in his call for a slowdown',
    )
    expect(cleanHeadline('Markets steady before rate decision | Financial Times', 'ft.com')).toBe('Markets steady before rate decision')
    // A name joined with "of", after the site's own section.
    expect(cleanHeadline('New method enables AI for safety-critical situations | MIT News | Massachusetts Institute of Technology', 'news.mit.edu')).toBe(
      'New method enables AI for safety-critical situations',
    )
  })

  it("takes a section's name off the end when a bar sets it apart", () => {
    expect(cleanHeadline('Satellite images show damage to a major pipeline | Saudi Arabia', 'theguardian.com')).toBe('Satellite images show damage to a major pipeline')
    expect(cleanHeadline('Ferry strike called off | World news | The Guardian', 'theguardian.com')).toBe('Ferry strike called off')
    // Words that say something after a bar are the headline's, and so is a name after a dash.
    expect(cleanHeadline('Budget 2026 | What changes for taxpayers', 'example.in')).toBe('Budget 2026 | What changes for taxpayers')
    expect(cleanHeadline('Harris meets Starmer - Downing Street', 'example.com')).toBe('Harris meets Starmer - Downing Street')
  })

  it("keeps every part of a headline that is not the site it is on, separators and all", () => {
    expect(cleanHeadline('Ukraine - Russia talks resume in Geneva', 'reuters.com')).toBe('Ukraine - Russia talks resume in Geneva')
    expect(cleanHeadline('Budget vote – what it means for you', 'theguardian.com')).toBe('Budget vote – what it means for you')
  })
})

describe('deckFrom', () => {
  it('drops a wire dateline and cuts at a sentence', () => {
    expect(
      deckFrom(
        ['ABOARD AIR FORCE ONE, Sept 13 (Reuters) - U.S. President Donald Trump on Sunday brushed aside a report that entities helped Iran. He spoke to reporters. More followed later in the day with a long statement that ran on.'],
        'Trump dismisses report',
      ),
    ).toBe('U.S. President Donald Trump on Sunday brushed aside a report that entities helped Iran. He spoke to reporters.')
    expect(deckFrom(['ADEN/DUBAI – Middle East diplomacy appeared to falter heading into Sept 14 with the postponement of a meeting.'], 'x')).toBe(
      'Middle East diplomacy appeared to falter heading into Sept 14 with the postponement of a meeting.',
    )
  })

  it('takes out characters that take up no room', () => {
    const hidden = String.fromCharCode(0x200b)
    expect(deckFrom([`A recent report cited unnamed officials about the ${hidden}attack in the region.`], 'x')).toBe(
      'A recent report cited unnamed officials about the attack in the region.',
    )
    expect(cleanHeadline(`Ferries re${hidden}turn | Harbour News`, 'harbour.example')).toBe('Ferries return')
  })

  it('skips a passage that is a fragment of an address, and one that only repeats the headline', () => {
    expect(
      deckFrom(
        ['://www.cnn.com/2026/04/05/politics/american-airman- ... Once he ejected from the jet, the officer managed to reach the ground safely.'],
        'Airman shares rescue story',
      ),
    ).toBe('Once he ejected from the jet, the officer managed to reach the ground safely.')
    expect(deckFrom(['Zverev wins US Open for the first time.'], 'Zverev wins US Open for the first time')).toBe('')
  })
})

const result = (title: string, host: string, extra: Record<string, unknown> = {}) => ({
  title,
  url: `https://www.${host}/story/${encodeURIComponent(title)}`,
  publishedDate: '2026-09-14T08:00:00.000Z',
  image: `https://www.${host}/lead.jpg`,
  highlights: [`${title} was reported on Sunday, and officials said more details would follow within days.`],
  ...extra,
})

describe('frontPage', () => {
  it('makes one story of several tellings, and leads with the one most outlets carry', () => {
    const stories = frontPage([
      result('Zverev wins the US Open final', 'dw.com'),
      result('US aviator shot down over Iran recalls free-falling', 'bbc.com'),
      result('Airman shot down in Iran shares rescue story', 'cnn.com', { image: undefined }),
      result('Orchestra announces a free open-air season', 'example.org'),
      result('Pilot shot down over Iran describes rescue', 'reuters.com'),
    ])
    expect(stories.map((story) => [story.host, story.outlets])).toEqual([
      ['bbc.com', 3],
      ['dw.com', 1],
      ['example.org', 1],
    ])
  })

  it('joins two groups that a later telling shows to be the same story', () => {
    // The first two share no naming word; the third shares two with each of them.
    const stories = frontPage([
      result('Amodei letter urges pause', 'a.org'),
      result('Anthropic chief warns on pace', 'b.org'),
      result('Anthropic chief Amodei publishes letter', 'c.org'),
    ])
    expect(stories.map((story) => story.outlets)).toEqual([3])
  })

  it('leaves out a story with no opening to show, and anything not over https', () => {
    const stories = frontPage([
      result('A story with no words', 'a.org', { highlights: ['://broken'] }),
      result('A story in the clear', 'b.org', { url: 'http://b.org/story' }),
      result('A story that is fine to show', 'c.org'),
    ])
    expect(stories.map((story) => story.host)).toEqual(['c.org'])
  })
})

describe('topStories', () => {
  const NOW = Date.UTC(2026, 8, 14, 12)

  function world(results: unknown[]) {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ results }))
    const deps: NewsDeps = { fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW, exaKey: 'exa-test' }
    return { fetch, deps }
  }

  beforeEach(() => forgetNews())

  it('asks for news from the last day and a half, and describes the stories to brief with', async () => {
    const { fetch, deps } = world([
      result('Zverev wins the US Open final', 'dw.com'),
      result('Orchestra announces a free open-air season', 'example.org'),
      result('Library opens reading room around the clock', 'example.net'),
    ])
    const found = await topStories({}, deps, new AbortController().signal)
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body))
    expect(body).toMatchObject({ category: 'news', query: 'top news stories today', startPublishedDate: '2026-09-13T00:00:00.000Z' })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.materials[0]).toMatchObject({ kind: 'stories', topic: '', id: 'news:headlines:day' })
    expect(found.text).toContain('1. Zverev wins the US Open final (dw.com, 2026-09-14)')
    expect(found.text).toContain('shown on the user\'s screen as a front page')
  })

  it('says so when there is too little for a front page, and is not set up without a key', async () => {
    const { deps } = world([result('Only one story here today', 'dw.com')])
    expect((await topStories({ topic: 'curling' }, deps, new AbortController().signal)).text).toContain('Too few stories about curling')
    expect((await topStories({}, { ...deps, exaKey: '' }, new AbortController().signal)).ok).toBe(false)
  })
})
