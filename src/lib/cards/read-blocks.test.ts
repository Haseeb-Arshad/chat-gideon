import { describe, expect, it } from 'vitest'
import { readCard } from './read'
import type { Block } from './schema'

/**
 * The blocks after the first card, read off the wire. Each has one way to be
 * incomplete that matters, and that is what is pinned here: a table row with a
 * cell missing, a timeline event without a date, a link that would run.
 */

function blocksOf(...blocks: unknown[]): Block[] {
  return (
    readCard({
      schema: 2,
      recipe: 'compare',
      size: 'wide',
      query: 'q',
      title: 'Title',
      blocks: [{ id: 'h', type: 'headline', title: 'Title' }, ...blocks],
      sources: [{ title: 'Source', url: 'https://a.example' }],
      asOf: null,
      partial: false,
    })?.blocks.slice(1) ?? []
  )
}

describe('stat', () => {
  it('keeps a change it can show and a line with two points or more', () => {
    const [stat] = blocksOf({
      id: 's',
      type: 'stat',
      value: '4.9 M',
      label: 'Passengers',
      change: { value: '+58%', direction: 'up', period: 'since 2014', formula: '(4.9 − 3.1) ÷ 3.1' },
      spark: [3.1, 3.3, 'x', null, 4.9],
    })
    expect(stat).toMatchObject({ change: { value: '+58%', direction: 'up' }, spark: [3.1, 3.3, 4.9] })
  })

  it('drops a change with no direction, and a line of one point', () => {
    const [stat] = blocksOf({ id: 's', type: 'stat', value: '4.9', change: { value: '+1', direction: 'sideways' }, spark: [1] })
    expect(stat).not.toHaveProperty('change')
    expect(stat).not.toHaveProperty('spark')
  })
})

describe('table', () => {
  const columns = [
    { key: 'city', label: 'City', kind: 'text' },
    { key: 'people', label: 'Population', kind: 'number', unit: 'thousands' },
  ]

  it('keeps rows with one cell per column, and leaves out a row with a cell missing', () => {
    const [table] = blocksOf({
      id: 't',
      type: 'table',
      columns,
      rowHeaders: true,
      rows: [
        { id: 'lisbon', cells: [{ text: 'Lisbon' }, { text: '545', value: 545 }], cite: [0, 3] },
        { id: 'porto', cells: [{ text: 'Porto' }] },
        { id: 'faro', cells: ['Faro', { text: '64', value: '64' }] },
      ],
    })
    expect(table).toMatchObject({ type: 'table', rowHeaders: true, columns: [{ kind: 'text' }, { kind: 'number', unit: 'thousands' }] })
    const rows = table.type === 'table' ? table.rows : []
    expect(rows.map((row) => row.id)).toEqual(['lisbon', 'faro'])
    expect(rows[0].cite).toEqual([0])
    // A value that is not a number is not something to sort by.
    expect(rows[1].cells).toEqual([{ text: 'Faro' }, { text: '64' }])
  })

  it('is no table without columns or without rows', () => {
    expect(blocksOf({ id: 't', type: 'table', columns: [], rows: [{ cells: [] }] })).toEqual([])
    expect(blocksOf({ id: 't', type: 'table', columns, rows: [] })).toEqual([])
  })
})

describe('timeline, list, steps, chips, quote, note', () => {
  it('keeps events with a date and a label', () => {
    const [timeline] = blocksOf({
      id: 'tl',
      type: 'timeline',
      events: [
        { id: 'a', date: '1867', label: 'Born in Warsaw' },
        { id: 'b', date: '', label: 'Undated' },
        { id: 'c', date: '1903', label: 'Nobel Prize in Physics', detail: 'Shared', cite: [0] },
      ],
    })
    expect(timeline.type === 'timeline' && timeline.events.map((event) => event.date)).toEqual(['1867', '1903'])
  })

  it('keeps a list link only when it goes to the web, and a thumbnail only over https', () => {
    const [items] = blocksOf({
      id: 'l',
      type: 'list',
      ordered: true,
      items: [
        { title: 'Safe', url: 'https://a.example/1', thumb: 'https://a.example/t.jpg' },
        { title: 'Unsafe', url: 'javascript:alert(1)', thumb: 'http://a.example/t.jpg' },
      ],
    })
    expect(items).toMatchObject({ ordered: true })
    const list = items.type === 'list' ? items.items : []
    expect(list[0]).toMatchObject({ url: 'https://a.example/1', thumb: 'https://a.example/t.jpg' })
    expect(list[1]).not.toHaveProperty('url')
    expect(list[1]).not.toHaveProperty('thumb')
  })

  it('reads steps, questions, a quote and a note, and settles an unknown tone on info', () => {
    const blocks = blocksOf(
      { id: 'st', type: 'steps', items: ['Make a small loop.', '', 42] },
      { id: 'ch', type: 'chips', items: [{ label: 'When did she die?' }, { label: 'Her daughter', ask: 'Tell me about Irène Joliot-Curie' }] },
      { id: 'q', type: 'quote', text: 'Nothing in life is to be feared.', who: 'Marie Curie' },
      { id: 'n', type: 'note', tone: 'alarming', text: 'Figures are for the city itself.' },
    )
    expect(blocks.map((block) => block.type)).toEqual(['steps', 'chips', 'quote', 'note'])
    expect(blocks[0]).toMatchObject({ items: ['Make a small loop.'] })
    // A question with no separate wording asks its own label.
    expect(blocks[1]).toMatchObject({ items: [{ label: 'When did she die?', ask: 'When did she die?' }, { ask: 'Tell me about Irène Joliot-Curie' }] })
    expect(blocks[3]).toMatchObject({ tone: 'info' })
  })
})

