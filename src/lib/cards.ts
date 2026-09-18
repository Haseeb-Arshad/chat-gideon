/**
 * What GIDEON puts on screen about something it looked up.
 *
 * A card is written by a model from a research brief, which makes it the one
 * place in the interface where a model's words are shown as fact rather than
 * spoken as conversation. So nothing here trusts the shape it is handed: every
 * field is cleaned and clipped, and any number the brief does not itself
 * contain is treated as invented and removed, together with whatever carried
 * it. A card with too little left after that is not shown at all, because an
 * empty pane of glass says less than no pane.
 *
 * This is the first kind of card: one flat shape, drawn by a model from a
 * brief. Cards are sent and drawn as blocks now (`cards/schema.ts`), and a
 * flat card is turned into blocks once it has passed the checks below.
 */

import {
  cleanText,
  grounded,
  groundedSentences,
  hostOf,
  knownNumbers,
} from './cards/ground'
import type { CardFact, CardImage, CardPicture, CardSource } from './cards/schema'

export { cleanText, grounded, hostOf, knownNumbers, numbersIn } from './cards/ground'
export type { CardFact, CardImage, CardPicture, CardSource } from './cards/schema'

export type CardKind = 'entity' | 'figure' | 'news' | 'answer' | 'gallery'

/** The kinds a model may choose when drawing a card from a brief. A gallery is built, not drawn. */
export const CARD_KINDS: readonly CardKind[] = ['entity', 'figure', 'news', 'answer']

export interface Card {
  kind: CardKind
  /** The question that was researched, carried over from the searching pane. */
  query: string
  title: string
  subtitle: string
  summary: string
  /** The one number the answer is, on a `figure` card. */
  figure: { value: string; label: string } | null
  /** The date above a `news` headline. */
  kicker: string
  facts: CardFact[]
  image: CardImage | null
  /** Only on a `gallery`: the pictures themselves. */
  pictures: CardPicture[]
  sources: CardSource[]
}

const LIMITS = {
  title: 64,
  subtitle: 80,
  summary: 220,
  label: 24,
  value: 72,
  figureValue: 20,
  figureLabel: 48,
  kicker: 40,
  sourceTitle: 80,
  facts: 5,
  sources: 4,
}

/**
 * A card asked for in full: everything the same, except the two limits that
 * would otherwise cut a fuller brief back down to a glance. Each sentence and
 * fact is still checked against the brief on its own, so this only raises how
 * much grounded material a card may hold, never what counts as grounded.
 */
const DEEP_LIMITS = { ...LIMITS, summary: 900, facts: 8 }

export interface CardContext {
  query: string
  /** The brief the card was drawn from, without its list of sources. */
  brief: string
  sources: Array<{ title: string; url: string }>
}

export interface ParsedCard {
  card: Card
  /** For an entity, the Wikipedia article to take a picture from. */
  subject: string
}

/**
 * Turns whatever a model produced into a card, or into nothing.
 *
 * Returns null for anything that is not worth a pane: a model that declined, a
 * card with no title, or one with neither a summary, a figure, nor at least two
 * facts left after the grounding check.
 */
export function parseCard(raw: unknown, context: CardContext, options: { deep?: boolean } = {}): ParsedCard | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  if (input.show === false) return null

  const limits = options.deep ? DEEP_LIMITS : LIMITS
  const known = knownNumbers(context.brief)
  const keep = (text: string) => (text && grounded(text, known) ? text : '')

  let kind: CardKind = CARD_KINDS.includes(input.kind as CardKind)
    ? (input.kind as CardKind)
    : 'answer'

  const title = keep(cleanText(input.title, LIMITS.title))
  if (!title) return null
  const subtitle = keep(cleanText(input.subtitle, LIMITS.subtitle))
  const summary = groundedSentences(cleanText(input.summary, limits.summary), known)

  let figure: Card['figure'] = null
  if (kind === 'figure' && input.figure && typeof input.figure === 'object') {
    const raw = input.figure as Record<string, unknown>
    const value = keep(cleanText(raw.value, LIMITS.figureValue))
    // A figure is a number by definition; "unknown" is not one.
    if (/\d/.test(value)) figure = { value, label: cleanText(raw.label, LIMITS.figureLabel) }
  }
  if (kind === 'figure' && !figure) kind = 'answer'

  const facts: CardFact[] = []
  const seen = new Set<string>()
  const repeats = new Set([title, figure?.value ?? ''].map((text) => text.toLowerCase()))
  for (const item of Array.isArray(input.facts) ? input.facts : []) {
    if (!item || typeof item !== 'object') continue
    const fact = item as Record<string, unknown>
    const label = cleanText(fact.label, LIMITS.label)
    const value = keep(cleanText(fact.value, LIMITS.value))
    if (!label || !value) continue
    const key = label.toLowerCase()
    if (seen.has(key) || repeats.has(value.toLowerCase())) continue
    seen.add(key)
    facts.push({ label, value })
    if (facts.length === limits.facts) break
  }

  if (!summary && !figure && facts.length < 2) return null

  const sources: CardSource[] = []
  for (const source of context.sources) {
    const host = /^https?:\/\//.test(source.url) ? hostOf(source.url) : ''
    if (!host || sources.some((existing) => existing.url === source.url)) continue
    sources.push({ title: cleanText(source.title, LIMITS.sourceTitle) || host, url: source.url, host })
    if (sources.length === LIMITS.sources) break
  }

  return {
    card: {
      kind,
      query: cleanText(context.query, 200),
      title,
      subtitle,
      summary,
      figure,
      kicker: kind === 'news' ? keep(cleanText(input.kicker, LIMITS.kicker)) : '',
      facts,
      image: null,
      pictures: [],
      sources,
    },
    subject: kind === 'entity' ? cleanText(input.subject, 100) : '',
  }
}
