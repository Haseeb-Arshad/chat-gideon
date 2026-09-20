import { ADVANCED_FIXTURES } from './advanced-fixtures'
import { captureTables, mediateTable } from '../lib/cards/table-mediation'
import { tableCard } from '../lib/cards/table-card'
import type { VisualizationSkill } from '../lib/cards/visualization-skills'
import type { CardV2, ChartBlock } from '../lib/cards/schema'

/** Synthetic examples: no fetch, model, remote media or production data. */
const TABLE_FIXTURES = ([
  ['ranking', 'Rank sample journeys', '| Route | Journeys |\n|---|---|\n| North | 42 |\n| Harbour | 75 |\n| South | 31 |'],
  ['comparison', 'Compare sample completion rates', '| Team | Completed (%) |\n|---|---|\n| Alpha | 64 |\n| Beta | 82 |\n| Gamma | 73 |'],
  ['trend', 'Show sample observations over time', '| Date | Observations |\n|---|---|\n| 2026-01-01 | 12 |\n| 2026-01-02 | 18 |\n| 2026-01-07 | 15 |\n| 2026-01-10 | 27 |'],
  ['timeline', 'Show a sample project timeline', '| Date | Event |\n|---|---|\n| 2026-01-02 | First prototype |\n| 2026-02-18 | Public preview |\n| 2026-04-09 | General release |'],
  ['table', 'Compare sample product features', '| Product | Storage | Offline |\n|---|---|---|\n| Atlas | Local | Yes |\n| Harbour | Cloud | No |'],
  ['comparison', 'Show mixed-unit fallback', '| Product | Price |\n|---|---|\n| Atlas | 40 USD |\n| Harbour | 35 EUR |'],
  ['scatter', 'Compare study hours with scores', '| Study hours | Score |\n|---|---|\n| 2 | 48 |\n| 4 | 68 |\n| 4 | 57 |\n| 7 | 81 |\n| 9 | 76 |'],
  ['distribution', 'Show a sample latency distribution', '| Sample | Latency (ms) |\n|---|---|\n| A | 12 |\n| B | 14 |\n| C | 18 |\n| D | 21 |\n| E | 23 |\n| F | 32 |\n| G | 43 |\n| H | 45 |\n| I | 48 |'],
  ['heatmap', 'Compare sample visits by day and team', '| Day | Visits | Team |\n|---|---|---|\n| Mon | 0 | Alpha |\n| Tue | 18 | Alpha |\n| Wed | 12 | Alpha |\n| Mon | 8 | Beta |\n| Wed | 24 | Beta |\n| Mon | 16 | Gamma |\n| Tue | 11 | Gamma |\n| Wed | 20 | Gamma |', 2],
] satisfies Array<[VisualizationSkill, string, string, number?]>).map(([skill, query, text, group_column], index) => {
  const [table] = captureTables(text, { title: 'Synthetic sample data', url: 'https://example.org/synthetic-data', fetchedAt: '2026-09-19T00:00:00Z' }, `sample${index}`)
  const { material } = mediateTable(table, { skill, label_column: 0, value_column: 1, group_column })
  return { id: `lab:visual-${index}`, name: `${skill} · sourced-table pipeline (sample)`, card: tableCard(query, material!) }
})

const EDGE_CHARTS: Array<Omit<ChartBlock, 'id' | 'slot' | 'type'>> = [
  { form: 'range', title: 'Published low and high bounds', unit: 'ms', x: ['Monday', 'Tuesday', 'Wednesday'], series: [{ key: 'low', label: 'Low', values: [1.23456, null, 2.12345] }, { key: 'high', label: 'High', values: [4.56789, null, 5.67891] }] },
  { form: 'area', title: 'All-zero observations with a missing interval', x: ['2020', '2021', '2022', '2025'], positions: [2020, 2021, 2022, 2025], series: [{ key: 'v', label: 'Count', values: [0, null, 0, 0] }] },
  { form: 'bar', title: 'Signed changes with long category names', unit: '%', x: ['A long positive category name with full details', 'No measured change', 'A long negative category name with full details'], series: [{ key: 'v', label: 'Change', values: [12.34567, 0, -9.87654] }] },
  { form: 'line', title: 'Multiple measures with long series names', x: ['2020', '2021', '2025'], positions: [2020, 2021, 2025], series: [{ key: 'a', label: 'First series with a deliberately long label', values: [12, 14, 20] }, { key: 'b', label: 'Second series with a deliberately long label', values: [10, null, 16] }] },
]

const [rangeTable] = captureTables('| Date | Minimum (°C) | Maximum (°C) |\n|---|---|---|\n| 2026-09-18 | 18.25 | 27.75 |\n| 2026-09-19 | 17.125 | 25.625 |\n| 2026-09-20 | 19.5 | 28.125 |', { title: 'Synthetic published bounds', url: 'https://example.org/synthetic-bounds', fetchedAt: '2026-09-20T00:00:00Z' }, 'bounds')
const rangeMaterial = mediateTable(rangeTable, { skill: 'range', label_column: 0, value_column: 1, upper_column: 2, bounds_label: 'Observed daily minimum and maximum' }).material!

export const VISUALIZATION_FIXTURES = [...ADVANCED_FIXTURES, ...TABLE_FIXTURES, { id: 'lab:visual-range', name: 'range · sourced-table pipeline (sample)', card: tableCard('Show the published temperature bounds', rangeMaterial) }, ...EDGE_CHARTS.map((chart, index) => ({
  id: `lab:visual-edge-${index}`, name: `${chart.form} · renderer edge case (sample)`,
  card: { schema: 2, recipe: 'trend', size: 'wide', query: chart.title, title: chart.title, sources: [], asOf: null, partial: false,
    blocks: [{ id: 'head', slot: 'head', type: 'headline', title: chart.title, kicker: 'Synthetic renderer fixture' }, { ...chart, id: 'chart', slot: 'data', type: 'chart' }],
  } satisfies CardV2,
}))]
