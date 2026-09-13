/**
 * The first kind of card, drawn as blocks.
 *
 * The card builder still asks a model for the original flat card and checks it
 * field by field; this turns what survives into blocks, so there is one way to
 * draw a card however it was made. A page left open on an older build receives
 * the flat card too, and the browser turns it into blocks the same way.
 */

import type { Card, CardKind } from '../cards'
import { preferredSize } from './recipes'
import type { Block, CardV2, RecipeId } from './schema'

const RECIPE_FOR: Record<CardKind, RecipeId> = {
  entity: 'profile',
  figure: 'figure',
  news: 'news',
  answer: 'answer',
  gallery: 'gallery',
}

export function fromLegacy(card: Card): CardV2 {
  const recipe = RECIPE_FOR[card.kind] ?? 'answer'
  const blocks: Block[] = []

  if (card.kind === 'gallery') {
    blocks.push({ id: 'headline', slot: 'body', type: 'headline', kicker: 'Pictures', title: card.title })
    blocks.push({ id: 'gallery', slot: 'body', type: 'gallery', pictures: card.pictures ?? [] })
  } else {
    if (card.image) blocks.push({ id: 'media', slot: 'media', type: 'media', image: card.image })
    blocks.push({
      id: 'headline',
      slot: 'body',
      type: 'headline',
      ...(card.kicker ? { kicker: card.kicker } : {}),
      title: card.title,
      ...(card.subtitle ? { subtitle: card.subtitle } : {}),
    })
    if (card.figure) {
      blocks.push({ id: 'stat', slot: 'body', type: 'stat', value: card.figure.value, label: card.figure.label })
    }
    if (card.summary) blocks.push({ id: 'summary', slot: 'body', type: 'prose', paragraphs: [card.summary] })
    if (card.facts.length) blocks.push({ id: 'facts', slot: 'body', type: 'facts', items: card.facts })
  }

  return {
    schema: 2,
    recipe,
    size: preferredSize(recipe),
    query: card.query,
    title: card.title,
    blocks,
    sources: card.sources,
    asOf: null,
    partial: false,
  }
}
