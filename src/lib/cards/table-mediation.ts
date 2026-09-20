import type { SourceRef } from './materials'
import type { VisualizationSkill, VisualizationTrace, VisualizationReason } from './visualization-skills'
import { VISUALIZATION_IDS } from './visualization-skills'
import { ADVANCED_SKILLS, compileAdvanced, type CompiledVisual } from './advanced-mediation'
import { structuredRows } from './structured-table'
import { datasetVersion } from './data-values'

export const TABLE_LIMITS = { bytes: 100_000, tables: 4, rows: 400, columns: 16, cell: 1000 } as const

export interface CapturedTable {
  id: string
  headers: string[]
  rows: Array<{ id: string; line: number; cells: string[] }>
  source: SourceRef
}

export interface TableMaterial {
  compiled?: CompiledVisual
  id: string
  kind: 'table'
  source: SourceRef
  table: CapturedTable
  view: { skill: VisualizationSkill; labelColumn: number; valueColumn: number; groupColumn?: number; upperColumn?: number; upperValues?: Array<number | null>; boundsLabel?: string; values?: Array<number | null>; positions?: number[]; unit?: string; xUnit?: string }
  reason: VisualizationReason
}

/** Bounded Markdown and flat CSV/TSV/JSON exports. No OCR guesses or model-written rows. */
export function captureTables(text: string, source: SourceRef, prefix: string): CapturedTable[] {
  if (new TextEncoder().encode(text).byteLength > TABLE_LIMITS.bytes) return []
  try { if (!['http:', 'https:'].includes(new URL(source.url).protocol)) return [] } catch { return [] }
  const lines = text.split(/\r?\n/)
  const found: CapturedTable[] = []
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
  for (let i = 0; i < lines.length - 1 && found.length < TABLE_LIMITS.tables; i++) {
    if (!lines[i].includes('|') || !lines[i + 1].includes('|')) continue
    const headers = cells(lines[i])
    const separators = cells(lines[i + 1])
    if (separators.length !== headers.length || !separators.every((value) => /^:?-{3,}:?$/.test(value))) continue
    const rows: CapturedTable['rows'] = []
    let valid = headers.length >= 2 && headers.length <= TABLE_LIMITS.columns && headers.every((h) => h.length > 0 && h.length <= 60) && new Set(headers).size === headers.length
    i += 2
    for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
      const row = cells(lines[i])
      if (row.length !== headers.length || row.some((value) => value.length > TABLE_LIMITS.cell || /\\\||<[^>]+>/.test(value))) valid = false
      rows.push({ id: `r${i + 1}`, line: i + 1, cells: row })
    }
    i--
    if (valid && rows.length > 0 && rows.length <= TABLE_LIMITS.rows) found.push({ id: `${prefix}-${found.length + 1}`, headers, rows, source })
  }
  if (found.length) return found
  const structured = structuredRows(text)
  if (!structured) return []
  const [head, ...body] = structured
  if (head.cells.length < 2 || head.cells.length > TABLE_LIMITS.columns || new Set(head.cells).size !== head.cells.length || head.cells.some(h => !h || h.length > 60) || body.length > TABLE_LIMITS.rows || body.some(r => r.cells.length !== head.cells.length || r.cells.some(c => c.length > TABLE_LIMITS.cell))) return []
  const json = text.trim().startsWith('[')
  return [{ id: `${prefix}-1`, headers: head.cells, rows: body.map((r, i) => ({ id: json ? `record-${i + 1}` : `r${r.line}`, line: r.line, cells: r.cells })), source }]
}

/** Years and full ISO dates only; don't let Date.parse repair impossible dates. */
export function datePosition(value: string): number | null {
  if (/^(?:1[0-9]{3}|2[0-9]{3})$/.test(value)) return Number(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null
}

function numberCell(raw: string): { value: number | null; unit: string } | null {
  if (/^(?:|—|–|-|N\/A|null|not available)$/i.test(raw)) return { value: null, unit: '' }
  // Commas, scale words, footnotes and locale guesses deliberately stay in the table.
  const match = raw.replace(/−/g, '-').match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(%|USD|EUR|GBP|PKR|ms|km|kg|°C|°F)?$/)
  if (!match || !Number.isFinite(Number(match[1]))) return null
  if (Math.abs(Number(match[1])) > Number.MAX_SAFE_INTEGER) return null
  return { value: Number(match[1]), unit: match[2] ?? '' }
}

