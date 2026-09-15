/**
 * A card as it is shown beside the one in front: small enough to sit in a
 * column of three, and enough to know which card it is and want it back.
 *
 * Its name, what kind of thing it is, and one line of what it says, beside a
 * picture of it when it has one: a portrait, the first photograph, the map, or
 * the sky for the weather. Nothing is written here that the card does not say.
 */

import { blockOf, type CardV2 } from './schema'

export type CompactThumb = { kind: 'image'; url: string } | { kind: 'sky'; code: number; isDay: boolean }

export interface CompactCard {
  kicker: string
  title: string
  detail: string
  thumb: CompactThumb | null
}

const RECIPE_WORDS: Partial<Record<CardV2['recipe'], string>> = {
  weather: 'Weather',
  place: 'Map',
  route: 'Route',
  gallery: 'Pictures',
  'front-page': 'News',
  trend: 'Trend',
  compare: 'Comparison',
}

function thumbOf(card: CardV2): CompactThumb | null {
  const forecast = blockOf(card, 'forecast')
  const sky = forecast?.now ?? forecast?.hours[0]
  if (sky) return { kind: 'sky', code: sky.code, isDay: sky.isDay }
  const media = blockOf(card, 'media')
  if (media) return { kind: 'image', url: media.image.url }
  const gallery = blockOf(card, 'gallery')
  if (gallery?.pictures?.[0]) return { kind: 'image', url: gallery.pictures[0].thumb }
  const map = blockOf(card, 'map')
  if (map) return { kind: 'image', url: map.still }
  const story = blockOf(card, 'stories')?.items?.find((item) => item.image)
  if (story?.image) return { kind: 'image', url: story.image }
  return null
}

function detailOf(card: CardV2): string {
  const stat = blockOf(card, 'stat')
  if (stat) return [stat.value, stat.label].filter(Boolean).join(' · ')
  const headline = blockOf(card, 'headline')
  if (headline?.subtitle) return headline.subtitle
  const lead = blockOf(card, 'stories')?.items?.[0]
  if (lead) return lead.headline
  const fact = blockOf(card, 'facts')?.items?.[0]
  if (fact) return `${fact.label}: ${fact.value}`
  const prose = blockOf(card, 'prose')?.paragraphs?.[0]
  return prose ?? ''
}

export function compactOf(card: CardV2): CompactCard {
  const headline = blockOf(card, 'headline')
  return {
    kicker: headline?.kicker || RECIPE_WORDS[card.recipe] || '',
    title: headline?.title || card.title,
    detail: detailOf(card),
    thumb: thumbOf(card),
  }
}
