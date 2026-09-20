import { isAdvancedForm, type AnalysisContext, type ChartEvidence } from './advanced-types'
import type { ChartBlock, ChartSeries } from './schema'

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const words = (value: unknown, limit = 300): value is string => typeof value === 'string' && value.length <= limit
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
export const closeNumber = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-9
export const dayTime = (text: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const time = Date.parse(`${text}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? time : null
}

export function readEvidence(value: unknown): ChartEvidence | undefined {
  if (!object(value) || !words(value.datasetId, 100) || !words(value.version, 100) || !words(value.fetchedAt, 40) || !words(value.sourceUrl, 2000)) return undefined
  try { if (!['http:', 'https:'].includes(new URL(value.sourceUrl).protocol)) return undefined } catch { return undefined }
  if (!Array.isArray(value.columns) || value.columns.length > 16 || !value.columns.every((column) => Number.isInteger(column) && column >= 0 && column < 16)) return undefined
  if (!Array.isArray(value.rows) || value.rows.length > 400 || !value.rows.every((row) => object(row) && words(row.id, 100) && Number.isInteger(row.line) && Number(row.line) > 0)) return undefined
  if (!Array.isArray(value.transforms) || value.transforms.length > 16 || !value.transforms.every((line) => words(line, 500))) return undefined
  return { datasetId: value.datasetId, version: value.version, fetchedAt: value.fetchedAt, sourceUrl: value.sourceUrl, columns: [...value.columns], rows: value.rows.map((row) => ({ id: row.id, line: row.line })), transforms: [...value.transforms] }
}

function readAnalysis(value: unknown): AnalysisContext | null {
  if (value === undefined) return {}
  if (!object(value)) return null
  const result: AnalysisContext = {}
  for (const key of ['meaning', 'denominator', 'timezone', 'period', 'cohort'] as const) {
    if (value[key] !== undefined) { if (!words(value[key])) return null; result[key] = value[key] }
  }
  for (const key of ['ids', 'parents', 'targets', 'annotations', 'units'] as const) {
    const list = value[key]
    if (list !== undefined) { if (!Array.isArray(list) || list.length > 400 || !list.every((item) => words(item, key === 'annotations' ? 1000 : 120))) return null; result[key] = [...list] }
  }
  for (const key of ['totals', 'sampleSizes'] as const) {
    const list = value[key]
    if (list !== undefined) { if (!Array.isArray(list) || list.length > 400 || !list.every(finite)) return null; result[key] = [...list] }
  }
  if (value.outliers !== undefined) {
    if (!Array.isArray(value.outliers) || value.outliers.length > 24 || !value.outliers.every((items) => Array.isArray(items) && items.every(finite)) || value.outliers.flat().length > 400) return null
    result.outliers = value.outliers.map((items) => [...items])
  }
  return result
}

/** One graph contract, used both by deterministic mediation and the wire reader. */
export function validAdvancedChart(chart: ChartBlock): boolean {
  if (!isAdvancedForm(chart.form)) return false
  const { form, x, series, positions, analysis: a = {} } = chart
  const n = x.length
  const complete = series.every((s) => s.values.every((v) => v !== null))
  const nonnegative = series.every((s) => s.values.every((v) => v !== null && v >= 0))
  const unique = new Set(x).size === n
  const orderedTime = Boolean(positions && positions.length === n && positions.every((v, i) => i === 0 || v > positions[i - 1]))
  const exact = (count: number) => series.length === count
  if (!n || !series.length || series.length > 5 || n > 400 || !series.some((s) => s.values.some((v) => v !== null))) return false
  if (series.some((s) => s.values.length !== n || s.values.some((v) => v !== null && !finite(v)))) return false
  if (form === 'dot') return exact(1) && unique && n <= 24
  if (form === 'slope' || form === 'dumbbell') return exact(2) && unique && n <= 15 && complete
  if (form === 'bullet') return exact(2) && unique && n <= 24 && complete
  if (form === 'band') return exact(3) && unique && orderedTime && Boolean(a.meaning) && x.every((_, i) => series.every((s) => s.values[i] === null) || (series.every((s) => s.values[i] !== null) && series[0].values[i]! <= series[1].values[i]! && series[1].values[i]! <= series[2].values[i]!))
  if (form === 'stacked' || form === 'stacked-percent') return series.length >= 2 && unique && n <= 24 && nonnegative && Boolean(a.denominator) && a.totals?.length === n && x.every((_, i) => closeNumber(series.reduce((sum, s) => sum + s.values[i]!, 0), a.totals![i]) && (form !== 'stacked-percent' || a.totals![i] > 0))
  if (form === 'donut' || form === 'waffle') return exact(1) && unique && n <= 12 && nonnegative && Boolean(a.denominator) && a.totals?.length === 1 && a.totals[0] > 0 && closeNumber(series[0].values.reduce<number>((sum, v) => sum + v!, 0), a.totals[0])
  if (form === 'box') return exact(5) && unique && n <= 12 && complete && Boolean(a.meaning) && a.sampleSizes?.length === n && a.sampleSizes.every((v) => Number.isInteger(v) && v >= 3) && a.outliers?.length === n && x.every((_, i) => series.every((s, j) => j === 0 || s.values[i]! >= series[j - 1].values[i]!))
  if (form === 'bubble') return exact(2) && n <= 100 && complete && positions?.length === n && series[1].values.every((v) => v! >= 0) && Boolean(a.units?.length === 2)
  if (form === 'calendar') {
    const times = x.map(dayTime)
    return exact(1) && unique && n <= 366 && times.every((time) => time !== null) && Math.max(...times as number[]) - Math.min(...times as number[]) <= 365 * 86400000 && Boolean(a.timezone)
  }
  if (form === 'event-timeline') return exact(1) && n <= 40 && Boolean(positions?.length === n) && a.annotations?.length === n && a.annotations.every(Boolean)
  if (form === 'editorial') return exact(1) && n <= 50 && orderedTime && a.annotations?.length === n && a.annotations.some(Boolean)
  if (form === 'gantt') {
    const cutoff = a.period ? dayTime(a.period) : null
    return exact(2) && unique && n <= 40 && series[0].values.every((start, i) => start !== null && start >= -30610224000000 && start <= 32503680000000 && (series[1].values[i] === null ? cutoff !== null && cutoff >= start : series[1].values[i]! >= start && series[1].values[i]! <= 32503680000000))
  }
  if (form === 'geo-symbol') return exact(3) && unique && n <= 100 && complete && series[0].values.every((v) => v! >= 0) && series[1].values.every((v) => Math.abs(v!) <= 90) && series[2].values.every((v) => Math.abs(v!) <= 180) && Boolean(a.meaning)
  if (form === 'treemap') {
    if (!exact(1) || n > 50 || !nonnegative || a.ids?.length !== n || a.parents?.length !== n || new Set(a.ids).size !== n || !a.ids.every(Boolean)) return false
    const lookup = new Map(a.ids.map((id, i) => [id, i]))
    for (let i = 0; i < n; i++) {
      const seen = new Set<string>([a.ids[i]])
      let parent = a.parents[i]
      while (parent) { if (seen.has(parent) || !lookup.has(parent)) return false; seen.add(parent); parent = a.parents[lookup.get(parent)!] }
      const children = a.parents.flatMap((p, j) => p === a.ids![i] ? [j] : [])
      if (children.length && !closeNumber(children.reduce((sum, j) => sum + series[0].values[j]!, 0), series[0].values[i]!)) return false
    }
    return a.parents.some((parent, i) => !parent && series[0].values[i]! > 0)
  }
  if (form === 'funnel') return exact(1) && unique && n >= 2 && n <= 16 && nonnegative && Boolean(a.cohort && a.period) && series[0].values.every((v, i) => i === 0 || v! <= series[0].values[i - 1]!)
  if (form === 'sankey') {
    if (!exact(1) || n > 50 || !nonnegative || a.targets?.length !== n || !a.targets.every(Boolean) || !a.cohort || !a.period) return false
    if (!series[0].values.some((v) => v! > 0)) return false
    if (new Set(x.map((from, i) => JSON.stringify([from, a.targets![i]]))).size !== n) return false
    const nodes = [...new Set([...x, ...a.targets])]
    if (nodes.length > 24) return false
    const pending = new Set(nodes)
    for (let pass = 0; pass < nodes.length; pass++) for (const node of pending) if (!a.targets.some((target, i) => target === node && pending.has(x[i]))) pending.delete(node)
    if (pending.size) return false
    return nodes.every((node) => {
      const incoming = a.targets!.flatMap((target, i) => target === node ? [series[0].values[i]!] : [])
      const outgoing = x.flatMap((from, i) => from === node ? [series[0].values[i]!] : [])
      return !incoming.length || !outgoing.length || closeNumber(incoming.reduce((a, b) => a + b, 0), outgoing.reduce((a, b) => a + b, 0))
    })
  }
  if (form === 'waterfall') return exact(1) && unique && n >= 3 && n <= 24 && complete && closeNumber(series[0].values.slice(0, -1).reduce<number>((sum, value) => sum + value!, 0), series[0].values[n - 1]!)
  if (form === 'small-multiples') return series.length >= 2 && unique && orderedTime
  return false
}

export function readAdvancedChart(input: Record<string, unknown>): ChartBlock | null {
  if (!isAdvancedForm(input.form) || !Array.isArray(input.x) || !input.x.length || input.x.length > 400 || !input.x.every((x) => words(x, 120) && x.length)) return null
  if (!words(input.title, 200) || !Array.isArray(input.series) || input.series.length > 5) return null
  const series: ChartSeries[] = []
  for (const s of input.series) {
    if (!object(s) || !words(s.key, 60) || !words(s.label, 120) || !Array.isArray(s.values) || s.values.length !== input.x.length || !s.values.every((v) => v === null || finite(v))) return null
    series.push({ key: s.key, label: s.label, values: [...s.values] })
  }
  if (new Set(series.map((s) => s.key)).size !== series.length) return null
  const analysis = readAnalysis(input.analysis)
  if (!analysis) return null
  if (input.positions !== undefined && (!Array.isArray(input.positions) || input.positions.length !== input.x.length || !input.positions.every(finite))) return null
  const chart: ChartBlock = { id: '', slot: 'data', type: 'chart', form: input.form, title: input.title, x: [...input.x], series, analysis }
  if (Array.isArray(input.positions)) chart.positions = [...input.positions]
  for (const key of ['unit', 'xUnit', 'xLabel', 'yLabel', 'asOf', 'summary'] as const) if (words(input[key], key === 'summary' ? 1000 : 120)) chart[key] = input[key]
  const evidence = readEvidence(input.evidence)
  if (evidence) chart.evidence = evidence
  return validAdvancedChart(chart) ? chart : null
}
