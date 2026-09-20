import { mediateTable, type CapturedTable } from '../lib/cards/table-mediation'
import { tableCard } from '../lib/cards/table-card'
type Example = { skill: string; headers: string[]; rows: string[][]; args?: Record<string, unknown> }
const category = [['Alpha', '4', '6'], ['Beta', '7', '3']]
const time = [['2026-01-01', '4', '2'], ['2026-01-03', '7', '5']]
export const ADVANCED_EXAMPLES: Example[] = [
  { skill: 'statistic', headers: ['Team', 'Count', 'Baseline'], rows: [['Alpha', '8', '4']], args: { baseline_column: 2 } },
  { skill: 'dot-ranking', headers: ['Team', 'Count'], rows: category.map(r => r.slice(0, 2)) },
  ...['grouped', 'before-after', 'slope', 'target', 'rich-table'].map(skill => ({ skill, headers: ['Team', 'Count', 'Other'], rows: category, args: { value_columns: [1, 2], after_column: 2, target_column: 2 } })),
  ...['multi-trend', 'small-multiples', 'area'].map(skill => ({ skill, headers: ['Date', 'Count', 'Other'], rows: time, args: { value_columns: [1, 2] } })),
  { skill: 'uncertainty', headers: ['Date', 'Count', 'Low', 'High'], rows: time.map(r => [...r, String(Number(r[1]) + 2)]), args: { lower_column: 2, upper_column: 3, bounds_label: 'Published confidence interval' } },
  ...['composition', 'composition-percent'].map(skill => ({ skill, headers: ['Team', 'Part A', 'Part B', 'Total'], rows: category.map(r => [...r, '10']), args: { value_columns: [1, 2], total_column: 3, parts_exclusive: true } })),
  ...['share', 'waffle'].map(skill => ({ skill, headers: ['Team', 'Count', 'Total'], rows: [['Alpha', '4', '10'], ['Beta', '6', '10']], args: { total_column: 2, parts_exclusive: true } })),
  { skill: 'boxplot', headers: ['Group', 'Observation'], rows: [1, 2, 3, 4, 5, 6, 100].map(v => ['Alpha', String(v)]) },
  { skill: 'bubble', headers: ['Distance', 'Score', 'Size'], rows: [['2', '4', '5'], ['7', '3', '9']], args: { size_column: 2 } },
  { skill: 'calendar', headers: ['Date', 'Count'], rows: time.map(r => r.slice(0, 2)) },
  { skill: 'scaled-timeline', headers: ['Date', 'Event'], rows: [['2026-01-01', 'Started'], ['2026-01-03', 'Reviewed']] },
  { skill: 'duration', headers: ['Task', 'Start', 'End', 'As of'], rows: [['Build', '2026-01-01', '2026-01-02', '2026-01-05'], ['Review', '2026-01-02', 'ongoing', '2026-01-05']], args: { end_column: 2, as_of_column: 3 } },
  { skill: 'geographic', headers: ['Place', 'Count', 'Latitude', 'Longitude'], rows: [['Alpha', '4', '33', '73'], ['Beta', '7', '-20', '30']], args: { latitude_column: 2, longitude_column: 3 } },
  { skill: 'hierarchy', headers: ['Name', 'Count', 'ID', 'Parent'], rows: [['All', '10', 'root', ''], ['Alpha', '4', 'a', 'root'], ['Beta', '6', 'b', 'root']], args: { id_column: 2, parent_column: 3 } },
  { skill: 'flow', headers: ['From', 'Count', 'To', 'Cohort', 'Period'], rows: [['A', '10', 'B', 'Sample', '2026'], ['B', '4', 'C', 'Sample', '2026'], ['B', '6', 'D', 'Sample', '2026']], args: { to_column: 2, cohort_column: 3, period_column: 4 } },
  { skill: 'funnel', headers: ['Stage', 'Count', 'Cohort', 'Period'], rows: [['Visited', '10', 'Sample', '2026'], ['Finished', '4', 'Sample', '2026']], args: { cohort_column: 2, period_column: 3 } },
  { skill: 'contribution', headers: ['Stage', 'Count'], rows: [['Start', '10'], ['Gain', '4'], ['Loss', '-2'], ['End', '12']] },
  { skill: 'editorial', headers: ['Date', 'Count', 'Annotation'], rows: [['2026-01-01', '4', 'First observation'], ['2026-01-03', '7', 'Second observation']], args: { annotation_column: 2 } },
]
export function exampleTable(e: Example): CapturedTable {
  return { id: `sample-${e.skill}`, headers: e.headers, rows: e.rows.map((cells, i) => ({ id: `r${i + 3}`, line: i + 3, cells })), source: { title: 'Synthetic data', url: 'https://example.org/synthetic-data', fetchedAt: '2026-09-20T00:00:00Z' } }
}
export const ADVANCED_FIXTURES = ADVANCED_EXAMPLES.map(e => {
  const { material } = mediateTable(exampleTable(e), { skill: e.skill, label_column: 0, value_column: 1, ...e.args })
  return { id: `lab:visual-${e.skill}`, name: `${e.skill} · synthetic source pipeline`, card: tableCard(`Explore ${e.skill}`, material!) }
})
