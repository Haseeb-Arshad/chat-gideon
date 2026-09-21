import { describe, expect, it } from 'vitest'
import { ADVANCED_EXAMPLES, exampleTable } from '../../lab/advanced-fixtures'
import { ADVANCED_SKILLS, compileAdvanced } from './advanced-mediation'
import { mediateTable } from './table-mediation'
import { tableCard } from './table-card'
import { readCard } from './read'
import { readAdvancedChart } from './advanced-validation'
import { cardFromMaterials } from './from-materials'
describe('advanced source visualization families', () => {
  it('retains multiple source/view pairs with unique blocks and correct citations', () => {
    const materials = ADVANCED_EXAMPLES.slice(0, 4).map(e => mediateTable(exampleTable(e), { skill: e.skill, label_column: 0, value_column: 1, ...e.args }).material!)
    const card = readCard(cardFromMaterials('Explore all', materials, 0))!
    expect(card.blocks.filter(b => b.type === 'table')).toHaveLength(4)
    expect(new Set(card.blocks.map(b => b.id)).size).toBe(card.blocks.length)
    expect(card.blocks.every(b => b.cite?.[0] === 0)).toBe(true)
    expect(card.blocks.filter(b => b.type === 'chart')).toHaveLength(3)
  })
  it('covers every runtime skill', () => expect(ADVANCED_EXAMPLES.map(e => e.skill).sort()).toEqual([...ADVANCED_SKILLS].sort()))
  it('does not silently lose an entirely missing selected series in the legacy reader', () => {
    const e = ADVANCED_EXAMPLES.find(e => e.skill === 'multi-trend')!, table = structuredClone(exampleTable(e))
    table.rows.forEach(r => { r.cells[2] = '—' })
    expect(compileAdvanced(table, { skill: e.skill, label_column: 0, value_column: 1, ...e.args }).reason).toBe('insufficient_data')
  })
  it.each(ADVANCED_EXAMPLES)('$skill validates and round-trips with source evidence', e => {
    const table = exampleTable(e), args = { skill: e.skill, label_column: 0, value_column: 1, ...e.args }
    expect(compileAdvanced(table, args).reason).toBe('ready')
    const result = mediateTable(table, args)
    expect(result.material?.compiled).toBeDefined()
    const card = tableCard('Explore', result.material!), read = readCard(card)!
    expect(read).toBeTruthy()
    expect(read.blocks.map(b => b.type)).toEqual(card.blocks.map(b => b.type))
    expect(read.blocks.filter(b => b.type === 'chart').map(b => b.form)).toEqual(card.blocks.filter(b => b.type === 'chart').map(b => b.form))
    const raw = read.blocks.find(b => b.type === 'table')!
    expect(raw.rows.map(r => r.cells.map(c => c.text))).toEqual(e.rows)
    expect(raw.evidence?.datasetId).toBe(table.id)
  })
  it.each(ADVANCED_EXAMPLES)('$skill refuses invalid roles', e => {
    expect(compileAdvanced(exampleTable(e), { skill: e.skill, ...e.args, label_column: 0, value_column: 999 })).toEqual({ reason: 'invalid_selection' })
  })
  it.each(ADVANCED_EXAMPLES.filter(e => !['statistic', 'rich-table', 'grouped', 'multi-trend', 'area'].includes(e.skill)))('$skill rejects corrupted numeric wire values', e => {
    const visual = compileAdvanced(exampleTable(e), { skill: e.skill, label_column: 0, value_column: 1, ...e.args }).visual!
    const chart = structuredClone(visual.blocks.find(b => b.type === 'chart')!)
    chart.series[0].values[0] = Infinity
    expect(readAdvancedChart(chart as unknown as Record<string, unknown>)).toBeNull()
  })
  it.each([
    ['composition', 0, 3, '99'], ['composition-percent', 0, 1, '-1'],
    ['share', 0, 2, '99'], ['waffle', 0, 1, '-1'], ['uncertainty', 0, 2, '100'],
    ['duration', 0, 2, '2025-01-01'], ['calendar', 0, 0, '2026-02-30'],
    ['geographic', 0, 2, '91'], ['hierarchy', 0, 3, 'a'], ['flow', 1, 1, '99'],
    ['funnel', 1, 1, '99'], ['contribution', 3, 1, '99'], ['bubble', 0, 2, '-1'],
    ['before-after', 0, 2, '—'], ['target', 0, 2, '—'], ['slope', 0, 2, '—'],
  ] as const)('%s refuses misleading source data', (skill, row, column, value) => {
    const e = ADVANCED_EXAMPLES.find(e => e.skill === skill)!, table = structuredClone(exampleTable(e))
    table.rows[row].cells[column] = value
    expect(compileAdvanced(table, { skill, label_column: 0, value_column: 1, ...e.args }).visual).toBeUndefined()
  })
})
