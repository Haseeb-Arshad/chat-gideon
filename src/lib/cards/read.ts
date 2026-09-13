/**
 * A card as the browser receives it, checked before anything draws it.
 *
 * The server that sends a card is our own, but a card crosses a wire, and a
 * renderer handed a string where it expects a list throws, and a throw while
 * rendering takes the whole conversation down with it, not just the card. So
 * nothing is assumed: every field is read for its shape, links must be web
 * links, pictures must be https, a block of a type this page does not know is
 * skipped, and a card with nothing left to draw is no card at all.
 *
 * It reads both kinds of card: the blocks sent now, and the flat card an older
 * server sends, which is turned into blocks on the way in.
 */

import { CARD_KINDS, type Card, type CardKind } from '../cards'
import { hostOf, isImageUrl, isWebUrl } from './ground'
import { fromLegacy } from './legacy'
import { isRecipeId, preferredSize } from './recipes'
import {
  BLOCK_TYPES,
  CARD_SCHEMA,
  CARD_SIZES,
  type Block,
  type BlockType,
  type CardFact,
  type CardImage,
  type CardPicture,
  type CardSize,
  type CardSource,
  type CardV2,
} from './schema'

type Input = Record<string, unknown>

/** A block without the fields every block shares, kept per type. */
type BlockBody = Block extends infer B ? (B extends Block ? Omit<B, 'id' | 'slot' | 'cite'> : never) : never

const isObject = (value: unknown): value is Input => Boolean(value) && typeof value === 'object'

/** A string, trimmed and bounded. These bounds guard the layout, not the content. */
function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function list(value: unknown, limit: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : []
}

function dimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function readImage(value: unknown): CardImage | null {
  if (!isObject(value) || !isImageUrl(value.url)) return null
  const width = dimension(value.width)
  const height = dimension(value.height)
  return {
    url: value.url,
    alt: text(value.alt, 200),
    credit: text(value.credit, 80),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  }
}

function readPicture(value: unknown): CardPicture | null {
  if (!isObject(value) || !isImageUrl(value.url)) return null
  const thumb = isImageUrl(value.thumb) ? value.thumb : value.url
  const pageUrl = isWebUrl(value.pageUrl) ? value.pageUrl : value.url
  return {
    url: value.url,
    thumb,
    alt: text(value.alt, 200),
    pageUrl,
    host: text(value.host, 80) || hostOf(pageUrl),
  }
}

function readFacts(value: unknown, limit: number): CardFact[] {
  const facts: CardFact[] = []
  for (const item of list(value, limit)) {
    if (!isObject(item)) continue
    const label = text(item.label, 60)
    const fact = text(item.value, 200)
    if (label && fact) facts.push({ label, value: fact })
  }
  return facts
}

function readSources(value: unknown): CardSource[] {
  const sources: CardSource[] = []
  for (const item of list(value, 8)) {
    if (!isObject(item) || !isWebUrl(item.url)) continue
    if (sources.some((source) => source.url === item.url)) continue
    const host = hostOf(item.url)
    sources.push({ title: text(item.title, 160) || host, url: item.url, host })
  }
  return sources
}

function readCite(value: unknown, sources: number): number[] | undefined {
  const cite = list(value, 8).filter(
    (index): index is number => Number.isInteger(index) && (index as number) >= 0 && (index as number) < sources,
  )
  return cite.length ? cite : undefined
}

/** One block's own fields, or null when it has nothing it could draw. */
function readBody(type: BlockType, input: Input): BlockBody | null {
  switch (type) {
    case 'headline': {
      const title = text(input.title, 200)
      if (!title) return null
      const kicker = text(input.kicker, 80)
      const subtitle = text(input.subtitle, 200)
      return { type, title, ...(kicker ? { kicker } : {}), ...(subtitle ? { subtitle } : {}) }
    }
    case 'stat': {
      const value = text(input.value, 60)
      return value ? { type, value, label: text(input.label, 80) } : null
    }
    case 'prose': {
      const paragraphs = list(input.paragraphs, 6)
        .map((paragraph) => text(paragraph, 1_200))
        .filter(Boolean)
      return paragraphs.length ? { type, paragraphs } : null
    }
    case 'facts': {
      const items = readFacts(input.items, 12)
      return items.length ? { type, items } : null
    }
    case 'media': {
      const image = readImage(input.image)
      return image ? { type, image } : null
    }
    case 'gallery': {
      const pictures = list(input.pictures, 12)
        .map(readPicture)
        .filter((picture): picture is CardPicture => picture !== null)
      return pictures.length ? { type, pictures } : null
    }
  }
}

function readBlocks(value: unknown, sources: number): Block[] {
  const blocks: Block[] = []
  const ids = new Set<string>()
  for (const item of list(value, 40)) {
    if (!isObject(item)) continue
    const type = item.type as BlockType
    // A block this page has never heard of is left out, not guessed at.
    if (!BLOCK_TYPES.includes(type)) continue
    const id = text(item.id, 64)
    if (!id || ids.has(id)) continue
    const body = readBody(type, item)
    if (!body) continue
    ids.add(id)
    const cite = readCite(item.cite, sources)
    blocks.push({ ...body, id, slot: text(item.slot, 32) || 'body', ...(cite ? { cite } : {}) } as Block)
  }
  return blocks
}

function readV2(input: Input): CardV2 | null {
  const title = text(input.title, 160)
  if (!title) return null
  const recipe = isRecipeId(input.recipe) ? input.recipe : 'answer'
  const size = CARD_SIZES.includes(input.size as CardSize) ? (input.size as CardSize) : preferredSize(recipe)
  const sources = readSources(input.sources)
  const blocks = readBlocks(input.blocks, sources.length)
  if (!blocks.length) return null
  return {
    schema: CARD_SCHEMA,
    recipe,
    size,
    query: text(input.query, 240),
    title,
    blocks,
    sources,
    asOf: text(input.asOf, 40) || null,
    partial: input.partial === true,
  }
}

/** The flat card an older server sends, read field by field and turned into blocks. */
function readLegacy(input: Input): CardV2 | null {
  const title = text(input.title, 160)
  if (!title) return null
  const kind: CardKind = CARD_KINDS.includes(input.kind as CardKind) || input.kind === 'gallery'
    ? (input.kind as CardKind)
    : 'answer'
  const figure = isObject(input.figure) && text(input.figure.value, 60)
    ? { value: text(input.figure.value, 60), label: text(input.figure.label, 80) }
    : null
  const card: Card = {
    kind,
    query: text(input.query, 240),
    title,
    subtitle: text(input.subtitle, 200),
    summary: text(input.summary, 1_200),
    figure,
    kicker: text(input.kicker, 80),
    facts: readFacts(input.facts, 8),
    image: readImage(input.image),
    pictures: list(input.pictures, 12)
      .map(readPicture)
      .filter((picture): picture is CardPicture => picture !== null),
    sources: readSources(input.sources),
  }
  const adapted = fromLegacy(card)
  // Read once more, so a legacy card meets exactly the same bar as a new one.
  return readV2(adapted as unknown as Input)
}

export function readCard(value: unknown): CardV2 | null {
  if (!isObject(value)) return null
  if (value.schema === CARD_SCHEMA) return readV2(value)
  if (typeof value.kind === 'string') return readLegacy(value)
  return null
}
