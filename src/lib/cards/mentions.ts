/**
 * What GIDEON has mentioned on the card in front, as it says it.
 *
 * A fact brightens when its value is heard; this does the same for the rest of
 * a card. Each kind of element has its own evidence: a timeline event is
 * mentioned by its year, a chart point by its position on the axis, a table
 * row or a list item by its name. Whatever is mentioned stays lit for the rest
 * of the reply, the way a person's eye stays on a line they have just read.
 *
 * One rule keeps it honest: a word that would light more than a few elements
 * lights none. "2024" in a table of years, or "prize" beside four prizes, says
 * nothing in particular, and lighting half a card is worse than lighting none.
 */

import { numbersIn } from './ground'
import type { ChartBlock, ListBlock, StoriesBlock, TableBlock, TimelineBlock } from './schema'

/** More elements than this answering to the same evidence is no answer at all. */
const AMBIGUOUS = 3

const STOP = new Set([
  'about', 'after', 'also', 'been', 'before', 'from', 'have', 'into', 'more', 'most', 'much', 'over', 'same', 'since',
  'some', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under',
  'very', 'were', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your', 'year', 'years',
])

export interface Heard {
  words: Set<string>
  numbers: Set<string>
  years: Set<string>
}

/** The words that name something: four letters or more, and not the glue between them. */
export function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !STOP.has(word) && !/^\d+$/.test(word))
}

function yearsIn(text: string): string[] {
  return text.match(/\b(1[0-9]{3}|2[0-9]{3})\b/g) ?? []
}

export function hear(spoken: string): Heard {
  return {
    words: new Set(significantWords(spoken)),
    numbers: new Set(numbersIn(spoken)),
    years: new Set(yearsIn(spoken)),
  }
}

/** Every significant word of a name has been said: "South Korea", not just "south". */
function named(text: string, heard: Heard): boolean {
  const words = significantWords(text)
  return words.length > 0 && words.every((word) => heard.words.has(word))
}

/** The ids whose evidence was heard, or none if too many of them answer to it. */
function unambiguous<T>(matches: T[]): Set<T> {
  return matches.length > AMBIGUOUS ? new Set() : new Set(matches)
}

/**
 * Table rows named aloud, by their first cell, or by a figure only that row
 * holds. A figure has to be at least three digits to count: "2" is in every
 * other row of any table.
 */
export function saidRows(block: TableBlock, heard: Heard): Set<string> {
  const counts = new Map<string, number>()
  for (const row of block.rows) {
    for (const number of new Set(row.cells.flatMap((cell) => numbersIn(cell.text)))) {
      counts.set(number, (counts.get(number) ?? 0) + 1)
    }
  }
  const matches = block.rows
    .filter((row) => {
      if (row.cells[0] && block.columns[0]?.kind === 'text' && named(row.cells[0].text, heard)) return true
      return row.cells.some((cell) =>
        numbersIn(cell.text).some((number) => number.replace('.', '').length >= 3 && counts.get(number) === 1 && heard.numbers.has(number)),
      )
    })
    .map((row) => row.id)
  return unambiguous(matches)
}

/** Timeline events whose year was said, or whose name was. */
export function saidEvents(block: TimelineBlock, heard: Heard): Set<string> {
  const matches = block.events
    .filter((event) => yearsIn(event.date).some((year) => heard.years.has(year)) || named(event.label, heard))
    .map((event) => event.id)
  return unambiguous(matches)
}

/** Positions on a chart's axis that were said: a year, or a category's name. */
export function saidPoints(block: ChartBlock, heard: Heard): Set<number> {
  const matches: number[] = []
  block.x.forEach((label, index) => {
    const years = yearsIn(label)
    if (years.length ? years.some((year) => heard.years.has(year)) : named(label, heard)) matches.push(index)
  })
  return unambiguous(matches)
}

/** List items whose name was said. */
export function saidItems(block: ListBlock, heard: Heard): Set<string> {
  return unambiguous(block.items.filter((item) => named(item.title, heard)).map((item) => item.id))
}

/**
 * Stories being briefed. A brief is in GIDEON's own words, not the headline's,
 * so a story is known by the words of its headline that no other story on the
 * page shares: two of them said, or its only one. "Officials" in two headlines
 * points at neither.
 */
export function saidStories(block: StoriesBlock, heard: Heard): Set<string> {
  const words = block.items.map((story) => new Set(significantWords(story.headline)))
  const matches = block.items
    .filter((_, index) => {
      const own = [...words[index]].filter((word) => !words.some((other, at) => at !== index && other.has(word)))
      const hits = own.filter((word) => heard.words.has(word)).length
      return hits >= 2 || (hits === 1 && own.length === 1)
    })
    .map((story) => story.id)
  return unambiguous(matches)
}
