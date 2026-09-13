import { describe, expect, it } from 'vitest'
import { applyPatch, readPatch } from './patch'
import type { CardV2 } from './schema'

/**
 * A card growing on screen. A replaced block keeps its place, a new one goes
 * after the rest, and nothing in a patch is trusted any more than a card is.
 */

const card: CardV2 = {
  schema: 2,
  recipe: 'profile',
  size: 'standard',
  query: 'Who was Marie Curie?',
  title: 'Marie Curie',
  blocks: [
    { id: 'headline', slot: 'body', type: 'headline', title: 'Marie Curie' },
    { id: 'summary', slot: 'body', type: 'prose', paragraphs: ['Looking into it.'], cite: [0] },
    { id: 'facts', slot: 'body', type: 'facts', items: [{ label: 'Born', value: '7 November 1867' }], cite: [1] },
  ],
  sources: [
    { title: 'Nobel Prize', url: 'https://www.nobelprize.org/curie', host: 'nobelprize.org' },
    { title: 'Britannica', url: 'https://www.britannica.com/curie', host: 'britannica.com' },
  ],
  asOf: null,
  partial: true,
}

describe('applyPatch', () => {
  it('replaces a block where it stands and adds new ones after the rest', () => {
    const grown = applyPatch(card, {
      blocks: [
        { id: 'summary', slot: 'body', type: 'prose', paragraphs: ['A physicist and chemist.'] },
        { id: 'awards', slot: 'body', type: 'facts', items: [{ label: 'Nobel Prizes', value: '1903 and 1911' }] },
      ],
      drop: [],
      partial: false,
    })
    expect(grown.blocks.map((block) => block.id)).toEqual(['headline', 'summary', 'facts', 'awards'])
    expect(grown.blocks[1]).toMatchObject({ paragraphs: ['A physicist and chemist.'] })
    expect(grown.partial).toBe(false)
    // The card it grew from is left as it was.
    expect(card.blocks[1]).toMatchObject({ paragraphs: ['Looking into it.'] })
  })

  it('takes blocks away, but never every block', () => {
    expect(applyPatch(card, { blocks: [], drop: ['facts'], partial: true }).blocks.map((b) => b.id)).toEqual([
      'headline',
      'summary',
    ])
    expect(applyPatch(card, { blocks: [], drop: ['headline', 'summary', 'facts'], partial: false })).toBe(card)
  })

  it('leaves off a citation to a source the card no longer has', () => {
    const grown = applyPatch(card, {
      blocks: [],
      drop: [],
      sources: [card.sources[0]],
      partial: false,
    })
    expect(grown.sources).toHaveLength(1)
    expect(grown.blocks[1].cite).toEqual([0])
    expect(grown.blocks[2]).not.toHaveProperty('cite')
  })
})

describe('readPatch', () => {
  it('reads blocks the way a card is read, dropping what could not be drawn', () => {
    const patch = readPatch({
      t: 'card_patch',
      blocks: [
        { id: 'summary', type: 'prose', paragraphs: ['Grown.'] },
        { id: 'broken', type: 'facts', items: 'nope' },
        { id: 'strange', type: 'hologram' },
      ],
      drop: ['old', 42, ''],
      partial: false,
    })
    expect(patch).toEqual({
      blocks: [{ id: 'summary', slot: 'body', type: 'prose', paragraphs: ['Grown.'] }],
      drop: ['old'],
      partial: false,
    })
  })

  it('checks citations against the sources the patch brings with it', () => {
    const patch = readPatch({
      blocks: [{ id: 'h', type: 'headline', title: 'T', cite: [0, 1] }],
      sources: [{ title: 'Only one', url: 'https://a.example' }, { title: 'Bad', url: 'javascript:1' }],
      partial: false,
    })
    expect(patch?.sources).toHaveLength(1)
    expect(patch?.blocks[0].cite).toEqual([0])
  })

  it('is nothing when there is nothing to apply', () => {
    expect(readPatch({ blocks: [], drop: [], partial: true })).toBeNull()
    expect(readPatch('patch')).toBeNull()
    // Saying the card is finished is something, even with no blocks.
    expect(readPatch({ blocks: [], partial: false })).toEqual({ blocks: [], drop: [], partial: false })
  })
})
