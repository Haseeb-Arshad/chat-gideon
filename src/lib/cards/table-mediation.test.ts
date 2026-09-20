import { describe, expect, it } from 'vitest'
import { captureTables, mediateTable, datePosition, TABLE_LIMITS } from './table-mediation'
import { cardFromMaterials } from './from-materials'
import { readCard } from './read'
import { blockOf } from './schema'

const source = { title: 'Fixture statistics', url: 'https://example.com/data', fetchedAt: '2026-09-19T00:00:00Z' }
function prepare(body: string, skill = 'ranking', label_column = 0, value_column = 1) {
  const [table] = captureTables(body, source, 'page1')
  const result = mediateTable(table, { skill, label_column, value_column })
  const card = result.material ? readCard(cardFromMaterials('Compare the source data', [result.material], 0))! : null
  return { ...result, card }
}

describe('source-table mediation', () => {
  it('retains source cells and line locators without making a request', () => {
    const [table] = captureTables('Caption\n| Item | Value |\n| --- | ---: |\n| A | 1.20 |\n| B | — |', source, 'p')
    expect(table.rows).toEqual([{ id: 'r4', line: 4, cells: ['A', '1.20'] }, { id: 'r5', line: 5, cells: ['B', '—'] }])
    expect(table.source).toEqual(source)
  })
  it('rejects malformed and oversized tables rather than silently clipping', () => {
    expect(captureTables('| A | B |\n|---|---|\n| one | two | three |', source, 'p')).toEqual([])
    expect(captureTables(`| A | B |\n|---|---|\n${Array.from({ length: TABLE_LIMITS.rows + 1 }, (_, i) => `| ${i} | 1 |`).join('\n')}`, source, 'p')).toEqual([])
    expect(captureTables('x'.repeat(100_001), source, 'p')).toEqual([])
    expect(captureTables('| A | B |\n|---|---|\n| one | 2 |', { ...source, url: 'javascript:alert(1)' }, 'p')).toEqual([])
  })
  it.each(['1,234', '1.234,5', '10 million', '3*', '<script>3</script>'])('does not guess the value of %s', (value) => {
    const result = prepare(`| Name | Value |\n|---|---|\n| A | ${value} |\n| B | 2 |`)
    expect(result.card && blockOf(result.card, 'chart')).toBeFalsy()
  })
  it('keeps missing values separate from zero', () => {
    const result = prepare('| Name | Count |\n|---|---|\n| A | 0 |\n| B | — |\n| C | 2 |')
    expect(result.material?.view.values).toEqual([0, null, 2])
    expect(blockOf(result.card!, 'table')?.rows[1].cells[1].text).toBe('—')
  })
  it('rejects inconsistent units and explicit period differences', () => {
    expect(prepare('| Item | Price |\n|---|---|\n| A | 10 USD |\n| B | 12 EUR |').trace.reason).toBe('mixed_units')
    expect(prepare('| Item | Value | Year |\n|---|---|---|\n| A | 10 | 2024 |\n| B | 12 | 2025 |').trace.reason).toBe('unsupported_context')
    expect(prepare('| Item | Price (USD) |\n|---|---|\n| A | 10 EUR |\n| B | 12 EUR |').trace.reason).toBe('mixed_units')
  })
  it('fails safely for unknown tables and invalid column selections', () => {
    expect(mediateTable(undefined, { skill: 'ranking' }).trace.reason).toBe('no_table')
    expect(prepare('| A | B |\n|---|---|\n| X | 1 |\n| Y | 2 |', 'ranking', 0, 20).trace.reason).toBe('invalid_selection')
  })
})

describe('category: ranking', () => {
  it('sorts bars by source value while preserving source table order and citations', () => {
    const { card, trace } = prepare('| City | Passengers |\n|---|---|\n| Alpha | 4 |\n| Beta | 9 |\n| Gamma | 2 |')
    expect(trace.outcome).toBe('ready')
    expect(blockOf(card!, 'chart')).toMatchObject({ form: 'bar', x: ['Beta', 'Alpha', 'Gamma'], series: [{ values: [9, 4, 2] }] })
    expect(blockOf(card!, 'table')?.rows[0].cells[0].text).toBe('Alpha')
    expect(card?.sources[0].url).toBe(source.url)
  })
  it('does not merge duplicate identities or silently drop excess categories', () => {
    expect(prepare('| Name | Value |\n|---|---|\n| A | 1 |\n| A | 2 |').trace.reason).toBe('duplicate_labels')
    const result = prepare(`| Name | Value |\n|---|---|\n${Array.from({ length: 16 }, (_, i) => `| A${i} | ${i} |`).join('\n')}`)
    expect(result.trace.reason).toBe('too_many_rows')
    expect(blockOf(result.card!, 'table')?.rows).toHaveLength(16)
  })
})

describe('category: comparison', () => {
  it('uses columns for comparable numbers and preserves qualitative tables', () => {
    expect(blockOf(prepare('| Name | Mass (kg) |\n|---|---|\n| A | 4 |\n| B | 2 |', 'comparison').card!, 'chart')?.form).toBe('column')
    const fallback = prepare('| Name | Feature |\n|---|---|\n| A | Offline |\n| B | Online |', 'comparison')
    expect(fallback.trace.reason).toBe('not_numeric')
    expect(blockOf(fallback.card!, 'note')?.text).toContain('source table')
    expect(blockOf(fallback.card!, 'chart')).toBeUndefined()
  })
})

describe('category: trend', () => {
  it('orders observations and keeps irregular positions through wire parsing', () => {
    const result = prepare('| Year | Count |\n|---|---|\n| 2025 | 12 |\n| 2020 | 4 |\n| 2021 | 6 |', 'trend')
    expect(blockOf(result.card!, 'chart')).toMatchObject({ form: 'line', x: ['2020', '2021', '2025'], positions: [2020, 2021, 2025], series: [{ values: [4, 6, 12] }] })
  })
  it('rejects impossible dates and mixed precision', () => {
    expect(datePosition('2025-02-30')).toBeNull()
    expect(prepare('| Date | Count |\n|---|---|\n| 2025 | 12 |\n| 2025-01-01 | 4 |', 'trend').trace.reason).toBe('invalid_dates')
  })
  it('rejects invalid time geometry on the wire', () => {
    const { card } = prepare('| Year | Value |\n|---|---|\n| 2020 | 1 |\n| 2021 | 2 |', 'trend')
    const chart = blockOf(card!, 'chart')!
    for (const positions of [[1, 1], [2, 1], [1], [1, NaN]]) {
      const parsed = readCard({ ...card, blocks: [{ ...chart, positions }] })
      expect(parsed && blockOf(parsed, 'chart')).toBeFalsy()
    }
  })
})

describe('category: timeline and exact table', () => {
  it('orders events and allows multiple events on the same date', () => {
    const result = prepare('| Year | Event |\n|---|---|\n| 2025 | Release |\n| 2020 | Founded |\n| 2020 | First prototype |', 'timeline')
    expect(blockOf(result.card!, 'timeline')?.events.map((event) => event.label)).toEqual(['Founded', 'First prototype', 'Release'])
  })
  it('shows an explicit source table without guessing a numeric visual', () => {
    const result = prepare('| Item | Value |\n|---|---|\n| A | 1,234 |', 'table')
    expect(result.trace.outcome).toBe('ready')
    expect(blockOf(result.card!, 'table')?.rows[0].cells[1].text).toBe('1,234')
    expect(blockOf(result.card!, 'chart')).toBeUndefined()
  })
})
