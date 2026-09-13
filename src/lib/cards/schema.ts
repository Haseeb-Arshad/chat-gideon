/**
 * A card, as blocks.
 *
 * The first card was one flat shape with a field for everything a card had
 * ever needed, and a face that branched on each field. A table, a chart or a
 * map would each have been one more field and one more branch, and no card
 * could have held two of them. So a card is a list of small typed blocks,
 * arranged by a named recipe, at one of four sizes.
 *
 * A block is the unit everything else works in: a patch replaces one by its
 * id, a spoken word lights one up, and a browser that has never heard of a
 * block's type skips it rather than failing the whole card, so a newer server
 * can talk to an older page.
 *
 * Shared by the server, which makes cards, and the browser, which draws them.
 */

export const CARD_SCHEMA = 2

/**
 * Measured against the stage, never the window: a glance holds one number, a
 * standard card is the one that has always been there, a wide card holds a
 * comparison or a chart, and a feature takes the whole stage.
 */
export type CardSize = 'glance' | 'standard' | 'wide' | 'feature'

export const CARD_SIZES: readonly CardSize[] = ['glance', 'standard', 'wide', 'feature']

export type RecipeId =
  | 'answer'
  | 'profile'
  | 'figure'
  | 'news'
  | 'gallery'
  | 'compare'
  | 'trend'
  | 'ranking'
  | 'timeline'
  | 'steps'
  | 'front-page'
  | 'feature'
  | 'recipe'
  | 'place'
  | 'route'
  | 'nearby'
  | 'weather'
  | 'market'
  | 'video'
  | 'memory'
  | 'spread'

export interface CardSource {
  title: string
  url: string
  host: string
}

export interface CardImage {
  url: string
  alt: string
  /** Where the picture came from, shown small under it. */
  credit: string
  width?: number
  height?: number
}

/** One picture in a gallery: a tile-sized copy, a full-size one, and the page it is on. */
export interface CardPicture {
  url: string
  thumb: string
  alt: string
  pageUrl: string
  host: string
}

export interface CardFact {
  label: string
  value: string
}

interface BlockBase {
  /** Stable within its card, so a patch can replace it and a spoken word can find it. */
  id: string
  /** Where the recipe places it. */
  slot: string
  /** Indexes into the card's sources. */
  cite?: number[]
}

export interface HeadlineBlock extends BlockBase {
  type: 'headline'
  /** A date above a news headline, or a category. */
  kicker?: string
  title: string
  subtitle?: string
}

/** The one number an answer is, with what it measures. */
export interface StatBlock extends BlockBase {
  type: 'stat'
  value: string
  label: string
}

export interface ProseBlock extends BlockBase {
  type: 'prose'
  paragraphs: string[]
}

export interface FactsBlock extends BlockBase {
  type: 'facts'
  items: CardFact[]
}

export interface MediaBlock extends BlockBase {
  type: 'media'
  image: CardImage
}

export interface GalleryBlock extends BlockBase {
  type: 'gallery'
  pictures: CardPicture[]
}

export type Block =
  | HeadlineBlock
  | StatBlock
  | ProseBlock
  | FactsBlock
  | MediaBlock
  | GalleryBlock

export type BlockType = Block['type']

export const BLOCK_TYPES: readonly BlockType[] = ['headline', 'stat', 'prose', 'facts', 'media', 'gallery']

export interface CardV2 {
  schema: typeof CARD_SCHEMA
  recipe: RecipeId
  size: CardSize
  /** The question that was asked, carried over from the searching pane. */
  query: string
  /** What the card is called on the shelf, to the stage judge, and to the speaking model. */
  title: string
  blocks: Block[]
  sources: CardSource[]
  /** When the newest thing on the card was true, where that is known. */
  asOf: string | null
  /** More blocks are on their way. */
  partial: boolean
}

export function blockOf<T extends BlockType>(card: CardV2, type: T): Extract<Block, { type: T }> | undefined {
  return card.blocks.find((block): block is Extract<Block, { type: T }> => block.type === type)
}

/** The picture a card is known by on the shelf: its lead picture, or its first photograph. */
export function cardThumbnail(card: CardV2): string | undefined {
  return blockOf(card, 'media')?.image.url ?? blockOf(card, 'gallery')?.pictures[0]?.thumb
}