describe('chart', () => {
  const years = ['2019', '2020', '2021', '2022']

  it('keeps a chart whose series have one value per position, with gaps as nulls', () => {
    const [chart] = blocksOf({
      id: 'c',
      type: 'chart',
      form: 'line',
      title: 'Passengers',
      unit: 'millions',
      x: years,
      series: [
        { key: 'ferry', label: 'Ferry', values: [4.4, 'n/a', 2.6, 3.5] },
        { key: 'short', label: 'Short', values: [1, 2] },
        { key: 'empty', label: 'Empty', values: [null, null, null, null] },
      ],
      marks: [
        { at: 1, label: 'Closed' },
        { at: 9, label: 'Out of range' },
        { at: 2, series: 'missing', label: 'No series' },
      ],
    })
    expect(chart).toMatchObject({ type: 'chart', form: 'line', unit: 'millions', x: years })
    const series = chart.type === 'chart' ? chart.series : []
    expect(series).toEqual([{ key: 'ferry', label: 'Ferry', values: [4.4, null, 2.6, 3.5] }])
    expect(chart.type === 'chart' && chart.marks).toEqual([{ at: 1, label: 'Closed' }])
  })

  it('refuses a form it does not know, too many positions, or a range without both ends', () => {
    expect(blocksOf({ id: 'c', type: 'chart', form: 'pie', x: years, series: [{ values: [1, 2, 3, 4] }] })).toEqual([])
    const tooMany = Array.from({ length: 16 }, (_, index) => `r${index}`)
    expect(
      blocksOf({ id: 'c', type: 'chart', form: 'bar', x: tooMany, series: [{ values: tooMany.map(() => 1) }] }),
    ).toEqual([])
    expect(blocksOf({ id: 'c', type: 'chart', form: 'range', x: years, series: [{ values: [1, 2, 3, 4] }] })).toEqual([])
  })

  it('rejects excessive series instead of silently omitting evidence', () => {
    const charts = blocksOf({
      id: 'c',
      type: 'chart',
      form: 'line',
      x: years,
      series: Array.from({ length: 8 }, (_, index) => ({ key: `s${index}`, values: [1, 2, 3, index] })),
    })
    expect(charts).toEqual([])
  })
  it('rejects reversed and unpaired range bounds', () => {
    for (const high of [[0, 3, 4, 5], [null, 3, 4, 5]]) {
      expect(blocksOf({ id: 'c', type: 'chart', form: 'range', x: years, series: [{ key: 'low', values: [1, 2, 3, 4] }, { key: 'high', values: high }] })).toEqual([])
    }
  })
})

describe('stories', () => {
  const story = (extra: Record<string, unknown>) => ({
    id: 's',
    headline: 'Night ferries return to the harbour',
    deck: 'The ferries will run until midnight.',
    url: 'https://harbour.example/ferries',
    host: 'harbour.example',
    published: '2026-09-14T06:00:00.000Z',
    outlets: 4,
    ...extra,
  })

  it('keeps stories with a headline and a web link, and a picture only over https', () => {
    const [block] = blocksOf({
      id: 'st',
      type: 'stories',
      since: 'week',
      items: [
        story({ id: 'a', image: 'https://harbour.example/lead.jpg' }),
        story({ id: 'b', image: 'http://harbour.example/lead.jpg', host: '', outlets: 400 }),
        story({ id: 'c', url: 'javascript:alert(1)' }),
        story({ id: 'd', headline: ' ' }),
        story({ id: 'a' }),
      ],
    })
    expect(block).toMatchObject({ type: 'stories', since: 'week' })
    const items = block.type === 'stories' ? block.items : []
    expect(items.map((each) => each.id)).toEqual(['a', 'b'])
    expect(items[0].image).toBe('https://harbour.example/lead.jpg')
    // No picture in the clear; the host is worked out from the link; a count is kept sensible.
    expect(items[1]).not.toHaveProperty('image')
    expect(items[1]).toMatchObject({ host: 'harbour.example', outlets: 99 })
  })

  it('keeps no date it cannot read, settles an unknown period on a day, and is nothing with no stories', () => {
    const [block] = blocksOf({ id: 'st', type: 'stories', since: 'month', items: [story({ published: 'yesterday-ish', outlets: 'many' })] })
    expect(block).toMatchObject({ since: 'day', items: [{ published: '', outlets: 1 }] })
    expect(blocksOf({ id: 'st', type: 'stories', items: [story({ url: 'ftp://harbour.example' })] })).toEqual([])
  })
})
