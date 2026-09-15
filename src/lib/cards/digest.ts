/**
 * The card in front, in a few hundred characters, for the speaking model.
 *
 * The model knows a card by its title, which is enough for "go back to Marie
 * Curie" and not for "which of them is bigger?" or "when was the peak?". Those
 * are questions about what the person is looking at, so the model is told what
 * that is: the figures, the rows, the dates, in the order the card shows them.
 * It is told, not shown the card itself, so it can answer from it without
 * reading it out.
 */

import { formatNumber, withUnit } from './chart-math'
import { conditionOf, degrees } from './weather'
import { orderBySlot, type Block, type CardV2 } from './schema'

export const DIGEST_LIMIT = 400

function joined(parts: string[], separator = '; '): string {
  return parts.filter(Boolean).join(separator)
}

function blockDigest(block: Block): string {
  switch (block.type) {
    case 'headline':
      return block.subtitle ?? ''
    case 'stat':
      return `${block.label ? `${block.label}: ` : ''}${block.value}${block.change ? `, ${block.change.value} ${block.change.period}`.trimEnd() : ''}`
    case 'prose':
      return block.paragraphs[0] ?? ''
    case 'facts':
      return joined(block.items.map((item) => `${item.label}: ${item.value}`))
    case 'table':
      return `Table of ${joined(block.columns.map((column) => column.label).filter(Boolean), ', ')}: ${joined(
        block.rows.map((row) => joined(row.cells.map((cell) => cell.text), ' / ')),
      )}`
    case 'chart': {
      const lines = block.series.map((series) => {
        const points = series.values.flatMap((value, index) => (value === null ? [] : [{ x: block.x[index], value }]))
        if (!points.length) return ''
        const say = (value: number) => withUnit(formatNumber(value, 1), block.unit)
        const first = points[0]
        const last = points[points.length - 1]
        const high = points.reduce((best, point) => (point.value > best.value ? point : best))
        return `${series.label} ${say(first.value)} in ${first.x}, ${say(last.value)} in ${last.x}, highest ${say(high.value)} in ${high.x}`
      })
      return `Chart of ${block.title.toLowerCase()}: ${joined(lines)}`
    }
    case 'timeline':
      return `Timeline: ${joined(block.events.map((event) => `${event.date} ${event.label}`))}`
    case 'list':
      return joined(block.items.map((item) => item.title))
    case 'steps':
      return `${block.items.length} steps, starting: ${block.items[0]}`
    case 'note':
      return block.text
    case 'quote':
      return `"${block.text}"${block.who ? ` (${block.who})` : ''}`
    case 'stories':
      return `Stories, the most reported first: ${joined(block.items.map((story) => `${story.headline} (${story.host})`))}`
    case 'forecast': {
      const say = (value: number) => `${degrees(value)}${block.unit === '°F' ? 'F' : 'C'}`
      const parts: string[] = []
      if (block.hours.length) {
        const warmest = block.hours.reduce((best, hour) => (hour.temperature > best.temperature ? hour : best))
        const coolest = block.hours.reduce((best, hour) => (hour.temperature < best.temperature ? hour : best))
        const rain = Math.max(...block.hours.map((hour) => hour.rainChance ?? 0))
        parts.push(`Next ${block.hours.length} hours: warmest ${say(warmest.temperature)} at ${warmest.time}, coolest ${say(coolest.temperature)} at ${coolest.time}, chance of rain up to ${rain}%`)
      }
      if (block.days.length) {
        parts.push(
          `Days: ${joined(block.days.map((day) => `${day.day} ${conditionOf(day.code).text.toLowerCase()}, ${say(day.low)} to ${say(day.high)}${day.rainChance ? `, ${day.rainChance}% rain` : ''}`))}`,
        )
      }
      return parts.join('. ')
    }
    case 'meter': {
      const band = block.bands.find((each) => block.value >= each.from && block.value < each.to)
      return `${block.label}: ${formatNumber(block.value, 1)}${band ? ` (${band.label.toLowerCase()})` : ''}`
    }
    case 'gallery':
      return `${block.pictures.length} pictures`
    case 'media':
    case 'chips':
      return ''
  }
}

/** What the card shows, clipped at a boundary rather than mid-word. */
export function digestOf(card: CardV2): string {
  const text = orderBySlot(card.blocks)
    .map(blockDigest)
    .filter(Boolean)
    .join('. ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= DIGEST_LIMIT) return text
  const cut = text.slice(0, DIGEST_LIMIT - 1)
  const boundary = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf('. '), cut.lastIndexOf(', '))
  return `${(boundary > DIGEST_LIMIT * 0.5 ? cut.slice(0, boundary) : cut).trimEnd()}…`
}
