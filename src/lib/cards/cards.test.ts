import { describe, expect, it } from 'vitest'
import type { Card } from '../cards'
import { numbersIn } from './ground'
import { fromLegacy } from './legacy'
import { readCard } from './read'
import { RECIPES, isRecipeId, preferredSize } from './recipes'
import { CARD_SIZES, cardThumbnail, type CardV2 } from './schema'

/**
 * Cards as blocks. Two promises matter: every card the first builder could
 * make still draws the same parts in the same order, and nothing the browser
 * receives can reach the renderer in a shape that would throw.
 */

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
    { label: 'Died', value: '18 April 1955' },
  ],
  image: { url: 'https://upload.wikimedia.org/einstein.jpg', alt: 'Albert Einstein', credit: 'Wikipedia' },
  pictures: [],
  sources: [{ title: 'Britannica', url: 'https://www.britannica.com/biography/Albert-Einstein', host: 'britannica.com' }],
}

const v2 = (overrides: Record<string, unknown> = {}) => ({
  schema: 2,
  recipe: 'profile',
  size: 'standard',
  query: 'Who was Albert Einstein?',
  title: 'Albert Einstein',
  blocks: [
    { id: 'headline', slot: 'body', type: 'headline', title: 'Albert Einstein' },
    { id: 'facts', slot: 'body', type: 'facts', items: [{ label: 'Born', value: '1879' }] },
  ],
  sources: [{ title: 'Britannica', url: 'https://www.britannica.com/biography/Albert-Einstein' }],
  asOf: null,
  partial: false,
  ...overrides,
})

describe('numbers across a no-break space', () => {
  it('reads a number set with a no-break space as one number, and an ordinary space as two', () => {
    expect(numbersIn('1\u00a0879 and 12\u202f500')).toEqual(['1879', '12500'])
    expect(numbersIn('1 879')).toEqual(['1', '879'])
  })
})

describe('the first cards, as blocks', () => {
  it('draws a person as a portrait, a headline, a summary and facts, in that order', () => {
    const card = fromLegacy(einstein)
    expect(card).toMatchObject({ schema: 2, recipe: 'profile', size: 'standard', title: 'Albert Einstein' })
    expect(card.blocks.map((block) => block.type)).toEqual(['media', 'headline', 'prose', 'facts'])
    expect(card.blocks[0]).toMatchObject({ slot: 'media', image: { url: einstein.image!.url } })
    expect(card.blocks[1]).toEqual({
      id: 'headline',
      slot: 'body',
      type: 'headline',
      title: 'Albert Einstein',
      subtitle: 'Theoretical physicist',
    })
    expect(card.sources).toEqual(einstein.sources)
  })

  it('puts a figure between the headline and the summary, as it always was', () => {
    const card = fromLegacy({
      ...einstein,
      kind: 'figure',
      image: null,
      figure: { value: '$67,420', label: 'Bitcoin price' },
    })
    expect(card.recipe).toBe('figure')
    expect(card.blocks.map((block) => block.type)).toEqual(['headline', 'stat', 'prose', 'facts'])
  })

  it('keeps the date above a news headline', () => {
    const card = fromLegacy({ ...einstein, kind: 'news', kicker: '9 September 2026' })
    expect(card.recipe).toBe('news')
    expect(card.blocks.find((block) => block.type === 'headline')).toMatchObject({ kicker: '9 September 2026' })
  })

  it('draws a gallery as its heading and its pictures', () => {
    const picture = {
      url: 'https://images.pexels.com/photos/1/a.jpeg?w=1600',
      thumb: 'https://images.pexels.com/photos/1/a.jpeg?w=720',
      alt: 'Cake',
      pageUrl: 'https://www.pexels.com/photo/1/',
      host: 'pexels.com',
    }
    const card = fromLegacy({ ...einstein, kind: 'gallery', image: null, pictures: [picture], facts: [] })
    expect(card.recipe).toBe('gallery')
    expect(card.blocks).toEqual([
      { id: 'headline', slot: 'body', type: 'headline', kicker: 'Pictures', title: 'Albert Einstein' },
      { id: 'gallery', slot: 'body', type: 'gallery', pictures: [picture] },
    ])
    expect(cardThumbnail(card)).toBe(picture.thumb)
  })
})

