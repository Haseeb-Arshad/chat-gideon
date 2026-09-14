/**
 * Cards drawn from materials, in code, with no model in the loop.
 *
 * When the research desk has looked something up in a data source, the card
 * does not need a model to lay it out: a country's population by year is a
 * line chart, a person's record is facts and a timeline, two cities' records
 * side by side are a table. Every value here is copied from a material or
 * worked out from them in arithmetic that is shown, so the card cannot say a
 * number its source did not.
 *
 * The model-written card still has something to add, a sentence that answers
 * the question, and it arrives a few seconds later as a patch (`mergeCards`).
 */

import { formatNumber, withUnit } from './chart-math'
import { isRecord, isSeries, isStories, type Material, type RecordMaterial, type SeriesMaterial, type StoriesMaterial } from './materials'
import type { CardPatch } from './patch'
import type {
  Block,
  CardFact,
  CardSource,
  CardV2,
  ChartBlock,
  FactsBlock,
  StatBlock,
  StoriesBlock,
  StoryItem,
  TableBlock,
  TimelineBlock,
} from './schema'

/** Facts at a glance: more than this and the card reads like a record, not a card. */
const MAX_FACTS = 6
const MAX_COMPARE_ROWS = 8
/** A timeline needs a line's worth of events to be one. */
const MIN_EVENTS = 3

/**
 * A number the way a person reads a headline figure: "123.4 million",
 * "$4.21 trillion", "2.6%". `decimals` is the precision of the series it came
 * from, so 84.0 years on the card is 84.0 years on the chart beside it.
 */
export function formatStat(value: number, unit: string, decimals?: number): string {
  const magnitude = Math.abs(value)
  const scaled = (divisor: number, word: string, places: number) => `${(value / divisor).toFixed(places)} ${word}`
  if (unit === 'US$') {
    if (magnitude >= 1e12) return `$${scaled(1e12, 'trillion', 2)}`
    if (magnitude >= 1e9) return `$${scaled(1e9, 'billion', 1)}`
    return withUnit(value.toLocaleString('en-GB', { maximumFractionDigits: 0 }), unit)
  }
  if (!unit && magnitude >= 1e9) return scaled(1e9, 'billion', 2)
  if (!unit && magnitude >= 1e6) return scaled(1e6, 'million', 1)
  const places = decimals === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
  return withUnit(value.toLocaleString('en-GB', places), unit)
}

