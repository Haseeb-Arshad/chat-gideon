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

/** How a number moved, worked out on the server from the values it came from. */
export interface StatChange {
  /** As it is shown: "+2.1%", "−340". */
  value: string
  direction: 'up' | 'down' | 'flat'
  /** What it is measured against: "since 2014", "in a day". */
  period: string
  /** How it was worked out, shown on request, because it was computed rather than found. */
  formula?: string
}

/** The one number an answer is, with what it measures. */
export interface StatBlock extends BlockBase {
  type: 'stat'
  value: string
  label: string
  change?: StatChange
  /** Up to 60 values, oldest first, for the small line beside the number. */
  spark?: number[]
}

export interface TableColumn {
  /** Unique within its table. */
  key: string
  label: string
  /** A number column is right-aligned in tabular figures, and can be sorted when every row has a value. */
  kind: 'text' | 'number'
  /** Said once in the header rather than in every cell. */
  unit?: string
}

export interface TableCell {
  /** As it is shown. */
  text: string
  /** What it sorts by, for a number column. */
  value?: number
}

export interface TableRow {
  id: string
  /** One per column, in the columns' order. */
  cells: TableCell[]
  cite?: number[]
}

export interface TableBlock extends BlockBase {
  type: 'table'
  caption?: string
  columns: TableColumn[]
  rows: TableRow[]
  /** The first column names each row, as in a comparison, and stays put when the table scrolls. */
  rowHeaders?: boolean
}

export interface TimelineEvent {
  id: string
  /** As it is shown: "1903", "July 1969", "9 September 2026". Sorted on the server. */
  date: string
  label: string
  detail?: string
  cite?: number[]
}

export interface TimelineBlock extends BlockBase {
  type: 'timeline'
  events: TimelineEvent[]
}

/** A caveat worth reading: an old figure, sources that disagree, a delayed price. */
export interface NoteBlock extends BlockBase {
  type: 'note'
  tone: 'info' | 'stale' | 'disagree' | 'delayed'
  text: string
}

export interface ListItem {
  id: string
  title: string
  meta?: string
  url?: string
  thumb?: string
}

export interface ListBlock extends BlockBase {
  type: 'list'
  ordered: boolean
  items: ListItem[]
}

export interface StepsBlock extends BlockBase {
  type: 'steps'
  items: string[]
}

/** Follow-up questions. Pressing one asks it, as if it had been typed. */
export interface ChipsBlock extends BlockBase {
  type: 'chips'
  items: Array<{ label: string; ask: string }>
}

/** Words someone said, exactly as a page the research read has them. */
export interface QuoteBlock extends BlockBase {
  type: 'quote'
  text: string
  who: string
}

/**
 * `line`: how values moved, up to five series. `area`: one series, filled to
 * zero. `column`: values side by side, up to three series. `bar`: one series
 * ranked, the largest at the top. `range`: a low and a high at each point, such
 * as a day's temperatures.
 */
export type ChartForm = 'line' | 'area' | 'column' | 'bar' | 'range'

export interface ChartSeries {
  key: string
  label: string
  /** One per x position. Null where there is no value: a gap, never a zero. */
  values: Array<number | null>
}

export interface ChartBlock extends BlockBase {
  type: 'chart'
  form: ChartForm
  /** What is measured: "Passengers a year". */
  title: string
  /** Said once, beside the title and in readouts: "millions", "°C". */
  unit?: string
  /** What the x positions are: "Year", "Hour", "Route". */
  xLabel?: string
  /** The x positions as they are shown, in order. */
  x: string[]
  series: ChartSeries[]
  /** Points worth naming on the chart: the peak, the low, an event. */
  marks?: Array<{ at: number; series?: string; label: string }>
  /** What the chart shows, in words. Worked out from the values when it is missing. */
  summary?: string
  /** When the newest value was true. */
  asOf?: string
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
  | TableBlock
  | TimelineBlock
  | NoteBlock
  | ListBlock
  | StepsBlock
  | ChipsBlock
  | QuoteBlock
  | ChartBlock

export type BlockType = Block['type']

export const BLOCK_TYPES: readonly BlockType[] = [
  'headline',
  'stat',
  'prose',
  'facts',
  'media',
  'gallery',
  'table',
  'timeline',
  'note',
  'list',
  'steps',
  'chips',
  'quote',
  'chart',
]

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

/**
 * The first block of a type. Tolerant of a card with no block list at all,
 * which `readCard` never lets through but a page swapping code under a live
 * stage in development has shown to happen; the frame asks this before its
 * face is inside the boundary that would otherwise catch it.
 */
export function blockOf<T extends BlockType>(card: CardV2, type: T): Extract<Block, { type: T }> | undefined {
  const blocks: Block[] | undefined = card.blocks
  return blocks?.find((block): block is Extract<Block, { type: T }> => block.type === type)
}

/** The picture a card is known by on the shelf: its lead picture, or its first photograph. */
export function cardThumbnail(card: CardV2): string | undefined {
  return blockOf(card, 'media')?.image.url ?? blockOf(card, 'gallery')?.pictures[0]?.thumb
}
