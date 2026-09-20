import type { ChartBlock, ChartForm } from './schema'
import { validAdvancedChart } from './advanced-validation'
export function compatibleForms(block: ChartBlock): ChartForm[] {
  const { form, series, x } = block
  if (['line', 'area', 'small-multiples'].includes(form)) return series.length === 1 ? ['line', 'area'] : validAdvancedChart({ ...block, form: 'small-multiples' }) ? ['line', 'small-multiples'] : ['line']
  if (['bar', 'column', 'dot'].includes(form) && series.length === 1) return (['column', 'dot', ...(x.length <= 15 ? ['bar'] : [])] as ChartForm[])
  if (form === 'slope' || form === 'dumbbell') return ['slope', 'dumbbell']
  if (form === 'donut' || form === 'waffle') return ['donut', 'waffle']
  if (form === 'stacked' || form === 'stacked-percent') return validAdvancedChart({ ...block, form: 'stacked-percent' }) ? ['stacked', 'stacked-percent'] : ['stacked']
  return [form]
}
export const filterableCategories = (block: ChartBlock) => ['bar', 'column', 'dot', 'slope', 'dumbbell', 'bullet'].includes(block.form)
export function filterCategories(block: ChartBlock, query: string): ChartBlock {
  if (!query.trim() || !filterableCategories(block)) return block
  const indexes = block.x.flatMap((label, i) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? [i] : [])
  return { ...block, x: indexes.map(i => block.x[i]), series: block.series.map(s => ({ ...s, values: indexes.map(i => s.values[i]) })), positions: block.positions ? indexes.map(i => block.positions![i]) : undefined, marks: block.marks?.filter(m => indexes.includes(m.at)).map(m => ({ ...m, at: indexes.indexOf(m.at) })), summary: undefined }
}
