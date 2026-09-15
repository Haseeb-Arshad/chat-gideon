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
  type ChartBlock,
  type ChartForm,
  type ChartSeries,
  type ChipsBlock,
  type ForecastDay,
  type ForecastHour,
  type ListItem,
  type LngLat,
  type MapPin,
  type NoteBlock,
  type StatChange,
  type StoryItem,
  type TableBlock,
  type TableCell,
  type TableColumn,
  type TableRow,
  type TimelineEvent,
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

export function readSources(value: unknown): CardSource[] {
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

const NOTE_TONES: readonly NoteBlock['tone'][] = ['info', 'stale', 'disagree', 'delayed']

function readChange(value: unknown): StatChange | null {
  if (!isObject(value)) return null
  const shown = text(value.value, 24)
  const direction = value.direction
  if (!shown || (direction !== 'up' && direction !== 'down' && direction !== 'flat')) return null
  const formula = text(value.formula, 120)
  return { value: shown, direction, period: text(value.period, 40), ...(formula ? { formula } : {}) }
}

/**
 * A table, whole or not at all. Every row must have exactly one cell per
 * column: a row with a cell missing would put its values under the wrong
 * headings, which is worse than leaving the row out.
 */
function readTable(input: Input, sources: number): TableBlock | null {
  const columns: TableColumn[] = []
  for (const item of list(input.columns, 8)) {
    if (!isObject(item)) continue
    const key = text(item.key, 40) || `c${columns.length}`
    const label = text(item.label, 60)
    if (!label || columns.some((column) => column.key === key)) continue
    const unit = text(item.unit, 20)
    columns.push({ key, label, kind: item.kind === 'number' ? 'number' : 'text', ...(unit ? { unit } : {}) })
  }
  if (!columns.length) return null

  const rows: TableRow[] = []
  for (const item of list(input.rows, 50)) {
    if (!isObject(item) || !Array.isArray(item.cells) || item.cells.length !== columns.length) continue
    const cells: TableCell[] = item.cells.map((cell) => {
      const cellInput: Input = isObject(cell) ? cell : { text: cell }
      const shown = typeof cellInput.text === 'number' ? String(cellInput.text) : text(cellInput.text, 120)
      return Number.isFinite(cellInput.value) ? { text: shown, value: cellInput.value as number } : { text: shown }
    })
    if (cells.every((cell) => !cell.text)) continue
    const id = text(item.id, 64) || `r${rows.length}`
    if (rows.some((row) => row.id === id)) continue
    const cite = readCite(item.cite, sources)
    rows.push({ id, cells, ...(cite ? { cite } : {}) })
  }
  if (!rows.length) return null

  const caption = text(input.caption, 160)
  return {
    type: 'table',
    columns,
    rows,
    ...(caption ? { caption } : {}),
    ...(input.rowHeaders === true ? { rowHeaders: true } : {}),
  } as TableBlock
}

/** How many series each form can carry, and how many x positions. */
const CHART_LIMITS: Record<ChartForm, { series: number; x: number; exactSeries?: number }> = {
  line: { series: 5, x: 400 },
  area: { series: 1, x: 400 },
  column: { series: 3, x: 24 },
  bar: { series: 1, x: 15 },
  range: { series: 2, x: 31, exactSeries: 2 },
}

/**
 * A chart, whole or not at all. Every series must have exactly one value per x
 * position, and anything that is not a finite number is a gap: a series with a
 * value missing drawn as though it had one would put its points over the wrong
 * labels.
 */
function readChart(input: Input): ChartBlock | null {
  const form = input.form as ChartForm
  const limits = CHART_LIMITS[form]
  if (!limits || !Object.hasOwn(CHART_LIMITS, form)) return null

  const x = list(input.x, limits.x + 1).map((label) => (typeof label === 'number' ? String(label) : text(label, 40)))
  if (x.length < 2 || x.length > limits.x || x.some((label) => !label)) return null

  const series: ChartSeries[] = []
  for (const item of list(input.series, 8)) {
    if (!isObject(item) || !Array.isArray(item.values) || item.values.length !== x.length) continue
    const key = text(item.key, 40) || `s${series.length}`
    if (series.some((existing) => existing.key === key)) continue
    const values = item.values.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : null))
    if (values.every((value) => value === null)) continue
    series.push({ key, label: text(item.label, 60) || key, values })
  }
  if (!series.length) return null
  if (limits.exactSeries && series.length !== limits.exactSeries) return null
  // A ninth line is never given a new colour; past the limit, series are left off.
  series.splice(limits.series)

  const marks = list(input.marks, 6).flatMap((item) => {
    if (!isObject(item) || !Number.isInteger(item.at)) return []
    const at = item.at as number
    const label = text(item.label, 40)
    const key = text(item.series, 40)
    if (at < 0 || at >= x.length || !label || (key && !series.some((existing) => existing.key === key))) return []
    return [{ at, label, ...(key ? { series: key } : {}) }]
  })

  const title = text(input.title, 120)
  const unit = text(input.unit, 16)
  const xLabel = text(input.xLabel, 40)
  const summary = text(input.summary, 300)
  const asOf = text(input.asOf, 40)
  return {
    type: 'chart',
    form,
    title,
    x,
    series,
    ...(unit ? { unit } : {}),
    ...(xLabel ? { xLabel } : {}),
    ...(marks.length ? { marks } : {}),
    ...(summary ? { summary } : {}),
    ...(asOf ? { asOf } : {}),
  } as ChartBlock
}

