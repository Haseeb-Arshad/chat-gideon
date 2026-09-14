import { describe, expect, it } from 'vitest'
import { hear, saidEvents, saidItems, saidPoints, saidRows, significantWords } from './mentions'
import type { ChartBlock, ListBlock, TableBlock, TimelineBlock } from './schema'

/**
 * What a sentence mentions on a card. The rule that matters most is the one
 * that stops a common word lighting half the card.
 */

const table: TableBlock = {
  id: 't',
  slot: 'data',
  type: 'table',
  rowHeaders: true,
  columns: [
    { key: 'subject', label: '', kind: 'text' },
    { key: 'latest', label: 'Latest', kind: 'number' },
  ],
  rows: [
    { id: 'jpn', cells: [{ text: 'Japan' }, { text: '123.4 million', value: 123.4 }] },
    { id: 'kor', cells: [{ text: 'South Korea' }, { text: '51.7 million', value: 51.7 }] },
    { id: 'chn', cells: [{ text: 'China' }, { text: '1.41 billion', value: 1.41 }] },
  ],
}

const timeline: TimelineBlock = {
  id: 'tl',
  slot: 'more',
  type: 'timeline',
  events: [
    { id: 'born', date: '7 November 1867', label: 'Born in Warsaw' },
    { id: 'physics', date: '1903', label: 'Nobel Prize in Physics' },
    { id: 'chemistry', date: '1911', label: 'Nobel Prize in Chemistry' },
    { id: 'died', date: '4 July 1934', label: 'Died in Sancellemoz' },
  ],
}

const chart: ChartBlock = {
  id: 'c',
  slot: 'data',
  type: 'chart',
  form: 'line',
  title: 'Population',
  x: ['1960', '1990', '2010', '2025'],
  series: [{ key: 'jpn', label: 'Japan', values: [93, 123, 128, 123] }],
}

describe('hearing', () => {
  it('keeps the words that name things, the numbers and the years', () => {
    const heard = hear('Japan peaked at 128,070,000 in 2010, and the two Koreas were apart.')
    expect(heard.years).toEqual(new Set(['2010']))
    expect(heard.numbers.has('128070000')).toBe(true)
    expect(heard.words.has('japan')).toBe(true)
    // Glue is not a name.
    expect(significantWords('with the population of Japan since 1960')).toEqual(['population', 'japan'])
  })
})

describe('table rows', () => {
  it('lights a row named aloud, and only when its whole name was said', () => {
    expect(saidRows(table, hear('China is by far the largest.'))).toEqual(new Set(['chn']))
    expect(saidRows(table, hear('The south of the country is warmer.'))).toEqual(new Set())
    expect(saidRows(table, hear('South Korea has about fifty million people.'))).toEqual(new Set(['kor']))
  })

  it('lights a row by a figure only it holds, but never by a small one', () => {
    expect(saidRows(table, hear('about 123.4 million people'))).toEqual(new Set(['jpn']))
    const small: TableBlock = { ...table, rows: [{ id: 'a', cells: [{ text: 'A' }, { text: '2' }] }, { id: 'b', cells: [{ text: 'B' }, { text: '7' }] }] }
    expect(saidRows(small, hear('There are 2 of them.'))).toEqual(new Set())
  })

  it('lights nothing when a word would light more than three rows', () => {
    const cities: TableBlock = {
      ...table,
      rows: ['North', 'South', 'East', 'West'].map((side) => ({ id: side, cells: [{ text: `${side} Station` }, { text: '1' }] })),
    }
    // "station" alone names none of them; all four named at once is too many.
    expect(saidRows(cities, hear('The station is busy.'))).toEqual(new Set())
    expect(saidRows(cities, hear('North station, South station, East station and West station.'))).toEqual(new Set())
    expect(saidRows(cities, hear('North station and South station.'))).toEqual(new Set(['North', 'South']))
  })
})

describe('timeline events', () => {
  it('lights an event by its year, or by its whole name', () => {
    expect(saidEvents(timeline, hear('In 1903 she shared the prize.'))).toEqual(new Set(['physics']))
    expect(saidEvents(timeline, hear('She won the Nobel Prize in Chemistry too.'))).toEqual(new Set(['chemistry']))
    // "Nobel prize" names both prizes, but neither in full.
    expect(saidEvents(timeline, hear('She won the Nobel Prize twice.'))).toEqual(new Set())
    expect(saidEvents(timeline, hear('Born in 1867 in Warsaw.'))).toEqual(new Set(['born']))
  })
})

describe('chart points', () => {
  it('lights the positions whose year was said', () => {
    expect(saidPoints(chart, hear('from 93 million in 1960 to a peak in 2010'))).toEqual(new Set([0, 2]))
  })

  it('lights a category by its name, and nothing for more than three', () => {
    const days: ChartBlock = { ...chart, x: ['Monday', 'Tuesday', 'Wednesday'] }
    expect(saidPoints(days, hear('Rain is likeliest on Tuesday.'))).toEqual(new Set([1]))
    expect(saidPoints(chart, hear('1960, 1990, 2010 and 2025.'))).toEqual(new Set())
  })
})

describe('list items', () => {
  it('lights an item whose name was said', () => {
    const list: ListBlock = {
      id: 'l',
      slot: 'body',
      type: 'list',
      ordered: true,
      items: [
        { id: 'a', title: 'Roastery by the tram stop' },
        { id: 'b', title: 'Bakery on the square' },
      ],
    }
    expect(saidItems(list, hear('The bakery on the square opens at seven.'))).toEqual(new Set(['b']))
  })
})
