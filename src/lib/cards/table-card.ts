import type { TableMaterial } from './table-mediation'
import type { Block, CardV2, ChartBlock, TableBlock } from './schema'
import { histogram } from './distribution'
import { datasetVersion } from './data-values'

const REASONS: Record<string, string> = {
  not_numeric: 'Some cells cannot be safely interpreted as numbers.',
  mixed_units: 'The selected values use different units.',
  invalid_dates: 'The dates cannot be placed on one reliable time scale.',
  duplicate_labels: 'Repeated category labels need clarification before plotting.',
  too_many_rows: 'The data exceeds this visual’s readable size limit.',
  insufficient_data: 'There are too few comparable values for this visual.',
  invalid_selection: 'The selected columns cannot support this visual.',
  unsupported_context: 'Observation periods, units, cohorts or aggregation levels do not support this visual.',
}

export function tableCard(question: string, material: TableMaterial): CardV2 {
  const { table, view } = material
  const title = view.skill === 'range' ? view.boundsLabel! : table.headers[view.valueColumn] ?? material.source.title
  const blocks: Block[] = [{ id: 'headline', slot: 'head', type: 'headline', title, kicker: material.source.title, cite: [0] }]
  const order = table.rows.map((_, index) => index)
  if (view.skill === 'ranking') order.sort((a, b) => (view.values![b] ?? -Infinity) - (view.values![a] ?? -Infinity))
  if (view.positions) order.sort((a, b) => view.positions![a] - view.positions![b])
  if (material.compiled) {
    blocks.push(...material.compiled.blocks.map((block) => ({ ...block, cite: [0] })))
  } else if (view.skill === 'timeline') {
    blocks.push({ id: 'timeline', slot: 'data', type: 'timeline', events: order.map((index) => ({ id: table.rows[index].id, date: table.rows[index].cells[view.labelColumn], label: table.rows[index].cells[view.valueColumn], cite: [0] })) })
  } else if (view.skill === 'range') {
    blocks.push({ id: 'chart', slot: 'data', type: 'chart', form: 'range', title: view.boundsLabel!, cite: [0], unit: view.unit, xLabel: table.headers[view.labelColumn], x: order.map((index) => table.rows[index].cells[view.labelColumn]),
      series: [{ key: 'lower', label: table.headers[view.valueColumn], values: order.map((index) => view.values![index]) }, { key: 'upper', label: table.headers[view.upperColumn!], values: order.map((index) => view.upperValues![index]) }],
    })
  } else if (view.skill === 'heatmap') {
    const x = [...new Set(table.rows.map((row) => row.cells[view.labelColumn]))]
    const groups = [...new Set(table.rows.map((row) => row.cells[view.groupColumn!]))]
    blocks.push({ id: 'chart', slot: 'data', type: 'chart', form: 'heatmap', title, cite: [0], unit: view.unit, xLabel: table.headers[view.labelColumn], yLabel: table.headers[view.groupColumn!], x,
      series: groups.map((label, groupIndex) => ({ key: `group${groupIndex}`, label, values: x.map((category) => {
        const index = table.rows.findIndex((row) => row.cells[view.labelColumn] === category && row.cells[view.groupColumn!] === label)
        return index < 0 ? null : view.values![index]
      }) })),
    })
  } else if (view.skill === 'distribution') {
    const bins = histogram(view.values as number[])
    blocks.push({ id: 'chart', slot: 'data', type: 'chart', form: 'histogram', title: `Distribution of ${title}`, cite: [0], xLabel: title, x: bins.labels, unit: 'observations',
      series: [{ key: 'frequency', label: 'Frequency', values: bins.counts }],
      summary: `${view.values!.length} observations in ${bins.counts.length} equal-width bins. ${view.unit ? `Bin units: ${view.unit}. ` : ''}Each bin includes its lower bound; only the last includes its upper bound.`,
    })
  } else if (view.values) {
    const chart: ChartBlock = {
      id: 'chart', slot: 'data', type: 'chart', cite: [0], title,
      form: view.skill === 'scatter' ? 'scatter' : view.skill === 'trend' ? 'line' : view.skill === 'ranking' ? 'bar' : 'column',
      xLabel: table.headers[view.labelColumn],
      x: order.map((index) => table.rows[index].cells[view.labelColumn]),
      series: [{ key: 'value', label: title, values: order.map((index) => view.values![index]) }],
      ...(view.unit ? { unit: view.unit } : {}),
      ...(view.skill === 'scatter' ? { xUnit: view.xUnit, yLabel: title } : {}),
      ...(view.positions ? { positions: order.map((index) => view.positions![index]) } : {}),
    }
    blocks.push(chart)
  }
  // Raw source cells stay available, including ambiguous formats and missing markers.
  blocks.push({
    id: 'source-table', slot: 'more', type: 'table', cite: [0], rowHeaders: true,
    caption: `Source table · retrieved ${material.source.fetchedAt.slice(0, 10)}. Source order unless sorted.`,
    evidence: material.compiled?.evidence ?? { datasetId: table.id, version: datasetVersion([table.headers, table.rows]), fetchedAt: table.source.fetchedAt, sourceUrl: table.source.url, columns: [view.labelColumn, view.valueColumn], rows: table.rows.map(({ id, line }) => ({ id, line })), transforms: [view.skill === 'distribution' ? 'Equal-width histogram bins; final bin includes its upper endpoint. Original observations retained.' : 'Source cells retained; chart ordering may differ from source order.'] },
    columns: table.headers.map((label, index) => ({ key: `c${index}`, label, kind: material.compiled?.numericColumns.includes(index) || (index === view.valueColumn && view.values) ? 'number' : 'text', ...(view.skill === 'rich-table' && material.compiled?.numericColumns.includes(index) ? { visual: 'bar' as const } : {}) })),
    rows: table.rows.map((row, rowIndex) => ({ id: row.id, sourceLine: row.line, cells: row.cells.map((text, columnIndex) => {
      const value = material.compiled?.numericValues[columnIndex]?.[rowIndex] ?? (columnIndex === view.valueColumn ? view.values?.[rowIndex] : undefined)
      return { text, ...(value != null ? { value } : {}) }
    }), cite: [0] })),
  } satisfies TableBlock)
  if (material.reason !== 'ready') blocks.push({ id: 'visual-note', slot: 'summary', type: 'note', tone: 'info', text: `${REASONS[material.reason] ?? 'A reliable chart could not be prepared.'} The source table is shown instead.` })
  return {
    schema: 2, recipe: view.skill === 'trend' ? 'trend' : view.skill === 'ranking' ? 'ranking' : view.skill === 'timeline' ? 'timeline' : 'compare',
    size: 'wide', query: question, title, blocks,
    sources: [{ title: material.source.title, url: material.source.url, host: new URL(material.source.url).hostname.replace(/^www\./, '') }],
    asOf: null, partial: false,
  }
}
