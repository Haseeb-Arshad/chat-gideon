import { describe, expect, it, vi } from 'vitest'
import { findPictures, galleryCard, pictureUrls, type ImageDeps } from './images'

/**
 * A gallery is judged by its worst tile, so these are mostly about what never
 * gets in: logos, placeholders, watermarked stock previews, the same photograph
 * twice. And a search that fails is one that found nothing, never an error.
 */

describe('pictureUrls', () => {
  it('trades a sharing preview for the photograph itself', () => {
    const unsplash = pictureUrls(
      'https://images.unsplash.com/photo-1761637604893-f049f46d2bcd?mark=https%3A%2F%2Fimages.unsplash.com%2Fopengraph%2Flogo.png&w=1200',
    )
    expect(unsplash).toEqual({
      tile: 'https://images.unsplash.com/photo-1761637604893-f049f46d2bcd?w=720&q=80&auto=format&fit=max',
      full: 'https://images.unsplash.com/photo-1761637604893-f049f46d2bcd?w=1600&q=85&auto=format&fit=max',
    })
    expect(
      pictureUrls('https://images.pexels.com/photos/12118046/pexels-photo-12118046.jpeg?auto=compress&h=627'),
    ).toEqual({
      tile: 'https://images.pexels.com/photos/12118046/pexels-photo-12118046.jpeg?auto=compress&cs=tinysrgb&w=720',
      full: 'https://images.pexels.com/photos/12118046/pexels-photo-12118046.jpeg?auto=compress&cs=tinysrgb&w=1600',
    })
  })

  it('refuses furniture, watermarks and anything not over https', () => {
    expect(pictureUrls('https://images.unsplash.com/opengraph/1x1.png?mark=x')).toBeNull()
    expect(pictureUrls('https://www.istockphoto.com/components/IStockLogoDesktop.svg')).toBeNull()
    expect(pictureUrls('https://media.istockphoto.com/id/1370520449/photo/cake.jpg')).toBeNull()
    expect(pictureUrls('https://www.example.org/assets/site-logo.png')).toBeNull()
    expect(pictureUrls('http://www.example.org/cake.jpg')).toBeNull()
    expect(pictureUrls('not a url')).toBeNull()
  })

  it('keeps an ordinary photograph as it is', () => {
    expect(pictureUrls('https://www.seriouseats.com/thmb/cake.jpg')).toEqual({
      tile: 'https://www.seriouseats.com/thmb/cake.jpg',
      full: 'https://www.seriouseats.com/thmb/cake.jpg',
    })
  })
})

function deps(exa: unknown[], openverse: unknown[] = [], exaKey = 'exa-test') {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.includes('api.exa.ai')) return Response.json({ results: exa })
    if (url.includes('openverse')) return Response.json({ results: openverse })
    return new Response('', { status: 404 })
  })
  const images: ImageDeps = { fetch: fetch as unknown as typeof globalThis.fetch, exaKey }
  return { fetch, images }
}

const live = () => new AbortController().signal

const hit = (host: string, n: number, image: string, imageLinks: string[] = []) => ({
  title: `Chocolate cake ${n}`,
  url: `https://www.${host}/photo/${n}`,
  image,
  extras: { imageLinks },
})

describe('findPictures', () => {
  it('takes each page’s lead picture first, and more only from photo libraries', async () => {
    const { fetch, images } = deps([
      hit('unsplash.com', 1, 'https://images.unsplash.com/photo-111?mark=logo', [
        'https://images.unsplash.com/photo-112?w=400',
      ]),
      hit('istockphoto.com', 2, 'https://media.istockphoto.com/id/2/photo/cake.jpg'),
      hit('seriouseats.com', 3, 'https://www.seriouseats.com/thmb/cake.jpg', [
        'https://www.seriouseats.com/thmb/other.jpg',
      ]),
      hit('pexels.com', 4, 'https://images.pexels.com/photos/4/pexels-photo-4.jpeg?h=627'),
      hit('pexels.com', 5, 'https://images.pexels.com/photos/4/pexels-photo-4.jpeg?w=300'),
    ])
    const pictures = await findPictures('chocolate cake', images, live())

    expect(pictures.map((picture) => picture.thumb)).toEqual([
      'https://images.unsplash.com/photo-111?w=720&q=80&auto=format&fit=max',
      'https://www.seriouseats.com/thmb/cake.jpg',
      'https://images.pexels.com/photos/4/pexels-photo-4.jpeg?auto=compress&cs=tinysrgb&w=720',
      'https://images.unsplash.com/photo-112?w=720&q=80&auto=format&fit=max',
    ])
    expect(pictures[0]).toMatchObject({ host: 'unsplash.com', pageUrl: 'https://www.unsplash.com/photo/1' })

    // The web gave fewer than six, so the open library was asked as well.
    expect(fetch.mock.calls.some(([url]) => String(url).includes('openverse'))).toBe(true)
    const exaBody = JSON.parse(String(fetch.mock.calls[0][1]?.body)) as { query: string }
    expect(exaBody.query).toBe('chocolate cake photos')
  })

  it('stops at nine, and does not bother the open library when the web was enough', async () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      hit('pexels.com', n, `https://images.pexels.com/photos/${n}/p.jpeg`),
    )
    const { fetch, images } = deps(many)
    expect(await findPictures('cake', images, live())).toHaveLength(9)
    expect(fetch.mock.calls.some(([url]) => String(url).includes('openverse'))).toBe(false)
  })

  it('falls back to the open library alone without a search key', async () => {
    const { fetch, images } = deps(
      [],
      [
        {
          title: 'Lemon cake',
          url: 'https://live.staticflickr.com/1/lemon_b.jpg',
          thumbnail: 'https://api.openverse.org/v1/images/abc/thumb/',
          foreign_landing_url: 'https://www.flickr.com/photos/someone/1',
          provider: 'flickr',
        },
        { title: 'No thumbnail', url: 'https://example.org/x.jpg' },
      ],
      '',
    )
    const pictures = await findPictures('lemon cake', images, live())
    expect(fetch.mock.calls.some(([url]) => String(url).includes('api.exa.ai'))).toBe(false)
    expect(pictures).toEqual([
      {
        url: 'https://live.staticflickr.com/1/lemon_b.jpg',
        thumb: 'https://api.openverse.org/v1/images/abc/thumb/',
        alt: 'Lemon cake',
        pageUrl: 'https://www.flickr.com/photos/someone/1',
        host: 'flickr.com',
      },
    ])
  })

  it('finds nothing, rather than failing, when every source does', async () => {
    const broken = vi.fn(async () => {
      throw new Error('network down')
    })
    expect(await findPictures('cake', { fetch: broken as never, exaKey: 'k' }, live())).toEqual([])
  })
})

describe('galleryCard', () => {
  it('names the gallery after what was asked for, and credits each site once', () => {
    const picture = (host: string, n: number) => ({
      url: `https://${host}/${n}.jpg`,
      thumb: `https://${host}/${n}-t.jpg`,
      alt: `Cake ${n}`,
      pageUrl: `https://${host}/page/${n}`,
      host,
    })
    const card = galleryCard('chocolate cake', [
      picture('unsplash.com', 1),
      picture('unsplash.com', 2),
      picture('pexels.com', 3),
    ])
    expect(card).toMatchObject({
      kind: 'gallery',
      title: 'Chocolate cake',
      query: 'chocolate cake',
      subtitle: '3 pictures from the web',
      image: null,
    })
    expect(card.pictures).toHaveLength(3)
    expect(card.sources.map((source) => source.host)).toEqual(['unsplash.com', 'pexels.com'])
  })
})
