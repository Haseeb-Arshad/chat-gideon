/**
 * The arithmetic under a chart: its axis, its labels, its summary in words,
 * and how a long series is thinned without losing its shape.
 *
 * No charting library. A card's chart has one job, drawn one way, and the
 * pieces it needs are small enough to own and to test: round numbers on the
 * axis, labels that do not collide, and a sentence that says what the line
 * does, computed from the values rather than written by anyone.
 */

import type { ChartForm } from './schema'
import { isAdvancedForm } from './advanced-types'

export interface Scale {
  min: number
  max: number
  ticks: number[]
  /** Decimal places every tick label is shown with. */
  decimals: number
}

/** A step of 1, 2, 2.5 or 5 times a power of ten, the steps people read easily. */
export function niceStep(span: number, intervals: number): number {
  const raw = span / Math.max(1, intervals)
  const power = 10 ** Math.floor(Math.log10(raw))
  const fraction = raw / power
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
  return nice * power
}

function decimalsOf(step: number): number {
  const [coefficient, exponent] = step.toExponential(11).split('e')
  const fraction = (coefficient.split('.')[1] ?? '').replace(/0+$/, '')
  return Math.min(20, Math.max(0, fraction.length - Number(exponent)))
}

/**
 * An axis from `low` to `high` on round numbers, with at most `maxTicks`
 * ticks. `zero` keeps zero on the axis, which a bar or a filled area needs:
 * their length is the value, and an axis that starts elsewhere lies about it.
 */
export function niceScale(low: number, high: number, { zero = false, maxTicks = 5 } = {}): Scale {
  let min = zero ? Math.min(0, low) : low
  let max = zero ? Math.max(0, high) : high
  if (min === max) {
    // A flat line still needs an axis to sit on.
    const pad = Math.abs(min) * 0.1 || 1
    if (!(zero && min === 0)) min -= pad
    max += pad
  }
  for (let intervals = maxTicks - 1; intervals >= 1; intervals -= 1) {
    const step = niceStep(max - min, intervals)
    const decimals = decimalsOf(step)
    const lo = Math.floor(min / step + 1e-9) * step
    const hi = Math.ceil(max / step - 1e-9) * step
    const ticks: number[] = []
    for (let index = 0; index <= Math.round((hi - lo) / step); index++) {
      const value = lo + index * step
      ticks.push(Number(step < 1e-20 ? value.toPrecision(15) : value.toFixed(decimals)))
    }
    if (ticks.length <= maxTicks || intervals === 1) {
      return { min: ticks[0], max: ticks[ticks.length - 1], ticks, decimals }
    }
  }
  return { min, max, ticks: [min, max], decimals: 0 }
}

/**
 * A number as an axis or a readout shows it: grouped, and compact once it is
 * large. The compact letters are written here rather than asked of `Intl`,
 * whose answer depends on the locale data the engine shipped with: the same
 * call gave "1.3M" under Node and "1.3m" in Chrome.
 */
