import type { Block, ChartBlock, ChartForm } from './schema'
import type { CapturedTable } from './table-mediation'
import { sourceNumber, datasetVersion, type NumberFormat } from './data-values'
import { dayTime, validAdvancedChart } from './advanced-validation'
import type { ChartEvidence } from './advanced-types'
import type { VisualizationReason } from './visualization-skills'

export const ADVANCED_SKILLS = ['statistic', 'dot-ranking', 'grouped', 'multi-trend', 'area', 'uncertainty', 'before-after', 'slope', 'composition', 'composition-percent', 'share', 'waffle', 'boxplot', 'bubble', 'calendar', 'scaled-timeline', 'duration', 'geographic', 'hierarchy', 'flow', 'funnel', 'contribution', 'target', 'small-multiples', 'rich-table', 'editorial'] as const
export type AdvancedSkill = typeof ADVANCED_SKILLS[number]
export interface CompiledVisual { blocks: Block[]; numericColumns: number[]; numericValues: Record<number, Array<number | null>>; evidence: ChartEvidence }
class Refusal extends Error { constructor(public reason: VisualizationReason) { super(reason) } }
const reject = (reason: VisualizationReason): never => { throw new Refusal(reason) }

export function compileAdvanced(table: CapturedTable, args: Record<string, unknown>): { visual?: CompiledVisual; reason: VisualizationReason } {
  try { return { visual: compile(table, args), reason: 'ready' } } catch (error) { if (error instanceof Refusal) return { reason: error.reason }; throw error }
}

