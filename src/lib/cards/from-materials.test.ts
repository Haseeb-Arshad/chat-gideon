import { describe, expect, it } from 'vitest'
import { fromLegacy } from './legacy'
import { changeBetween, cardFromMaterials, describeCard, formatStat, mergeCards, portraitSubject } from './from-materials'
import type { RecordMaterial, SeriesMaterial } from './materials'
import { applyPatch } from './patch'
import { readCard } from './read'
import { orderBySlot, type Block, type CardV2 } from './schema'

/**
 * Cards drawn from materials. The promise is that everything on them is copied
 * from a material or worked out in arithmetic that is shown, and that each
 * kind of material becomes the card a person would draw by hand.
 */

const NOW = Date.UTC(2026, 8, 14)
const fetchedAt = '2026-09-14T00:00:00.000Z'

function series(subject: string, iso2: string, points: Array<[number, number]>, overrides: Partial<SeriesMaterial> = {}): SeriesMaterial {
  return {
    id: `worldbank:population:${subject}`,
    kind: 'series',
    measure: 'worldbank:population',
    name: 'Population',
    subject,
    unit: '',
    points: points.map(([year, value]) => ({ x: String(year), value })),
    source: { title: 'World Bank', url: `https://data.worldbank.org/indicator/SP.POP.TOTL?locations=${iso2}`, fetchedAt },
    ...overrides,
  }
}

const japan = series('Japan', 'JP', [[1960, 93216000], [1990, 123478000], [2010, 128070000], [2025, 123366734]])
const korea = series('South Korea', 'KR', [[1960, 25012374], [2025, 51664311]])

const curie: RecordMaterial = {
  id: 'wikidata:Q7186',
  kind: 'record',
  type: 'person',
  subject: 'Marie Curie',
  description: 'Polish-born French physicist and chemist (1867–1934)',
  fields: [
    { key: 'born', label: 'Born', value: '7 November 1867, Warsaw' },
    { key: 'died', label: 'Died', value: '4 July 1934, Sancellemoz' },
    { key: 'occupation', label: 'Occupation', value: 'physicist, chemist' },
    { key: 'awards', label: 'Awards', value: 'Nobel Prize in Physics, Nobel Prize in Chemistry' },
  ],
  events: [
    { date: '7 November 1867', sort: 18671107, label: 'Born in Warsaw' },
    { date: '1903', sort: 19030000, label: 'Nobel Prize in Physics' },
    { date: '1911', sort: 19110000, label: 'Nobel Prize in Chemistry' },
    { date: '4 July 1934', sort: 19340704, label: 'Died in Sancellemoz' },
  ],
  wikipedia: 'Marie Curie',
  source: { title: 'Wikidata', url: 'https://www.wikidata.org/wiki/Q7186', fetchedAt },
}

function city(subject: string, id: string, fields: Array<[string, string, string]>): RecordMaterial {
  return {
    id: `wikidata:${id}`,
    kind: 'record',
    type: 'place',
    subject,
    description: 'city in Portugal',
    fields: fields.map(([key, label, value]) => ({ key, label, value })),
    events: [],
    source: { title: 'Wikidata', url: `https://www.wikidata.org/wiki/${id}`, fetchedAt },
  }
}

const types = (card: CardV2 | null) => card?.blocks.map((block) => block.type)
const block = <T extends Block['type']>(card: CardV2 | null, type: T) =>
  card?.blocks.find((each): each is Extract<Block, { type: T }> => each.type === type)

describe('a series', () => {
  const card = cardFromMaterials('how has the population of Japan changed', [japan], NOW)

  it('becomes a trend: the latest figure, how it moved, the line, and where the figures stop', () => {
    expect(card).toMatchObject({ recipe: 'trend', size: 'wide', title: 'Population, Japan', asOf: '2025', partial: true })
    expect(types(card)).toEqual(['headline', 'stat', 'chart'])
    expect(block(card, 'headline')).toEqual({ id: 'headline', slot: 'head', type: 'headline', kicker: 'Population · 1960 to 2025', title: 'Japan' })
    expect(block(card, 'stat')).toMatchObject({
      value: '123.4 million',
      label: 'In 2025',
      change: { value: '+32.3%', direction: 'up', period: 'since 1960', formula: '(123,366,734 − 93,216,000) ÷ 93,216,000' },
    })
    expect(block(card, 'chart')).toMatchObject({
      form: 'line',
      title: 'Population',
      x: ['1960', '1990', '2010', '2025'],
      series: [{ label: 'Japan', values: [93216000, 123478000, 128070000, 123366734] }],
      // The peak is in the middle, so it is worth pointing at.
      marks: [{ at: 2, label: 'Peak' }],
      // A year behind is how official figures are published: the caption says so, no note.
      asOf: 'World Bank, to 2025',
    })
    expect(card?.sources).toEqual([
      { title: 'World Bank', url: 'https://data.worldbank.org/indicator/SP.POP.TOTL?locations=JP', host: 'data.worldbank.org' },
    ])
  })

  it('says so in a note when the figures are three years old or more', () => {
    const old = cardFromMaterials('q', [series('Japan', 'JP', [[2000, 1], [2023, 2]])], NOW)
    expect(block(old, 'note')).toMatchObject({ tone: 'stale', text: 'The latest World Bank figures are for 2023.' })
    const recent = cardFromMaterials('q', [series('Japan', 'JP', [[2000, 1], [2024, 2]])], NOW)
    expect(block(recent, 'note')).toBeUndefined()
  })

  it('keeps the precision of its series in the figure, so the card and the chart agree', () => {
    const years = cardFromMaterials('q', [series('Japan', 'JP', [[1960, 67.7], [2024, 84]], { unit: 'years' })], NOW)
    expect(block(years, 'stat')?.value).toBe('84.0 years')
  })

  it('survives being read off the wire exactly as it was drawn', () => {
    expect(readCard(JSON.parse(JSON.stringify(card)))).toEqual(card)
  })
})

