import { beforeEach, describe, expect, it, vi } from 'vitest'
import { briefBody, buildCard, forgetCards, type CardDeps } from './card-builder'
import type { ResearchResult } from './research'

/**
 * The builder's promises: a card drawn from the brief and nothing else, a
 * picture only when it is surely the right one, one drawing per brief, and
 * silence rather than an exception whenever anything goes wrong.
 */

const EINSTEIN =
  'Albert Einstein (14 March 1879 – 18 April 1955) was a German-born theoretical physicist best known for the theory of relativity.\nSources: Albert Einstein | Britannica https://www.britannica.com/biography/Albert-Einstein'

function researched(brief: string, extra: Partial<ResearchResult> = {}): ResearchResult {
  return {
    ok: true,
    brief,
    sources: [{ title: 'Albert Einstein | Britannica', url: 'https://www.britannica.com/biography/Albert-Einstein' }],
    via: 'agent',
    model: 'test',
    searches: 1,
    ms: 10,
    ...extra,
  }
}

const einsteinCard = {
  show: true,
  kind: 'entity',
  title: 'Albert Einstein',
  subtitle: 'Theoretical physicist',
  summary: 'A German-born theoretical physicist best known for the theory of relativity.',
  facts: [
    { label: 'Born', value: '14 March 1879' },
    { label: 'Died', value: '18 April 1955' },
    { label: 'Known for', value: 'Theory of relativity' },
  ],
  subject: 'Albert Einstein',
}

const portrait = {
  query: {
    pages: [
      {
        title: 'Albert Einstein',
        // The host Wikipedia actually returns now, query string and all.
        thumbnail: {
          source:
            'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/28/Einstein.jpg/960px-Einstein.jpg?utm_source=en.wikipedia.org',
          width: 960,
          height: 1200,
        },
      },
    ],
  },
}

function world(card: unknown, wiki: unknown = portrait) {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.includes('openrouter.ai')) {
      const content = typeof card === 'string' ? card : JSON.stringify(card)
      return Response.json({ choices: [{ message: { content } }] })
    }
    if (url.includes('wikipedia.org')) return Response.json(wiki)
    return new Response('', { status: 404 })
  })
  const deps: CardDeps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    openrouterHeaders: { Authorization: 'Bearer test' },
    model: 'test-model',
  }
  return { fetch, deps }
}

const live = () => new AbortController().signal

beforeEach(() => forgetCards())

describe('buildCard', () => {
  it('draws an entity with its portrait', async () => {
    const { fetch, deps } = world(einsteinCard)
    const card = await buildCard('Who was Einstein?', researched(EINSTEIN), deps, live())

    expect(card).toMatchObject({
      kind: 'entity',
      title: 'Albert Einstein',
      query: 'Who was Einstein?',
      image: { alt: 'Albert Einstein', credit: 'Wikipedia', width: 960 },
    })
    expect(card?.image?.url).toMatch(/^https:\/\/thumb\.wikimedia\.org\//)
    expect(card?.facts).toHaveLength(3)

    // The model is shown the brief without its list of links.
    const request = JSON.parse(String(fetch.mock.calls[0][1]?.body)) as {
      messages: Array<{ content: string }>
      response_format: unknown
    }
    expect(request.messages[1].content).not.toContain('https://')
    expect(request.response_format).toEqual({ type: 'json_object' })
  })

  it('shows no picture rather than a doubtful one', async () => {
    const disambiguation = {
      query: {
        pages: [
          {
            title: 'Einstein (disambiguation)',
            pageprops: { disambiguation: '' },
            thumbnail: { source: 'https://upload.wikimedia.org/x.jpg' },
          },
        ],
      },
    }
    let { deps } = world(einsteinCard, disambiguation)
    expect((await buildCard('Einstein?', researched(EINSTEIN), deps, live()))?.image).toBeNull()

    forgetCards()
    const elsewhere = {
      query: { pages: [{ title: 'Physics', thumbnail: { source: 'https://upload.wikimedia.org/p.jpg' } }] },
    }
    ;({ deps } = world(einsteinCard, elsewhere))
    expect((await buildCard('Einstein?', researched(EINSTEIN), deps, live()))?.image).toBeNull()

    forgetCards()
    const offsite = {
      query: { pages: [{ title: 'Albert Einstein', thumbnail: { source: 'https://evil.example/e.jpg' } }] },
    }
    ;({ deps } = world(einsteinCard, offsite))
    expect((await buildCard('Einstein?', researched(EINSTEIN), deps, live()))?.image).toBeNull()
  })

  it('says nothing when the model declines or writes nonsense', async () => {
    let { deps } = world({ show: false })
    expect(await buildCard('Is it raining?', researched('Yes.'), deps, live())).toBeNull()

    ;({ deps } = world('I think the card should be about Einstein'))
    expect(await buildCard('Einstein?', researched(EINSTEIN), deps, live())).toBeNull()

    const broken = vi.fn(async () => {
      throw new Error('network down')
    })
    expect(
      await buildCard('Einstein?', researched(`${EINSTEIN} `), { ...deps, fetch: broken as never }, live()),
    ).toBeNull()
  })

  it('draws each brief once, however many turns ask', async () => {
    const { fetch, deps } = world(einsteinCard)
    const [first, second] = await Promise.all([
      buildCard('Who was Einstein?', researched(EINSTEIN), deps, live()),
      buildCard('who was einstein', researched(EINSTEIN), deps, live()),
    ])
    expect(first).toBe(second)
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('openrouter'))).toHaveLength(1)
  })

  it('does no work for research that failed', async () => {
    const { fetch, deps } = world(einsteinCard)
    expect(await buildCard('Einstein?', researched('Cancelled.', { ok: false }), deps, live())).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops waiting when the turn is let go', async () => {
    const { deps } = world(einsteinCard)
    const controller = new AbortController()
    controller.abort()
    expect(await buildCard('Einstein?', researched(EINSTEIN), deps, controller.signal)).toBeNull()
  })

  it('puts a news story beside its own picture', async () => {
    const { deps } = world({
      kind: 'news',
      title: 'Probe reaches Europa',
      kicker: '9 September 2026',
      summary: 'The probe entered orbit around Europa on 9 September 2026.',
      facts: [{ label: 'Agency', value: 'NASA' }],
    })
    const card = await buildCard(
      'Did the probe reach Europa?',
      researched('The probe entered orbit around Europa on 9 September 2026, NASA said.', {
        sources: [
          { title: 'NASA', url: 'https://www.nasa.gov/europa', image: 'https://www.nasa.gov/europa.jpg' },
        ],
      }),
      deps,
      live(),
    )
    expect(card?.kicker).toBe('9 September 2026')
    expect(card?.image).toEqual({
      url: 'https://www.nasa.gov/europa.jpg',
      alt: 'Probe reaches Europa',
      credit: 'nasa.gov',
    })
  })
})

describe('briefBody', () => {
  it('cuts the sources line and everything after it', () => {
    expect(briefBody(EINSTEIN)).not.toMatch(/Sources/)
    expect(briefBody('No sources here.')).toBe('No sources here.')
  })
})
