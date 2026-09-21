import type { ChartBlock, TableBlock } from './schema'

export interface TreeRect { index: number; x: number; y: number; width: number; height: number; depth: number; leaf: boolean }
export function treeLayout(chart: ChartBlock, width: number, height: number): TreeRect[] {
  const ids = chart.analysis!.ids!, parents = chart.analysis!.parents!, values = chart.series[0].values
  const result: TreeRect[] = []
  const visit = (indexes: number[], x: number, y: number, w: number, h: number, depth: number) => {
    const total = indexes.reduce((sum, i) => sum + values[i]!, 0)
    let offset = 0
    for (const index of indexes) {
      const part = total ? values[index]! / total : 0
      const horizontal = w >= h
      const rect = { index, x: x + (horizontal ? offset : 0), y: y + (horizontal ? 0 : offset), width: horizontal ? w * part : w, height: horizontal ? h : h * part, depth, leaf: !parents.includes(ids[index]) }
      offset += horizontal ? rect.width : rect.height
      result.push(rect)
      if (!rect.leaf) {
        const children = parents.flatMap((parent, i) => parent === ids[index] ? [i] : [])
        const inset = Math.min(3, rect.width / 8, rect.height / 8)
        const header = rect.height > 45 ? 17 : 0
        visit(children, rect.x + inset, rect.y + inset + header, Math.max(0, rect.width - inset * 2), Math.max(0, rect.height - inset * 2 - header), depth + 1)
      }
    }
  }
  visit(parents.flatMap((parent, i) => !parent ? [i] : []), 0, 0, width, height, 0)
  return result
}

export function flowLayout(chart: ChartBlock, width: number, height: number) {
  const targets = chart.analysis!.targets!, values = chart.series[0].values as number[]
  const names = [...new Set([...chart.x, ...targets])]
  const depth = new Map(names.map((name) => [name, 0]))
  for (let pass = 0; pass < names.length; pass++) chart.x.forEach((from, i) => depth.set(targets[i], Math.max(depth.get(targets[i])!, depth.get(from)! + 1)))
  const last = Math.max(...depth.values(), 1)
  const levels = Array.from({ length: last + 1 }, (_, d) => names.filter((name) => depth.get(name) === d))
  const amount = (name: string) => Math.max(chart.x.reduce((sum, from, i) => sum + (from === name ? values[i] : 0), 0), targets.reduce((sum, to, i) => sum + (to === name ? values[i] : 0), 0))
  const scale = Math.min(...levels.filter((level) => level.length).map((level) => Math.max(1, height - (level.length - 1) * 12) / (level.reduce((sum, name) => sum + amount(name), 0) || 1)))
  const nodes = levels.flatMap((level, d) => {
    let y = (height - level.reduce((sum, name) => sum + amount(name) * scale, 0) - (level.length - 1) * 12) / 2
    return level.map((name) => { const node = { name, x: d / last * (width - 12), y, height: amount(name) * scale, amount: amount(name) }; y += node.height + 12; return node })
  })
  const byName = new Map(nodes.map((node) => [node.name, node]))
  const outgoing = new Map<string, number>(), incoming = new Map<string, number>()
  const links = chart.x.map((from, i) => {
    const to = targets[i], source = byName.get(from)!, target = byName.get(to)!, thickness = values[i] * scale
    const sy = source.y + (outgoing.get(from) ?? 0) + thickness / 2, ty = target.y + (incoming.get(to) ?? 0) + thickness / 2
    outgoing.set(from, (outgoing.get(from) ?? 0) + thickness); incoming.set(to, (incoming.get(to) ?? 0) + thickness)
    return { index: i, x1: source.x + 12, x2: target.x, y1: sy, y2: ty, thickness }
  })
  return { nodes, links }
}

export function advancedTableOf(block: ChartBlock): TableBlock {
  const columns: TableBlock['columns'] = [{ key: 'label', label: block.xLabel || 'Entry', kind: 'text' }]
  if (block.form === 'treemap') columns.push({ key: 'id', label: 'Node ID', kind: 'text' }, { key: 'parent', label: 'Parent ID', kind: 'text' })
  if (block.form === 'sankey') columns.push({ key: 'target', label: 'Destination', kind: 'text' })
  block.series.forEach((s, i) => columns.push({ key: s.key, label: s.label, kind: block.form === 'gantt' || block.form === 'event-timeline' ? 'text' : 'number', unit: block.analysis?.units?.[i] ?? (block.form === 'geo-symbol' && i > 0 ? 'degrees' : block.unit) }))
  if (block.analysis?.annotations) columns.push({ key: 'annotation', label: 'Source annotation', kind: 'text' })
  if (block.form === 'box') columns.push({ key: 'n', label: 'Sample size', kind: 'number' }, { key: 'outliers', label: 'Outliers', kind: 'text' })
  if (block.analysis?.totals) columns.push({ key: 'source-total', label: block.analysis.denominator || 'Source total', kind: 'number', unit: block.unit })
  const rows = block.x.map((label, i) => {
    const cells: TableBlock['rows'][number]['cells'] = [{ text: label }]
    if (block.form === 'treemap') cells.push({ text: block.analysis!.ids![i] }, { text: block.analysis!.parents![i] || 'Root' })
    if (block.form === 'sankey') cells.push({ text: block.analysis!.targets![i] })
    block.series.forEach((s) => {
      const value = s.values[i]
      cells.push(block.form === 'gantt' ? { text: value === null ? `Ongoing as of ${block.analysis!.period}` : new Date(value).toISOString().slice(0, 10) } : block.form === 'event-timeline' ? { text: 'Event marker (not a quantity)' } : value === null ? { text: '—' } : { text: String(value), value })
    })
    if (block.analysis?.annotations) cells.push({ text: block.analysis.annotations[i] })
    if (block.form === 'box') cells.push({ text: String(block.analysis!.sampleSizes![i]), value: block.analysis!.sampleSizes![i] }, { text: block.analysis!.outliers![i].join(', ') || 'None' })
    if (block.analysis?.totals) { const total = block.analysis.totals.length === 1 ? block.analysis.totals[0] : block.analysis.totals[i]; cells.push({ text: String(total), value: total }) }
    return { id: String(i), cells }
  })
  return { id: `${block.id}-values`, slot: 'data', type: 'table', rowHeaders: true, caption: block.form === 'stacked-percent' ? 'Exact absolute source values; the drawing shows shares of the verified totals.' : block.title, columns, rows }
}

export function advancedHeight(block: ChartBlock): number {
  if (['dot', 'dumbbell', 'bullet', 'gantt', 'box', 'funnel'].includes(block.form)) return Math.max(160, 50 + block.x.length * 32)
  if (block.form === 'donut' || block.form === 'waffle') return Math.max(300, 190 + block.x.length * 19)
  if (block.form === 'small-multiples') return 160 * block.series.length
  if (block.form === 'calendar') return 160
  if (block.form === 'event-timeline') return 190
  return 320
}