describe('reading a card off the wire', () => {
  it('keeps a well-formed card as it is', () => {
    const card = readCard(v2())
    expect(card).toMatchObject({ recipe: 'profile', size: 'standard', title: 'Albert Einstein' })
    expect(card?.blocks).toHaveLength(2)
    expect(card?.sources).toEqual([
      { title: 'Britannica', url: 'https://www.britannica.com/biography/Albert-Einstein', host: 'britannica.com' },
    ])
  })

  it('skips a block it does not know rather than failing the card', () => {
    const card = readCard(
      v2({
        blocks: [
          { id: 'headline', type: 'headline', title: 'Albert Einstein' },
          { id: 'hologram', type: 'hologram', beams: 3 },
        ],
      }),
    )
    expect(card?.blocks.map((block) => block.type)).toEqual(['headline'])
    // A block with no slot is placed in the body.
    expect(card?.blocks[0].slot).toBe('body')
  })

  it('drops blocks that could not be drawn, and a second block with the same id', () => {
    const card = readCard(
      v2({
        blocks: [
          { id: 'a', type: 'headline', title: 'Kept' },
          { id: 'a', type: 'headline', title: 'Same id' },
          { id: 'b', type: 'headline', title: '' },
          { id: 'c', type: 'facts', items: 'not a list' },
          { id: 'd', type: 'stat', label: 'no value' },
          { id: '', type: 'headline', title: 'No id' },
          'not an object',
        ],
      }),
    )
    expect(card?.blocks).toEqual([{ id: 'a', slot: 'body', type: 'headline', title: 'Kept' }])
  })

  it('never lets a link run or a picture load in the clear', () => {
    const card = readCard(
      v2({
        blocks: [
          { id: 'media', type: 'media', image: { url: 'http://example.com/a.jpg', alt: 'x', credit: 'x' } },
          {
            id: 'gallery',
            type: 'gallery',
            pictures: [
              { url: 'javascript:alert(1)', thumb: 'https://a.example/t.jpg', alt: '', pageUrl: '', host: '' },
              { url: 'https://a.example/full.jpg', thumb: 'data:image/png;base64,xx', alt: 'A', pageUrl: 'javascript:1' },
            ],
          },
        ],
        sources: [
          { title: 'Bad', url: 'javascript:alert(1)' },
          { title: 'Good', url: 'https://a.example/page' },
        ],
      }),
    )
    expect(card?.blocks.map((block) => block.type)).toEqual(['gallery'])
    const gallery = card?.blocks[0]
    expect(gallery?.type === 'gallery' && gallery.pictures).toEqual([
      // The thumbnail and the page fall back to the picture itself.
      {
        url: 'https://a.example/full.jpg',
        thumb: 'https://a.example/full.jpg',
        alt: 'A',
        pageUrl: 'https://a.example/full.jpg',
        host: 'a.example',
      },
    ])
    expect(card?.sources.map((source) => source.url)).toEqual(['https://a.example/page'])
  })

  it('keeps only citations that point at a source', () => {
    const card = readCard(
      v2({ blocks: [{ id: 'h', type: 'headline', title: 'T', cite: [0, 1, -1, 0.5, 'x'] }] }),
    )
    expect(card?.blocks[0].cite).toEqual([0])
  })

  it('settles an unknown recipe or size on something drawable', () => {
    expect(readCard(v2({ recipe: 'hologram' }))?.recipe).toBe('answer')
    expect(readCard(v2({ recipe: 'compare', size: 'enormous' }))?.size).toBe('wide')
  })

  it('is no card without a title, without blocks, or without being an object', () => {
    expect(readCard(v2({ title: '  ' }))).toBeNull()
    expect(readCard(v2({ blocks: [] }))).toBeNull()
    expect(readCard(v2({ blocks: [{ id: 'x', type: 'unknown' }] }))).toBeNull()
    expect(readCard('a card')).toBeNull()
    expect(readCard(null)).toBeNull()
    expect(readCard({ schema: 99, title: 'From the future' })).toBeNull()
  })

  it('bounds text that would break the layout', () => {
    const card = readCard(v2({ title: 'x'.repeat(1_000) }))
    expect(card?.title.length).toBe(160)
  })

  it('turns the flat card an older server sends into blocks, checked the same way', () => {
    const card = readCard({
      ...einstein,
      image: { url: 'http://insecure.example/e.jpg', alt: 'x', credit: 'x' },
      sources: [...einstein.sources, { title: 'Script', url: 'javascript:alert(1)', host: '' }],
    })
    expect(card?.recipe).toBe('profile')
    expect(card?.blocks.map((block) => block.type)).toEqual(['headline', 'prose', 'facts'])
    expect(card?.sources).toHaveLength(1)
  })

  it('reads an old gallery, whose kind a model may never choose', () => {
    const card = readCard({
      kind: 'gallery',
      title: 'Cake',
      query: 'cake',
      pictures: [{ url: 'https://a.example/cake.jpg', thumb: 'https://a.example/cake-t.jpg', alt: 'Cake' }],
      sources: [],
    })
    expect(card?.recipe).toBe('gallery')
  })
})

describe('recipes', () => {
  it('gives every recipe a size it prefers from the sizes that exist', () => {
    for (const recipe of Object.values(RECIPES)) {
      expect(recipe.sizes.length, recipe.id).toBeGreaterThan(0)
      for (const size of recipe.sizes) expect(CARD_SIZES).toContain(size)
      expect(preferredSize(recipe.id)).toBe(recipe.sizes[0])
      expect(recipe.label && recipe.about, recipe.id).toBeTruthy()
    }
  })

  it('knows its own names and nothing else', () => {
    expect(isRecipeId('front-page')).toBe(true)
    expect(isRecipeId('toString')).toBe(false)
    expect(isRecipeId(undefined)).toBe(false)
  })
})

describe('the shelf picture', () => {
  it('is the lead picture, or nothing', () => {
    expect(cardThumbnail(fromLegacy(einstein))).toBe(einstein.image!.url)
    const plain: CardV2 = { ...fromLegacy({ ...einstein, image: null }) }
    expect(cardThumbnail(plain)).toBeUndefined()
  })
})