/** One block's own fields, or null when it has nothing it could draw. */
function readBody(type: BlockType, input: Input, sources: number): BlockBody | null {
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
      if (!value) return null
      const change = readChange(input.change)
      const spark = list(input.spark, 60).filter((point): point is number => Number.isFinite(point))
      return {
        type,
        value,
        label: text(input.label, 80),
        ...(change ? { change } : {}),
        // A line needs two points to be a line.
        ...(spark.length >= 2 ? { spark } : {}),
      }
    }
    case 'table':
      return readTable(input, sources)
    case 'timeline': {
      const events: TimelineEvent[] = []
      for (const item of list(input.events, 16)) {
        if (!isObject(item)) continue
        const id = text(item.id, 64) || `e${events.length}`
        const date = text(item.date, 40)
        const label = text(item.label, 120)
        if (!date || !label || events.some((event) => event.id === id)) continue
        const detail = text(item.detail, 240)
        const cite = readCite(item.cite, sources)
        events.push({ id, date, label, ...(detail ? { detail } : {}), ...(cite ? { cite } : {}) })
      }
      return events.length ? { type, events } : null
    }
    case 'note': {
      const note = text(input.text, 240)
      if (!note) return null
      const tone = NOTE_TONES.includes(input.tone as NoteBlock['tone']) ? (input.tone as NoteBlock['tone']) : 'info'
      return { type, tone, text: note }
    }
    case 'list': {
      const items: ListItem[] = []
      for (const item of list(input.items, 12)) {
        if (!isObject(item)) continue
        const title = text(item.title, 160)
        if (!title) continue
        const id = text(item.id, 64) || `i${items.length}`
        const meta = text(item.meta, 160)
        items.push({
          id,
          title,
          ...(meta ? { meta } : {}),
          ...(isWebUrl(item.url) ? { url: item.url } : {}),
          ...(isImageUrl(item.thumb) ? { thumb: item.thumb } : {}),
        })
      }
      return items.length ? { type, ordered: input.ordered === true, items } : null
    }
    case 'steps': {
      const items = list(input.items, 10)
        .map((step) => text(step, 240))
        .filter(Boolean)
      return items.length ? { type, items } : null
    }
    case 'chips': {
      const items: ChipsBlock['items'] = []
      for (const item of list(input.items, 4)) {
        if (!isObject(item)) continue
        const label = text(item.label, 60)
        const ask = text(item.ask, 200) || label
        if (label) items.push({ label, ask })
      }
      return items.length ? { type, items } : null
    }
    case 'quote': {
      const quote = text(input.text, 400)
      return quote ? { type, text: quote, who: text(input.who, 80) } : null
    }
    case 'chart':
      return readChart(input)
    case 'stories': {
      const items: StoryItem[] = []
      for (const item of list(input.items, 8)) {
        if (!isObject(item) || !isWebUrl(item.url)) continue
        const headline = text(item.headline, 200)
        const id = text(item.id, 64) || `s${items.length}`
        if (!headline || items.some((story) => story.id === id)) continue
        const published = text(item.published, 40)
        const outlets = typeof item.outlets === 'number' && Number.isInteger(item.outlets) ? Math.min(Math.max(item.outlets, 1), 99) : 1
        items.push({
          id,
          headline,
          deck: text(item.deck, 400),
          url: item.url,
          host: text(item.host, 80) || hostOf(item.url),
          // A date nothing can read is no date, rather than "Invalid Date" on a dateline.
          published: Number.isFinite(Date.parse(published)) ? published : '',
          ...(isImageUrl(item.image) ? { image: item.image } : {}),
          outlets,
        })
      }
      return items.length ? { type, since: input.since === 'week' ? 'week' : 'day', items } : null
    }
    case 'forecast': {
      const hours: ForecastHour[] = []
      for (const item of list(input.hours, 48)) {
        if (!isObject(item) || !Number.isFinite(item.temperature)) continue
        const time = text(item.time, 16)
        if (time) hours.push({ time, temperature: item.temperature as number, rainChance: percent(item.rainChance), code: weatherCode(item.code), isDay: item.isDay !== false })
      }
      const days: ForecastDay[] = []
      for (const item of list(input.days, 16)) {
        if (!isObject(item) || !Number.isFinite(item.high) || !Number.isFinite(item.low)) continue
        const id = text(item.id, 64) || `d${days.length}`
        const day = text(item.day, 24)
        if (!day || days.some((each) => each.id === id)) continue
        const high = item.high as number
        days.push({ id, day, date: text(item.date, 10), code: weatherCode(item.code), high, low: Math.min(item.low as number, high), rainChance: percent(item.rainChance) })
      }
      const now = isObject(input.now) ? { now: { code: weatherCode(input.now.code), isDay: input.now.isDay !== false } } : {}
      return hours.length || days.length ? { type, unit: input.unit === '°F' ? '°F' : '°C', ...now, hours, days } : null
    }
    case 'meter': {
      const label = text(input.label, 60)
      const min = Number.isFinite(input.min) ? (input.min as number) : 0
      const max = Number.isFinite(input.max) ? (input.max as number) : NaN
      if (!label || !Number.isFinite(input.value) || !(max > min)) return null
      const bands = list(input.bands, 8).flatMap((band) => {
        if (!isObject(band) || !Number.isFinite(band.from) || !Number.isFinite(band.to)) return []
        const name = text(band.label, 24)
        return name && (band.to as number) > (band.from as number) ? [{ from: band.from as number, to: band.to as number, label: name }] : []
      })
      return { type, label, value: Math.min(Math.max(input.value as number, min), max), min, max, bands }
    }
    case 'map': {
      const center = lngLat(input.center)
      // Only a public token may reach a browser, and only a picture from Mapbox's own static API.
      const token = typeof input.token === 'string' && /^pk\.[\w-]+\.[\w-]+\.[\w-]+$/.test(input.token) ? input.token : ''
      const still =
        typeof input.still === 'string' && input.still.startsWith('https://api.mapbox.com/styles/v1/') && !/access_token=sk\./.test(input.still) ? input.still : ''
      if (!center || !token || !still) return null
      const pins: MapPin[] = []
      for (const item of list(input.pins, 12)) {
        if (!isObject(item)) continue
        const at = lngLat(item.at)
        const label = text(item.label, 80)
        const id = text(item.id, 64) || `p${pins.length}`
        if (at && label && !pins.some((pin) => pin.id === id)) pins.push({ id, label, at })
      }
      const line = list(input.line, 600)
        .map(lngLat)
        .filter((point): point is LngLat => point !== null)
      const bounds = readBounds(input.bounds)
      return {
        type,
        view: input.view === 'route' || input.view === 'pins' ? input.view : 'pin',
        center,
        zoom: Number.isFinite(input.zoom) ? Math.min(Math.max(input.zoom as number, 0), 20) : 10,
        pins,
        ...(line.length >= 2 ? { line } : {}),
        ...(bounds ? { bounds } : {}),
        token,
        still,
      }
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

/** A longitude and a latitude that are on the Earth. */
function lngLat(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [longitude, latitude] = value
  return typeof longitude === 'number' && typeof latitude === 'number' && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90 ? [longitude, latitude] : null
}

function readBounds(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((each) => typeof each === 'number' && Number.isFinite(each))) return null
  const [west, south, east, north] = value as number[]
  return Math.abs(west) <= 180 && Math.abs(east) <= 180 && south >= -90 && north <= 90 && south < north ? [west, south, east, north] : null
}

/** A chance as a whole percentage, or null when there is none to show. */
function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 100) : null
}

/** A WMO weather code; anything else is read as cloud, the least surprising sky to draw. */
function weatherCode(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99 ? value : 3
}

export function readBlocks(value: unknown, sources: number): Block[] {
  const blocks: Block[] = []
  const ids = new Set<string>()
  for (const item of list(value, 40)) {
    if (!isObject(item)) continue
    const type = item.type as BlockType
    // A block this page has never heard of is left out, not guessed at.
    if (!BLOCK_TYPES.includes(type)) continue
    const id = text(item.id, 64)
    if (!id || ids.has(id)) continue
    const body = readBody(type, item, sources)
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