function compile(table: CapturedTable, args: Record<string, unknown>): CompiledVisual {
  const skill = args.skill as AdvancedSkill
  const selected = new Set<number>()
  const transforms: string[] = []
  const col = (name: string): number => {
    const index = args[name]
    if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= table.headers.length) return reject('invalid_selection')
    selected.add(Number(index)); return Number(index)
  }
  const label = col('label_column')
  const value = col('value_column')
  if (label === value) return reject('invalid_selection')
  const format = (args.number_format ?? 'plain') as NumberFormat
  if (!['plain', 'en-US', 'de-DE', 'fr-FR'].includes(format)) return reject('invalid_selection')
  if (format !== 'plain') transforms.push(`Parsed numbers using explicitly selected ${format} format.`)
  const parsed = new Map<number, { values: Array<number | null>; unit: string }>()
  const numeric = (index: number, complete = false) => {
    selected.add(index)
    if (index < 0 || index >= table.headers.length) return reject('invalid_selection')
    if (!parsed.has(index)) {
      const cells = table.rows.map((row) => sourceNumber(row.cells[index], table.headers[index], format))
      if (cells.some((cell) => !cell)) return reject('not_numeric')
      const units = new Set(cells.filter((cell) => cell!.value !== null).map((cell) => cell!.unit))
      if (units.size > 1) return reject('mixed_units')
      cells.forEach((cell) => { if (cell!.transform && !transforms.includes(cell!.transform)) transforms.push(cell!.transform) })
      parsed.set(index, { values: cells.map((cell) => cell!.value), unit: [...units][0] ?? '' })
    }
    const result = parsed.get(index)!
    if (complete && result.values.some((v) => v === null)) return reject('insufficient_data')
    return result
  }
  const distinct = (...indexes: number[]) => { if (new Set(indexes).size !== indexes.length) reject('invalid_selection') }
  const values = () => numeric(value)
  const labels = table.rows.map((row) => row.cells[label])
  if (!labels.length || labels.some((text) => !text || text.length > 120)) return reject('invalid_selection')
  const seriesFor = (indexes: number[], complete = false) => {
    distinct(label, ...indexes)
    const columns = indexes.map((index) => numeric(index, complete))
    if (new Set(columns.map((column) => column.unit)).size !== 1) return reject('mixed_units')
    return indexes.map((index, i) => ({ key: `c${index}`, label: table.headers[index], values: columns[i].values }))
  }
  const many = () => {
    const indexes = args.value_columns
    if (!Array.isArray(indexes) || indexes.length < 2 || indexes.length > 5 || !indexes.every((i) => Number.isInteger(i) && i >= 0 && i < table.headers.length) || !indexes.includes(value)) return reject('invalid_selection')
    indexes.forEach((i) => selected.add(i)); return indexes as number[]
  }
  const constant = (name: string) => {
    const index = col(name)
    const strings = table.rows.map((row) => row.cells[index])
    if (!strings[0] || new Set(strings).size !== 1) return reject('unsupported_context')
    return strings[0]
  }
  const dates = (index: number, years = true) => table.rows.map((row) => {
    const raw = row.cells[index]
    const date = years && /^(?:1\d{3}|2\d{3})$/.test(raw) ? Number(raw) : dayTime(raw)
    if (date === null) return reject('invalid_dates')
    return date
  })
  const chart: ChartBlock = { type: 'chart', id: 'chart', slot: 'data', title: table.headers[value], form: 'dot', xLabel: table.headers[label], x: labels, series: [], analysis: {} }
  const a = chart.analysis!
  const blocks: Block[] = []
  const setOne = (form: ChartForm) => { chart.form = form; chart.series = [{ key: `c${value}`, label: table.headers[value], values: values().values }]; chart.unit = values().unit }
  const setMany = (form: ChartForm, indexes: number[], complete = false) => { chart.form = form; chart.series = seriesFor(indexes, complete); chart.unit = numeric(indexes[0]).unit }
  const timeOrder = () => {
    if (new Set(labels.map((l) => l.length)).size !== 1) return reject('invalid_dates')
    const times = dates(label)
    if (new Set(times).size !== times.length) return reject('duplicate_labels')
    const order = times.map((_, i) => i).sort((i, j) => times[i] - times[j])
    chart.x = order.map((i) => labels[i]); chart.positions = order.map((i) => times[i])
    chart.series = chart.series.map((s) => ({ ...s, values: order.map((i) => s.values[i]) }))
    if (a.annotations) a.annotations = order.map((i) => a.annotations![i])
    transforms.push('Sorted by source date, retaining actual time spacing and null observations.')
  }

  if (skill === 'statistic') {
    const row = table.rows.length === 1 ? 0 : args.row_index
    if (!Number.isInteger(row) || Number(row) < 0 || Number(row) >= labels.length) return reject('invalid_selection')
    const point = values().values[Number(row)]
    if (point === null) return reject('insufficient_data')
    const stat: Extract<Block, { type: 'stat' }> = { id: 'stat', slot: 'figure', type: 'stat', label: labels[Number(row)], value: `${point}${values().unit ? ` ${values().unit}` : ''}` }
    if (args.baseline_column !== undefined) {
      const baseColumn = col('baseline_column'); distinct(label, value, baseColumn)
      const baseline = numeric(baseColumn)
      if (baseline.unit !== values().unit) return reject('mixed_units')
      const base = baseline.values[Number(row)]
      if (base === null) return reject('insufficient_data')
      const delta = point - base
      stat.change = { value: `${delta > 0 ? '+' : ''}${Number(delta.toPrecision(12))}${values().unit === '%' ? ' points' : values().unit ? ` ${values().unit}` : ''}`, direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat', period: `against ${table.headers[baseColumn]}`, formula: `${point} − ${base}` }
      transforms.push(`Absolute change against source column ${baseColumn}; percentages use percentage points.`)
    }
    transforms.push(`Selected source row ${table.rows[Number(row)].id}; the complete captured table is retained.`)
    blocks.push(stat)
  } else if (skill === 'rich-table') {
    const indexes = args.value_columns === undefined ? [value] : many()
    indexes.forEach((index) => numeric(index))
    transforms.push('Inline bars use a shared zero-based scale within each numeric column; exact cells remain unchanged.')
  } else if (skill === 'grouped' || skill === 'multi-trend' || skill === 'small-multiples') {
    setMany(skill === 'grouped' ? 'column' : skill === 'multi-trend' ? 'line' : 'small-multiples', many())
    if (skill === 'grouped' && (chart.series.length > 3 || labels.length > 24)) return reject('too_many_rows')
    if (skill !== 'grouped') timeOrder()
  } else if (skill === 'area') { setOne('area'); timeOrder() }
  else if (skill === 'dot-ranking') {
    setOne('dot')
    const order = labels.map((_, i) => i).sort((i, j) => (values().values[j] ?? -Infinity) - (values().values[i] ?? -Infinity))
    chart.x = order.map((i) => labels[i]); chart.series[0].values = order.map((i) => values().values[i])
    transforms.push('Ranked descending; missing observations remain missing.')
  } else if (skill === 'before-after' || skill === 'slope' || skill === 'target') {
    setMany(skill === 'target' ? 'bullet' : skill === 'slope' ? 'slope' : 'dumbbell', [value, col(skill === 'target' ? 'target_column' : 'after_column')], true)
  } else if (skill === 'uncertainty') {
    setMany('band', [col('lower_column'), value, col('upper_column')])
    if (typeof args.bounds_label !== 'string' || !args.bounds_label.trim() || args.bounds_label.length > 200) return reject('invalid_selection')
    a.meaning = args.bounds_label; timeOrder()
  } else if (skill === 'composition' || skill === 'composition-percent') {
    const indexes = many(); const totalColumn = col('total_column'); distinct(label, ...indexes, totalColumn)
    setMany(skill === 'composition' ? 'stacked' : 'stacked-percent', indexes, true)
    const total = numeric(totalColumn, true)
    if (total.unit !== chart.unit) return reject('mixed_units')
    a.totals = total.values as number[]; a.denominator = table.headers[totalColumn]
    if (args.parts_exclusive !== true) return reject('unsupported_context')
    transforms.push('Validated mutually exclusive parts against each sourced total; no remainder is hidden.')
    if (skill === 'composition-percent') transforms.push('Display share = part ÷ sourced total × 100; table retains absolute values.')
  } else if (skill === 'share' || skill === 'waffle') {
    setOne(skill === 'share' ? 'donut' : 'waffle')
    const totalColumn = col('total_column'); distinct(label, value, totalColumn)
    const total = numeric(totalColumn, true)
    if (total.unit !== chart.unit) return reject('mixed_units')
    if (new Set(total.values).size !== 1 || args.parts_exclusive !== true) return reject('unsupported_context')
    a.totals = [total.values[0]!]; a.denominator = table.headers[totalColumn]
    transforms.push('Verified all mutually exclusive parts reconcile to the sourced whole.')
    if (skill === 'waffle') transforms.push('100 cells allocated by largest remainder; displayed cells approximate percentage shares. Exact values remain in the table.')
  } else if (skill === 'boxplot') {
    const numbers = numeric(value, true)
    if (/\b(mean|average|median|quantile|percentile|total|frequency)\b/i.test(table.headers[value])) return reject('unsupported_context')
    const groups = [...new Set(labels)]
    const samples = groups.map((group) => table.rows.flatMap((_, i) => labels[i] === group ? [numbers.values[i]!] : []).sort((a, b) => a - b))
    if (samples.some((sample) => sample.length < 3)) return reject('insufficient_data')
    const quantile = (sample: number[], q: number) => { const p = (sample.length - 1) * q; const lo = Math.floor(p); return sample[lo] + (sample[Math.ceil(p)] - sample[lo]) * (p - lo) }
    const stats = samples.map((s) => { const q1 = quantile(s, 0.25), median = quantile(s, 0.5), q3 = quantile(s, 0.75), iqr = q3 - q1; const inside = s.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr); return [inside[0], q1, median, q3, inside.at(-1)!] })
    chart.form = 'box'; chart.x = groups; chart.unit = numbers.unit
    chart.series = ['Lower whisker', 'Q1', 'Median', 'Q3', 'Upper whisker'].map((name, i) => ({ key: `q${i}`, label: name, values: stats.map((s) => s[i]) }))
    a.sampleSizes = samples.map((s) => s.length); a.outliers = samples.map((s, i) => s.filter((v) => v < stats[i][0] || v > stats[i][4])); a.meaning = 'R-7 linearly interpolated quartiles; whiskers are observations within 1.5 × IQR. Remaining observations are shown as outliers.'
    transforms.push(a.meaning)
  } else if (skill === 'bubble') {
    const size = col('size_column'); distinct(label, value, size)
    const horizontal = numeric(label, true), vertical = numeric(value, true), sizes = numeric(size, true)
    chart.form = 'bubble'; chart.positions = horizontal.values as number[]; chart.unit = vertical.unit; chart.xUnit = horizontal.unit
    chart.series = [{ key: 'y', label: table.headers[value], values: vertical.values }, { key: 'size', label: table.headers[size], values: sizes.values }]; a.units = [vertical.unit, sizes.unit]
    transforms.push('Bubble area, not radius, is proportional to the size measure; paired rows are preserved.')
  } else if (skill === 'calendar') {
    setOne('calendar'); const times = dates(label, false)
    if (new Set(times).size !== times.length) return reject('duplicate_labels')
    const lo = Math.min(...times), hi = Math.max(...times)
    if (hi - lo > 365 * 86400000) return reject('too_many_rows')
    const byTime = new Map(times.map((time, i) => [time, values().values[i]]))
    chart.positions = Array.from({ length: Math.round((hi - lo) / 86400000) + 1 }, (_, i) => lo + i * 86400000)
    chart.x = chart.positions.map((time) => new Date(time).toISOString().slice(0, 10))
    chart.series[0].values = chart.positions.map((time) => byTime.get(time) ?? null)
    a.timezone = args.timezone_column !== undefined ? constant('timezone_column') : 'Calendar dates as published; timezone not supplied'
    transforms.push('Missing dates in the observed span remain unavailable, never zero.')
  } else if (skill === 'scaled-timeline') {
    chart.form = 'event-timeline'; chart.positions = dates(label); chart.series = [{ key: 'event', label: 'Event', values: labels.map(() => 1) }]; a.annotations = table.rows.map((row) => row.cells[value])
    if (new Set(labels.map((l) => l.length)).size !== 1) return reject('invalid_dates')
    transforms.push('Event markers use actual source-date spacing; marker height carries no quantitative meaning.')
  } else if (skill === 'duration') {
    const endColumn = col('end_column'); distinct(label, value, endColumn)
    const starts = dates(value, false)
    const ends = table.rows.map((row) => /^(?:|—|ongoing|open)$/i.test(row.cells[endColumn]) ? null : dayTime(row.cells[endColumn]) ?? reject('invalid_dates'))
    chart.form = 'gantt'; chart.series = [{ key: 'start', label: table.headers[value], values: starts }, { key: 'end', label: table.headers[endColumn], values: ends }]
    if (ends.includes(null)) { a.period = constant('as_of_column'); if (dayTime(a.period) === null) return reject('invalid_dates') }
    transforms.push('Dates interpreted as published calendar dates. Dashed open intervals stop at the sourced as-of date, not a fabricated end date.')
  } else if (skill === 'geographic') {
    const latColumn = col('latitude_column'), lonColumn = col('longitude_column'); distinct(label, value, latColumn, lonColumn)
    const v = numeric(value, true), lat = numeric(latColumn, true), lon = numeric(lonColumn, true)
    chart.form = 'geo-symbol'; chart.unit = v.unit; chart.series = [{ key: 'value', label: table.headers[value], values: v.values }, { key: 'latitude', label: 'Latitude', values: lat.values }, { key: 'longitude', label: 'Longitude', values: lon.values }]
    a.meaning = 'Equirectangular coordinate map using published latitude/longitude; symbol area represents the measure. No political boundaries are inferred.'
    transforms.push(a.meaning)
  } else if (skill === 'hierarchy') {
    setOne('treemap'); const idColumn = col('id_column'), parentColumn = col('parent_column'); distinct(idColumn, parentColumn, value)
    a.ids = table.rows.map((row) => row.cells[idColumn]); a.parents = table.rows.map((row) => /^(?:|—|null)$/i.test(row.cells[parentColumn]) ? '' : row.cells[parentColumn])
    transforms.push('Verified acyclic parent/child identities and additive parent totals. Nested area represents sourced values.')
  } else if (skill === 'flow' || skill === 'funnel') {
    setOne(skill === 'flow' ? 'sankey' : 'funnel'); a.cohort = constant('cohort_column'); a.period = constant('period_column')
    if (skill === 'flow') { const target = col('to_column'); distinct(label, value, target); a.targets = table.rows.map((row) => row.cells[target]); transforms.push('Verified a directed acyclic flow; intermediate inflows equal outflows.') }
    else transforms.push('Source stage order is retained; counts must be nonincreasing for the same cohort and period.')
  } else if (skill === 'contribution') { setOne('waterfall'); transforms.push('First and last rows are sourced totals; signed middle components must reconcile exactly within numerical tolerance.') }
  else if (skill === 'editorial') {
    setOne('editorial'); const annotation = col('annotation_column'); distinct(label, value, annotation)
    a.annotations = table.rows.map((row) => row.cells[annotation]); timeOrder(); transforms.push('Annotations copied from source cells. Navigation highlights the same row in the linked numeric view without changing the dataset.')
  } else return reject('invalid_selection')

  // Unselected context fields still guard against mixing different bases/cohorts.
  for (let i = 0; i < table.headers.length; i++) if (!selected.has(i) && /\b(currency|unit|cohort|basis|period|year|date)\b/i.test(table.headers[i]) && new Set(table.rows.map((row) => row.cells[i])).size > 1) return reject('unsupported_context')
  if (chart.series.length) {
    if (['line', 'area', 'column'].includes(chart.form)) {
      if (chart.series.some((s) => !s.values.some((v) => v !== null)) || new Set(chart.x).size !== chart.x.length || chart.x.length < 2) return reject('insufficient_data')
      if (chart.x.some(label => label.length > 40)) return reject('invalid_selection')
    } else if (!validAdvancedChart(chart)) return reject('unsupported_context')
    blocks.push(chart)
  }
  const evidence: ChartEvidence = { datasetId: table.id, version: datasetVersion([table.headers, table.rows]), fetchedAt: table.source.fetchedAt, sourceUrl: table.source.url, columns: [...selected], rows: table.rows.map(({ id, line }) => ({ id, line })), transforms: transforms.length ? transforms : ['Source values copied without aggregation.'] }
  chart.evidence = evidence
  if (a.meaning) chart.summary = a.meaning
  return { blocks, numericColumns: [...parsed.keys()], numericValues: Object.fromEntries([...parsed].map(([column, data]) => [column, data.values])), evidence }
}