describe('several series of the same measure', () => {
  const card = cardFromMaterials('japan and korea population', [japan, korea], NOW)

  it('become a comparison: one chart with a line each, and a table of where each stands, on the years any of them has', () => {
    expect(card).toMatchObject({ recipe: 'compare', size: 'wide', title: 'Population, Japan and South Korea' })
    expect(types(card)).toEqual(['headline', 'chart', 'table'])
    const chart = block(card, 'chart')!
    expect(chart.x).toEqual(['1960', '1990', '2010', '2025'])
    // Korea has no figure for 1990 or 2010: gaps, never zeros.
    expect(chart.series[1].values).toEqual([25012374, null, null, 51664311])
    expect(chart).not.toHaveProperty('marks')
    const table = block(card, 'table')!
    expect(table.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
      ['Japan', '123.4 million', '2025', '+32.3%'],
      // (51,664,311 − 25,012,374) ÷ 25,012,374 is 106.6%, and past 100 a percentage is whole.
      ['South Korea', '51.7 million', '2025', '+107%'],
    ])
  })
})

describe('figures in their own terms', () => {
  it('writes headline figures the way they are read', () => {
    expect(formatStat(4213000000000, 'US$')).toBe('$4.21 trillion')
    expect(formatStat(52300000000, 'US$')).toBe('$52.3 billion')
    expect(formatStat(34064, 'US$')).toBe('$34,064')
    expect(formatStat(8215424893, '')).toBe('8.22 billion')
    expect(formatStat(2.6, '%')).toBe('2.6%')
    expect(formatStat(84.1, 'years')).toBe('84.1 years')
  })

  it('compares a share in points, not as a percentage of itself', () => {
    expect(changeBetween(2.1, 3.4, '%', 'since 1991')).toEqual({ value: '+1.3 points', direction: 'up', period: 'since 1991', formula: '3.4 − 2.1' })
    expect(changeBetween(10, 7.5, '', 'since 2000')).toMatchObject({ value: '−25%', direction: 'down' })
    expect(changeBetween(5, 5, 'years', '')).toMatchObject({ value: 'no change', direction: 'flat' })
    // A change from nothing has no percentage.
    expect(changeBetween(0, 5, '', '')).toBeUndefined()
  })
})

describe('a record', () => {
  it('becomes a profile: who it is, the facts, and a timeline wide enough to run across', () => {
    const card = cardFromMaterials('who was marie curie', [curie], NOW)
    expect(card).toMatchObject({ recipe: 'profile', size: 'wide', title: 'Marie Curie' })
    expect(types(card)).toEqual(['headline', 'facts', 'timeline'])
    expect(block(card, 'headline')).toMatchObject({ subtitle: 'Polish-born French physicist and chemist (1867–1934)' })
    expect(block(card, 'timeline')?.events.map((event) => event.date)).toEqual(['7 November 1867', '1903', '1911', '4 July 1934'])
    expect(portraitSubject(card!, [curie])).toBe('Marie Curie')
  })

  it('stays a standard card without a timeline, and is no card at all with too little', () => {
    const quiet = { ...curie, events: [] }
    expect(cardFromMaterials('q', [quiet], NOW)).toMatchObject({ size: 'standard' })
    expect(types(cardFromMaterials('q', [quiet], NOW))).toEqual(['headline', 'facts'])
    expect(cardFromMaterials('q', [{ ...curie, events: [], fields: curie.fields.slice(0, 1) }], NOW)).toBeNull()
    expect(cardFromMaterials('q', [], NOW)).toBeNull()
  })

  it('puts a country record beside its own line, without repeating the population the line shows', () => {
    const country: RecordMaterial = {
      ...curie,
      id: 'wikidata:Q17',
      type: 'country',
      subject: 'Japan',
      fields: [
        { key: 'capital', label: 'Capital', value: 'Tokyo' },
        { key: 'population', label: 'Population', value: '123,802,000 (2024)' },
      ],
      events: [],
    }
    const card = cardFromMaterials('q', [japan, country], NOW)
    expect(types(card)).toEqual(['headline', 'stat', 'chart', 'facts'])
    expect(block(card, 'facts')?.items).toEqual([{ label: 'Capital', value: 'Tokyo' }])
    expect(card?.sources.map((source) => source.title)).toEqual(['World Bank', 'Wikidata'])
  })
})