/** As many decimal places as a series' own values carry, up to two. */
function decimalsOf(series: SeriesMaterial): number {
  let decimals = 0
  for (const point of series.points) {
    decimals = Math.max(decimals, Math.min(2, (String(point.value).split('.')[1] ?? '').length))
  }
  return decimals
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function sourcesOf(materials: Material[]): CardSource[] {
  const sources: CardSource[] = []
  for (const material of materials) {
    if (sources.some((source) => source.url === material.source.url)) continue
    sources.push({ title: material.source.title, url: material.source.url, host: new URL(material.source.url).hostname.replace(/^www\./, '') })
  }
  return sources.slice(0, 6)
}

// -- How a number moved ------------------------------------------------------------

/**
 * The change from one value to another, and how it was worked out. A share is
 * compared in points, because a rise from 2% to 3% is one point, not 50 per
 * cent; everything else as a percentage of where it started.
 */
export function changeBetween(from: number, to: number, unit: string, since: string): StatBlock['change'] | undefined {
  if (from === to) return { value: 'no change', direction: 'flat', period: since, formula: `${formatNumber(to, 2)} − ${formatNumber(from, 2)}` }
  const direction = to > from ? 'up' : 'down'
  const sign = to > from ? '+' : '−'
  if (unit === '%') {
    const points = Math.abs(to - from)
    return {
      value: `${sign}${points.toLocaleString('en-GB', { maximumFractionDigits: 1 })} points`,
      direction,
      period: since,
      formula: `${to.toLocaleString('en-GB')} − ${from.toLocaleString('en-GB')}`,
    }
  }
  if (from === 0) return undefined
  const percent = Math.abs(((to - from) / Math.abs(from)) * 100)
  const places = percent >= 100 ? 0 : 1
  return {
    value: `${sign}${percent.toLocaleString('en-GB', { maximumFractionDigits: places })}%`,
    direction,
    period: since,
    formula: `(${to.toLocaleString('en-GB')} − ${from.toLocaleString('en-GB')}) ÷ ${Math.abs(from).toLocaleString('en-GB')}`,
  }
}

// -- Series --------------------------------------------------------------------------

function latest(series: SeriesMaterial) {
  return series.points[series.points.length - 1]
}

/** Every year any of the series has, in order, with each series' value or a gap. */
function aligned(group: SeriesMaterial[]) {
  const years = [...new Set(group.flatMap((series) => series.points.map((point) => point.x)))].sort(
    (a, b) => Number(a) - Number(b),
  )
  return {
    x: years,
    series: group.map((series) => {
      const byYear = new Map(series.points.map((point) => [point.x, point.value]))
      return { key: series.id, label: series.subject, values: years.map((year) => byYear.get(year) ?? null) }
    }),
  }
}

/**
 * Yearly figures a year or two behind are simply how official statistics are
 * published, and the chart's caption says where they stop. Three years or
 * more is worth a note of its own: an answer about now is being given from
 * the past.
 */
const STALE_YEARS = 3

function staleNote(group: SeriesMaterial[], now: number): Block | null {
  const newest = Math.max(...group.map((series) => Number(latest(series).x)))
  if (new Date(now).getUTCFullYear() - newest < STALE_YEARS) return null
  return { id: 'note', slot: 'aside', type: 'note', tone: 'stale', text: `The latest ${group[0].source.title} figures are for ${newest}.` }
}

function trendCard(question: string, group: SeriesMaterial[], records: RecordMaterial[], now: number): CardV2 {
  const [first] = group
  const { x, series } = aligned(group)
  const subjects = group.map((each) => each.subject)
  const title = `${first.name}, ${joinNames(subjects)}`
  const blocks: Block[] = [
    // The years ride on the kicker line: a line of height a chart can use.
    {
      id: 'headline',
      slot: 'head',
      type: 'headline',
      kicker: `${first.name} · ${x[0]} to ${x[x.length - 1]}`,
      title: joinNames(subjects),
    },
  ]

  if (group.length === 1) {
    const end = latest(first)
    const start = first.points[0]
    const change = changeBetween(start.value, end.value, first.unit, `since ${start.x}`)
    blocks.push({
      id: 'stat',
      slot: 'figure',
      type: 'stat',
      value: formatStat(end.value, first.unit, decimalsOf(first)),
      label: `In ${end.x}`,
      ...(change ? { change } : {}),
    } satisfies StatBlock)
  }

  // The peak marked, when it is somewhere in the middle and so worth pointing at.
  const values = series[0].values
  let peak = -1
  values.forEach((value, index) => {
    if (value !== null && (peak < 0 || value > (values[peak] as number))) peak = index
  })
  const chart: ChartBlock = {
    id: 'chart',
    slot: 'data',
    type: 'chart',
    form: 'line',
    title: first.name,
    ...(first.unit ? { unit: first.unit } : {}),
    xLabel: 'Year',
    asOf: `${first.source.title}, to ${Math.max(...group.map((each) => Number(latest(each).x)))}`,
    x,
    series,
    ...(group.length === 1 && peak > 0 && peak < x.length - 1 ? { marks: [{ at: peak, label: 'Peak' }] } : {}),
  }
  blocks.push(chart)

  if (group.length > 1) {
    const change = (each: SeriesMaterial) => changeBetween(each.points[0].value, latest(each).value, each.unit, '')
    const table: TableBlock = {
      id: 'table',
      slot: 'data',
      type: 'table',
      rowHeaders: true,
      // A unit is said once, in the header, except money, whose sign belongs on the figure.
      columns: [
        { key: 'subject', label: '', kind: 'text' },
        { key: 'latest', label: 'Latest', kind: 'number', ...(first.unit && first.unit !== 'US$' ? { unit: first.unit } : {}) },
        { key: 'year', label: 'Year', kind: 'text' },
        { key: 'change', label: `Change since ${group[0].points[0].x}`, kind: 'text' },
      ],
      rows: group.map((each) => ({
        id: each.id,
        cells: [
          { text: each.subject },
          { text: formatStat(latest(each).value, first.unit === 'US$' ? 'US$' : '', decimalsOf(each)), value: latest(each).value },
          { text: latest(each).x },
          { text: change(each)?.value ?? '' },
        ],
      })),
    }
    blocks.push(table)
  }

  // A record for the one country on the chart puts its facts beside the line.
  const record = group.length === 1 ? records.find((each) => each.subject === first.subject) : undefined
  if (record?.fields.length) blocks.push(factsOf(record, ['population']))
  const stale = staleNote(group, now)
  if (stale) blocks.push(stale)

  return {
    schema: 2,
    recipe: group.length > 1 ? 'compare' : 'trend',
    size: 'wide',
    query: question,
    title,
    blocks,
    sources: sourcesOf([...group, ...(record ? [record] : [])]),
    asOf: `${Math.max(...group.map((each) => Number(latest(each).x)))}`,
    partial: true,
  }
}

// -- Records --------------------------------------------------------------------------

function factsOf(record: RecordMaterial, skip: string[] = []): FactsBlock {
  const items: CardFact[] = record.fields
    .filter((field) => !skip.includes(field.key))
    .slice(0, MAX_FACTS)
    .map((field) => ({ label: field.label, value: field.value }))
  return { id: 'facts', slot: 'facts', type: 'facts', items }
}

function profileCard(question: string, record: RecordMaterial): CardV2 | null {
  const blocks: Block[] = [
    {
      id: 'headline',
      slot: 'head',
      type: 'headline',
      title: record.subject,
      ...(record.description ? { subtitle: capitalise(record.description) } : {}),
    },
  ]
  if (record.fields.length) blocks.push(factsOf(record))
  if (record.events.length >= MIN_EVENTS) {
    blocks.push({
      id: 'timeline',
      slot: 'more',
      type: 'timeline',
      events: record.events.map((event, index) => ({ id: `e${index}`, date: event.date, label: event.label })),
    } satisfies TimelineBlock)
  }
  // Two facts and no line is not yet worth a card of its own; the model's card will do.
  if (blocks.length === 1 || (record.fields.length < 2 && record.events.length < MIN_EVENTS)) return null
  return {
    schema: 2,
    recipe: 'profile',
    size: record.events.length > MIN_EVENTS ? 'wide' : 'standard',
    query: question,
    title: record.subject,
    blocks,
    sources: sourcesOf([record]),
    asOf: null,
    partial: true,
  }
}

function compareCard(question: string, group: RecordMaterial[]): CardV2 | null {
  const keys: Array<{ key: string; label: string }> = []
  for (const record of group) {
    for (const field of record.fields) {
      if (keys.some((each) => each.key === field.key)) continue
      if (group.filter((other) => other.fields.some((each) => each.key === field.key)).length >= 2) {
        keys.push({ key: field.key, label: field.label })
      }
    }
  }
  const rows = keys.slice(0, MAX_COMPARE_ROWS)
  if (rows.length < 2) return null

  const subjects = group.map((record) => record.subject)
  const table: TableBlock = {
    id: 'table',
    slot: 'data',
    type: 'table',
    rowHeaders: true,
    columns: [{ key: 'field', label: '', kind: 'text' }, ...group.map((record) => ({ key: record.id, label: record.subject, kind: 'text' as const }))],
    rows: rows.map((row) => ({
      id: row.key,
      cells: [{ text: row.label }, ...group.map((record) => ({ text: record.fields.find((field) => field.key === row.key)?.value ?? '' }))],
    })),
  }
  return {
    schema: 2,
    recipe: 'compare',
    size: 'wide',
    query: question,
    title: joinNames(subjects),
    blocks: [
      { id: 'headline', slot: 'head', type: 'headline', kicker: 'Compare', title: joinNames(subjects) },
      table,
    ],
    sources: sourcesOf(group),
    asOf: null,
    partial: true,
  }
}

// -- A front page ---------------------------------------------------------------------

/** A lead and two more; fewer is a list, not a front page. */
const MIN_STORIES = 3

/**
 * The day's stories as a front page. Every word on it is a publisher's: the
 * headlines, the openings and the pictures. Nothing is left for a model to
 * add, so the card is complete as it is drawn.
 */
function frontPageCard(question: string, material: StoriesMaterial): CardV2 {
  const title = material.topic ? capitalise(material.topic) : 'Top stories'
  const items: StoryItem[] = material.items.map((story, index) => ({ id: `s${index}`, ...story }))
  const newest = items
    .map((story) => Date.parse(story.published))
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => b - a)[0]
  return {
    schema: 2,
    recipe: 'front-page',
    size: 'feature',
    query: question,
    title,
    blocks: [
      { id: 'headline', slot: 'head', type: 'headline', title },
      { id: 'stories', slot: 'body', type: 'stories', since: material.since, items } satisfies StoriesBlock,
    ],
    // Each story is its own source, credited on its dateline.
    sources: items.slice(0, 6).map((story) => ({ title: story.headline, url: story.url, host: story.host })),
    asOf: newest === undefined ? null : new Date(newest).toISOString(),
    partial: false,
  }
}