export function formatNumber(value: number, decimals = 0): string {
  const magnitude = Math.abs(value)
  // A small non-zero observation must not become a displayed zero when a
  // compact label asks for fewer decimal places than the source contains.
  if (magnitude > 0 && magnitude < 10 ** -decimals) return value.toPrecision(3).replace(/(\.\d*?)0+(e|$)/, '$1$2').replace(/\.(e|$)/, '$1')
  // One place, dropped when it is a zero: an axis reads "100M", a sentence "123.4M".
  const compact = (divisor: number, letter: string) => `${(value / divisor).toFixed(1).replace(/\.0$/, '')}${letter}`
  if (magnitude >= 1e12) return compact(1e12, 'T')
  if (magnitude >= 1e9) return compact(1e9, 'B')
  if (magnitude >= 1e6) return compact(1e6, 'M')
  if (magnitude >= 1e4) return compact(1e3, 'K')
  return value.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/**
 * Which x labels to show so they do not run into each other. The first and
 * the last are always shown; between them, every nth, where n is as small as
 * the room allows.
 */
export function labelIndices(labels: string[], width: number, charWidth = 6.4, gap = 14): number[] {
  const count = labels.length
  if (count <= 1) return count ? [0] : []
  const widest = Math.max(...labels.map((label) => label.length)) * charWidth + gap
  const fits = Math.max(2, Math.floor(width / widest))
  const every = Math.max(1, Math.ceil((count - 1) / (fits - 1)))
  const shown: number[] = []
  for (let index = 0; index < count; index += every) shown.push(index)
  const last = count - 1
  if (shown[shown.length - 1] !== last) {
    // The last label always shows; the one before it steps aside if they would touch.
    if (last - shown[shown.length - 1] < every / 2 && shown.length > 1) shown.pop()
    shown.push(last)
  }
  return shown
}

interface Point {
  index: number
  value: number
}

function defined(values: Array<number | null>): Point[] {
  return values.flatMap((value, index) => (value === null || !Number.isFinite(value) ? [] : [{ index, value }]))
}

/** A value with its unit: "18 °C" and "4.9 M", but "70%", which is never spaced, and "$4.2T". */
export function withUnit(text: string, unit = ''): string {
  if (!unit) return text
  if (unit === '%') return `${text}%`
  if (unit === 'US$') return text.startsWith('-') ? `-$${text.slice(1)}` : `$${text}`
  return `${text} ${unit}`
}

/** "in 2020", "on Tue", "at 15:00", by what the positions are. */
function at(label: string, xLabel = ''): string {
  const kind = xLabel.toLowerCase()
  if (/\b(day|date|weekday)\b/.test(kind)) return `on ${label}`
  if (/\b(hour|time)\b/.test(kind)) return `at ${label}`
  return `in ${label}`
}

/**
 * What a series does, in one sentence, from its values alone: where it started
 * and ended, and its peak or its low when that is somewhere in between and far
 * enough from either end to be worth saying.
 */
export function summarize(x: string[], values: Array<number | null>, unit = '', xLabel = ''): string {
  const points = defined(values)
  if (points.length < 2) return ''
  const say = (value: number) => withUnit(formatNumber(value, decimalsIn(points)), unit)
  const first = points[0]
  const last = points[points.length - 1]
  const peak = points.reduce((best, point) => (point.value > best.value ? point : best))
  const low = points.reduce((best, point) => (point.value < best.value ? point : best))
  const range = peak.value - low.value
  const inside = (point: Point) =>
    point.index !== first.index &&
    point.index !== last.index &&
    range > 0 &&
    Math.min(Math.abs(point.value - first.value), Math.abs(point.value - last.value)) >= range * 0.1

  // Flat only when it never moved; ending where it started is not the same thing.
  if (range === 0) return `Held at ${say(first.value)} from ${x[first.index]} to ${x[last.index]}.`
  const verb = last.value > first.value ? 'Rose' : last.value < first.value ? 'Fell' : null
  let sentence = verb
    ? `${verb} from ${say(first.value)} ${at(x[first.index], xLabel)} to ${say(last.value)} ${at(x[last.index], xLabel)}`
    : `From ${say(first.value)} ${at(x[first.index], xLabel)} back to ${say(last.value)} ${at(x[last.index], xLabel)}`
  const extras: string[] = []
  if (inside(peak)) extras.push(`a peak of ${say(peak.value)} ${at(x[peak.index], xLabel)}`)
  if (inside(low)) extras.push(`a low of ${say(low.value)} ${at(x[low.index], xLabel)}`)
  if (extras.length) sentence += `, with ${extras.join(' and ')}`
  return `${sentence}.`
}

export interface ChartSummaryInput {
  form: ChartForm
  x: string[]
  series: Array<{ label: string; values: Array<number | null> }>
  unit?: string
  xLabel?: string
}

/**
 * A chart in one sentence, said the way its form is read. A line or an area is
 * a movement from one end to the other. Columns and bars are compared, so the
 * highest and the lowest are what matter. A range is two movements at once, so
 * it gives the span of its highs and of its lows.
 */
export function summarizeChart({ form, x, series, unit = '', xLabel = '' }: ChartSummaryInput): string {
  const first = series[0]
  if (!first) return ''
  if (isAdvancedForm(form)) return `${form.replaceAll('-', ' ')}: ${x.length} displayed entries. Exact values, missing observations and transformation details are available in the table and expanded view.`
  if (form === 'scatter') return `${x.length} paired observations. Association does not establish causation.`
  if (form === 'histogram') return `${first.values.reduce<number>((total, value) => total + (value ?? 0), 0)} observations across ${x.length} bins.`
  if (form === 'heatmap') return `${series.length} rows by ${x.length} columns. Missing cells are shown as a dash, not zero.`
  if ((form === 'line' || form === 'area') && series.length > 1) return compareAtEnd(x, series, unit, xLabel)
  if (form === 'line' || form === 'area') return summarize(x, first.values, unit, xLabel)

  const extremes = (values: Array<number | null>) => {
    const points = defined(values)
    if (!points.length) return null
    const decimals = decimalsIn(points)
    const high = points.reduce((best, point) => (point.value > best.value ? point : best))
    const low = points.reduce((best, point) => (point.value < best.value ? point : best))
    const plain = (value: number) => formatNumber(value, decimals)
    const say = (value: number) => withUnit(plain(value), unit)
    return { high, low, plain, say }
  }

  if (form === 'range') {
    const [lows, highs] = series
    const low = extremes(lows?.values ?? [])
    const high = extremes(highs?.values ?? [])
    if (!low || !high) return ''
    // Each span in its own series' precision: highs to one place, say, and lows whole.
    const span = (range: NonNullable<typeof low>) =>
      range.low.value === range.high.value
        ? range.say(range.low.value)
        : `${range.plain(range.low.value)} to ${range.say(range.high.value)}`
    return `Highs from ${span(high)}, lows from ${span(low)}.`
  }

  const found = extremes(first.values)
  if (!found || found.high.index === found.low.index) return ''
  if (form === 'bar') {
    return `${x[found.high.index]} is highest at ${found.say(found.high.value)}, and ${x[found.low.index]} lowest at ${found.say(found.low.value)}.`
  }
  return `Highest ${at(x[found.high.index], xLabel)} at ${found.say(found.high.value)}, lowest ${at(x[found.low.index], xLabel)} at ${found.say(found.low.value)}.`
}

/**
 * Several lines, compared where they end: at the last position every line has
 * a value, which one is highest and which lowest. How each one moved is the
 * table's job beside it; the sentence says where they stand.
 */
function compareAtEnd(x: string[], series: ChartSummaryInput['series'], unit: string, xLabel: string): string {
  let end = -1
  for (let index = x.length - 1; index >= 0; index -= 1) {
    if (series.every((each) => each.values[index] !== null && each.values[index] !== undefined)) {
      end = index
      break
    }
  }
  if (end < 0) return ''
  const decimals = decimalsIn(series.flatMap((each) => defined(each.values)))
  const ranked = series
    .map((each) => ({ label: each.label, value: each.values[end] as number }))
    .sort((a, b) => b.value - a.value)
  const say = (value: number) => withUnit(formatNumber(value, decimals), unit)
  const high = ranked[0]
  const low = ranked[ranked.length - 1]
  const when = capitalFirst(at(x[end], xLabel))
  if (high.value === low.value) return `${when}, ${joinLabels(ranked.map((each) => each.label))} were level at ${say(high.value)}.`
  if (ranked.length === 2) return `${when}, ${high.label} was at ${say(high.value)} and ${low.label} at ${say(low.value)}.`
  return `${when}, ${high.label} was highest, at ${say(high.value)}, and ${low.label} lowest, at ${say(low.value)}.`
}

function capitalFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function joinLabels(labels: string[]): string {
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/** As many decimals as the values themselves carry, up to two. */
function decimalsIn(points: Point[]): number {
  let decimals = 0
  for (const { value } of points) {
    const [, fraction = ''] = String(value).split('.')
    decimals = Math.max(decimals, Math.min(2, fraction.length))
  }
  return decimals
}

/**
 * The indices to keep when a series is too long to send whole.
 *
 * Largest-Triangle-Three-Buckets keeps the points that shape the line, and the
 * peak and the low are then put back if the buckets passed over them: a
 * thinned chart may lose detail, but never its highest or lowest point.
 */
export function thin(values: Array<number | null>, limit: number): number[] {
  const count = values.length
  if (limit >= count || limit < 3) return Array.from({ length: count }, (_, index) => index)
  const value = (index: number) => values[index] ?? 0
  const kept = [0]
  const bucket = (count - 2) / (limit - 2)
  let previous = 0
  for (let slot = 0; slot < limit - 2; slot += 1) {
    const from = Math.floor(slot * bucket) + 1
    const to = Math.min(Math.floor((slot + 1) * bucket) + 1, count - 1)
    const nextFrom = to
    const nextTo = Math.min(Math.floor((slot + 2) * bucket) + 1, count)
    let averageX = 0
    let averageY = 0
    const span = Math.max(1, nextTo - nextFrom)
    for (let index = nextFrom; index < nextTo; index += 1) {
      averageX += index
      averageY += value(index)
    }
    averageX /= span
    averageY /= span
    let best = from
    let bestArea = -1
    for (let index = from; index < to; index += 1) {
      const area = Math.abs(
        (previous - averageX) * (value(index) - value(previous)) - (previous - index) * (averageY - value(previous)),
      )
      if (area > bestArea) {
        bestArea = area
        best = index
      }
    }
    kept.push(best)
    previous = best
  }
  kept.push(count - 1)

  const points = defined(values)
  if (points.length) {
    for (const extreme of [
      points.reduce((best, point) => (point.value > best.value ? point : best)),
      points.reduce((best, point) => (point.value < best.value ? point : best)),
    ]) {
      if (kept.includes(extreme.index)) continue
      // Replace the kept point nearest to it, never the first or the last.
      let nearest = 1
      for (let slot = 1; slot < kept.length - 1; slot += 1) {
        if (Math.abs(kept[slot] - extreme.index) < Math.abs(kept[nearest] - extreme.index)) nearest = slot
      }
      kept[nearest] = extreme.index
    }
  }
  return [...new Set(kept)].sort((a, b) => a - b)
}