describe('records of the same kind', () => {
  const lisbon = city('Lisbon', 'Q597', [
    ['country', 'Country', 'Portugal'],
    ['population', 'Population', '545,796 (2021)'],
    ['area', 'Area', '100 km²'],
    ['elevation', 'Elevation', '2 m'],
  ])
  const porto = city('Porto', 'Q36433', [
    ['country', 'Country', 'Portugal'],
    ['population', 'Population', '231,800 (2021)'],
    ['area', 'Area', '41 km²'],
  ])

  it('become a table of the facts they share', () => {
    const card = cardFromMaterials('compare lisbon and porto', [lisbon, porto], NOW)
    expect(card).toMatchObject({ recipe: 'compare', size: 'wide', title: 'Lisbon and Porto' })
    const table = block(card, 'table')!
    expect(table.columns.map((column) => column.label)).toEqual(['', 'Lisbon', 'Porto'])
    // Elevation is only Lisbon's, so it is not a comparison.
    expect(table.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
      ['Country', 'Portugal', 'Portugal'],
      ['Population', '545,796 (2021)', '231,800 (2021)'],
      ['Area', '100 km²', '41 km²'],
    ])
  })

  it('fall back to a profile of the first when they share too little to compare', () => {
    const bare = city('Porto', 'Q36433', [['country', 'Country', 'Portugal']])
    expect(cardFromMaterials('q', [lisbon, bare], NOW)).toMatchObject({ recipe: 'profile', title: 'Lisbon' })
  })
})

describe('the written card, folded in', () => {
  const written = fromLegacy({
    kind: 'entity',
    query: 'q',
    title: 'Marie Curie',
    subtitle: 'Physicist',
    summary: 'The first person to win two Nobel Prizes.',
    figure: null,
    kicker: '',
    facts: [
      { label: 'Born', value: '7 November 1867, Warsaw' },
      { label: 'Discovered', value: 'Polonium and radium' },
    ],
    image: { url: 'https://upload.wikimedia.org/curie.jpg', alt: 'Marie Curie', credit: 'Wikipedia' },
    pictures: [],
    sources: [{ title: 'Britannica', url: 'https://www.britannica.com/biography/Marie-Curie', host: 'britannica.com' }],
  })

  it('adds its sentence, its picture, the facts not already shown and its sources', () => {
    const card = cardFromMaterials('who was marie curie', [curie], NOW)!
    const patch = mergeCards(card, written)
    expect(patch.partial).toBe(false)
    expect(patch.blocks.map((each) => `${each.type}:${each.slot}`)).toEqual(['prose:summary', 'media:media', 'facts:facts'])
    const facts = patch.blocks.find((each) => each.type === 'facts')
    // "Born" is already there, from the record; "Discovered" is new.
    expect(facts?.type === 'facts' && facts.items.map((item) => item.label)).toEqual(['Born', 'Died', 'Occupation', 'Awards', 'Discovered'])
    expect(patch.sources?.map((source) => source.title)).toEqual(['Wikidata', 'Britannica'])

    // Laid out, the sentence sits under the headline, above the facts.
    const grown = applyPatch(card, patch)
    expect(orderBySlot(grown.blocks).map((each) => each.type)).toEqual(['media', 'headline', 'prose', 'facts', 'timeline'])
  })

  it('never puts a picture beside a chart, or a second figure on one', () => {
    const chart = cardFromMaterials('q', [japan], NOW)!
    const withFigure = { ...written, blocks: [...written.blocks, { id: 'stat', slot: 'body', type: 'stat', value: '123 million', label: 'People' } as Block] }
    const patch = mergeCards(chart, withFigure)
    expect(patch.blocks.map((each) => each.type)).toEqual(['prose', 'facts'])
  })

  it('finishes the card even when there was no written card', () => {
    const card = cardFromMaterials('q', [japan], NOW)!
    expect(mergeCards(card, null)).toEqual({ blocks: [], drop: [], partial: false })
  })
})

describe('describing what is on screen', () => {
  it('says what kind of thing it is, in a few words', () => {
    expect(describeCard(cardFromMaterials('q', [japan, korea], NOW)!)).toBe('a chart of population for Japan and South Korea, 1960 to 2025')
    expect(describeCard(cardFromMaterials('q', [curie], NOW)!)).toBe('a card on Marie Curie with its key facts and a timeline')
  })
})