// -- Choosing -------------------------------------------------------------------------

/**
 * The card the materials make, or null when they make none worth showing.
 *
 * The news comes first: a question that fetched the day's stories asked for
 * them. Then figures, since a question that fetched a series was asked about
 * the numbers. Then records, compared when there are several of the same kind.
 */
export function cardFromMaterials(question: string, materials: Material[], now: number): CardV2 | null {
  const stories = materials.filter(isStories).find((each) => each.items.length >= MIN_STORIES)
  if (stories) return frontPageCard(question, stories)

  const series = materials.filter(isSeries)
  const records = materials.filter(isRecord)

  if (series.length) {
    const groups = new Map<string, SeriesMaterial[]>()
    for (const each of series) groups.set(each.measure, [...(groups.get(each.measure) ?? []), each])
    const group = [...groups.values()].sort((a, b) => b.length - a.length)[0].slice(0, 5)
    return trendCard(question, group, records, now)
  }

  if (records.length) {
    const byType = new Map<string, RecordMaterial[]>()
    for (const record of records) byType.set(record.type, [...(byType.get(record.type) ?? []), record])
    const alike = [...byType.values()].find((group) => group.length >= 2)
    if (alike) {
      const compared = compareCard(question, alike.slice(0, 4))
      if (compared) return compared
    }
    return profileCard(question, records[0])
  }

  return null
}