export function mediateTable(table: CapturedTable | undefined, args: Record<string, unknown>): { material?: TableMaterial; trace: VisualizationTrace; message: string } {
  const skill = VISUALIZATION_IDS.find((id) => id === args.skill)
  if (!table) return { trace: { stage: 'selection', outcome: 'unavailable', reason: 'no_table', rows: 0, ...(skill ? { skill } : {}) }, message: 'No captured table has that ID. Use an ID returned by read; do not supply values.' }
  const labelColumn = Number.isInteger(args.label_column) ? args.label_column as number : -1
  const valueColumn = Number.isInteger(args.value_column) ? args.value_column as number : -1
  const material: TableMaterial = { id: `visual-${table.id}-${datasetVersion(Object.entries(args).filter(([key]) => key !== 'replace_existing').sort(([a], [b]) => a.localeCompare(b)))}`, kind: 'table', source: table.source, table, view: { skill: 'table', labelColumn: 0, valueColumn: 1 }, reason: 'ready' }
  const finish = (reason: VisualizationReason) => {
    material.reason = reason
    if (reason !== 'ready') material.view = { skill: 'table', labelColumn: Math.max(0, Math.min(table.headers.length - 1, labelColumn)), valueColumn: Math.max(0, Math.min(table.headers.length - 1, valueColumn)) }
    const outcome = reason === 'ready' ? 'ready' : 'fallback'
    return { material, trace: { stage: 'selection' as const, outcome: outcome as 'ready' | 'fallback', reason, rows: table.rows.length, ...(skill ? { skill } : {}) }, message: reason === 'ready' ? `${material.view.skill} prepared from ${table.rows.length} source rows. Cite ${table.source.url}.` : `Showing the source table instead (${reason.replaceAll('_', ' ')}). Do not claim a chart was drawn. Cite ${table.source.url}.` }
  }
  if (!skill || labelColumn < 0 || valueColumn < 0 || labelColumn >= table.headers.length || valueColumn >= table.headers.length || labelColumn === valueColumn) return finish('invalid_selection')
  if ((ADVANCED_SKILLS as readonly string[]).includes(skill)) {
    const result = compileAdvanced(table, args)
    if (result.visual) { material.view = { skill, labelColumn, valueColumn }; material.compiled = result.visual }
    return finish(result.reason)
  }
  if (skill === 'table') return finish('ready')
  const labels = table.rows.map((row) => row.cells[labelColumn])
  if (labels.some((label) => !label || label.length > 40)) return finish('invalid_selection')
  if (['ranking', 'comparison', 'trend', 'range'].includes(skill) && new Set(labels).size !== labels.length) return finish('duplicate_labels')
  if (table.rows.length < 2) return finish('insufficient_data')
  if (table.rows.length > (skill === 'ranking' ? 15 : skill === 'timeline' ? 16 : skill === 'comparison' ? 24 : skill === 'range' ? 31 : 50)) return finish('too_many_rows')
  // Extra period/currency/cohort fields can make otherwise numeric rows incomparable.
  const contextColumns = table.headers.flatMap((header, index) => index !== labelColumn && index !== valueColumn && !(skill === 'heatmap' && index === args.group_column) && /\b(year|date|period|currency|unit|cohort|basis)\b/i.test(header) ? [index] : [])
  if (contextColumns.some((index) => new Set(table.rows.map((row) => row.cells[index])).size > 1)) return finish('unsupported_context')
  let positions: number[] | undefined
  if (skill === 'trend' || skill === 'timeline') {
    const dates = labels.map(datePosition)
    if (dates.some((date) => date === null) || new Set(labels.map((label) => label.length)).size !== 1) return finish('invalid_dates')
    positions = dates as number[]
  }
  if (skill === 'timeline') {
    if (table.rows.some((row) => !row.cells[valueColumn])) return finish('insufficient_data')
    material.view = { skill, labelColumn, valueColumn, positions }
    return finish('ready')
  }
  const parsed = table.rows.map((row) => numberCell(row.cells[valueColumn]))
  if (parsed.some((cell) => cell === null)) return finish('not_numeric')
  const values = parsed.map((cell) => cell!.value)
  if (values.filter((value) => value !== null).length < 2) return finish('insufficient_data')
  const units = new Set(parsed.filter((cell) => cell!.value !== null).map((cell) => cell!.unit))
  if (units.size > 1) return finish('mixed_units')
  const headerUnit = table.headers[valueColumn].match(/(?:\b(USD|EUR|GBP|PKR|ms|km|kg)\b|(%|°C|°F))/)?.slice(1).find(Boolean)
  if (headerUnit && [...units][0] && headerUnit !== [...units][0]) return finish('mixed_units')
  material.view = { skill, labelColumn, valueColumn, values, positions, unit: [...units][0] || headerUnit || '' }
  if (skill === 'range') {
    const upperColumn = Number.isInteger(args.upper_column) ? args.upper_column as number : -1
    const boundsLabel = typeof args.bounds_label === 'string' ? args.bounds_label.trim() : ''
    if (upperColumn < 0 || upperColumn >= table.headers.length || upperColumn === labelColumn || upperColumn === valueColumn || !boundsLabel || boundsLabel.length > 120) return finish('invalid_selection')
    const upper = table.rows.map((row) => numberCell(row.cells[upperColumn]))
    if (upper.some((cell) => cell === null)) return finish('not_numeric')
    const upperHeaderUnit = table.headers[upperColumn].match(/(?:\b(USD|EUR|GBP|PKR|ms|km|kg)\b|(%|°C|°F))/)?.slice(1).find(Boolean) || ''
    const upperUnits = new Set(upper.filter((cell) => cell!.value !== null).map((cell) => cell!.unit))
    const upperUnit = [...upperUnits][0] || upperHeaderUnit
    if (upperUnits.size > 1 || (upperHeaderUnit && [...upperUnits][0] && upperHeaderUnit !== [...upperUnits][0]) || upperUnit !== material.view.unit) return finish('mixed_units')
    const upperValues = upper.map((cell) => cell!.value)
    if (values.some((low, index) => (low === null) !== (upperValues[index] === null) || (low !== null && upperValues[index] !== null && low > upperValues[index]!))) return finish('unsupported_context')
    material.view.upperColumn = upperColumn
    material.view.upperValues = upperValues
    material.view.boundsLabel = boundsLabel
  }
  if (skill === 'distribution') {
    if (values.some((value) => value === null) || values.length < 3) return finish('insufficient_data')
    if (/\b(mean|average|median|percentile|quantile|total|frequency|count)\b/i.test(table.headers[valueColumn])) return finish('unsupported_context')
  }
  if (skill === 'scatter') {
    const horizontal = labels.map(numberCell)
    if (horizontal.some((cell) => !cell || cell.value === null) || values.some((value) => value === null)) return finish('not_numeric')
    const horizontalUnits = new Set(horizontal.map((cell) => cell!.unit))
    if (horizontalUnits.size !== 1) return finish('mixed_units')
    const xHeaderUnit = table.headers[labelColumn].match(/(?:\b(USD|EUR|GBP|PKR|ms|km|kg)\b|(%|°C|°F))/)?.slice(1).find(Boolean)
    if (xHeaderUnit && [...horizontalUnits][0] && xHeaderUnit !== [...horizontalUnits][0]) return finish('mixed_units')
    material.view.positions = horizontal.map((cell) => cell!.value!)
    material.view.xUnit = [...horizontalUnits][0] || xHeaderUnit || ''
  }
  if (skill === 'heatmap') {
    const groupColumn = Number.isInteger(args.group_column) ? args.group_column as number : -1
    const groups = table.rows.map((row) => row.cells[groupColumn])
    if (groupColumn < 0 || groupColumn >= table.headers.length || groupColumn === labelColumn || groupColumn === valueColumn || groups.some((value) => !value || value.length > 40)) return finish('invalid_selection')
    if (new Set(labels).size > 12 || new Set(groups).size > 8) return finish('too_many_rows')
    const pairs = labels.map((label, index) => JSON.stringify([label, groups[index]]))
    if (new Set(pairs).size !== pairs.length) return finish('duplicate_labels')
    material.view.groupColumn = groupColumn
  }
  return finish('ready')
}