/** The picture a card should be known by: the record it is about, if there is exactly one. */
export function portraitSubject(card: CardV2, materials: Material[]): string | null {
  if (card.recipe !== 'profile') return null
  const record = materials.filter(isRecord).find((each) => each.subject === card.title)
  return record?.wikipedia ?? null
}

/** What is on screen, in a few words, for the speaking model. */
export function describeCard(card: CardV2): string {
  const stories = card.blocks.find((block): block is StoriesBlock => block.type === 'stories')
  if (stories?.items.length) return `a front page of ${stories.items.length} stories, led by "${stories.items[0].headline}"`
  const chart = card.blocks.find((block): block is ChartBlock => block.type === 'chart')
  if (chart) {
    const subjects = joinNames(chart.series.map((series) => series.label))
    return `a chart of ${chart.title.toLowerCase()} for ${subjects}, ${chart.x[0]} to ${chart.x[chart.x.length - 1]}`
  }
  if (card.recipe === 'compare') return `a table comparing ${card.title}`
  const timeline = card.blocks.some((block) => block.type === 'timeline')
  return timeline ? `a card on ${card.title} with its key facts and a timeline` : `a card on ${card.title} with its key facts`
}

// -- The model's card, folded in --------------------------------------------------------

function normalised(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * What the model-written card adds to one drawn from materials: its one-sentence
 * answer, a picture if the materials card has none, and facts the materials do
 * not already show. Its headline and figure are not taken: the materials card's
 * are copied from the source.
 */
export function mergeCards(card: CardV2, written: CardV2 | null): CardPatch {
  // A card drawn complete, such as a front page, takes nothing from a model's.
  if (!written || !card.partial) return { blocks: [], drop: [], partial: false }
  const blocks: Block[] = []

  const summary = written.blocks.find((block) => block.type === 'prose')
  if (summary && !card.blocks.some((block) => block.type === 'prose')) {
    blocks.push({ ...summary, id: 'summary', slot: 'summary' })
  }

  // A picture beside a chart or a table would squeeze the data into a column; only a
  // card of words takes one.
  const media = written.blocks.find((block) => block.type === 'media')
  const data = card.blocks.some((block) => block.type === 'chart' || block.type === 'table')
  if (media && !data && !card.blocks.some((block) => block.type === 'media')) {
    blocks.push({ ...media, id: 'media', slot: 'media' })
  }

  if (!card.blocks.some((block) => block.type === 'stat')) {
    const stat = written.blocks.find((block) => block.type === 'stat')
    // A chart's card has its figure already; a written one would only repeat it differently.
    if (stat && !card.blocks.some((block) => block.type === 'chart')) blocks.push({ ...stat, id: 'stat', slot: 'figure' })
  }

  const facts = card.blocks.find((block): block is FactsBlock => block.type === 'facts')
  const writtenFacts = written.blocks.find((block): block is FactsBlock => block.type === 'facts')
  if (writtenFacts) {
    const shown = new Set((facts?.items ?? []).flatMap((item) => [normalised(item.label), normalised(item.value)]))
    const fresh = writtenFacts.items.filter((item) => !shown.has(normalised(item.label)) && !shown.has(normalised(item.value)))
    const room = MAX_FACTS + 2 - (facts?.items.length ?? 0)
    if (fresh.length && room > 0) {
      blocks.push({
        id: 'facts',
        slot: 'facts',
        type: 'facts',
        items: [...(facts?.items ?? []), ...fresh.slice(0, room)],
      })
    }
  }

  const sources = [...card.sources]
  for (const source of written.sources) {
    if (!sources.some((existing) => existing.url === source.url)) sources.push(source)
  }

  return {
    blocks,
    drop: [],
    ...(sources.length > card.sources.length ? { sources: sources.slice(0, 6) } : {}),
    partial: false,
  }
}
