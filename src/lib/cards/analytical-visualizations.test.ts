import { describe, expect, it } from 'vitest'
import { captureTables, mediateTable } from './table-mediation'
import { tableCard } from './table-card'
import { readCard } from './read'
import { blockOf } from './schema'
import { histogram } from './distribution'
import { niceScale } from './chart-math'

describe('source range selection', () => {
  const source = { title: 'Observed bounds', url: 'https://example.org/bounds', fetchedAt: '2026-09-20T00:00:00Z' }
  const prepare = (body: string, extra: Record<string, unknown> = {}) => {
    const [table] = captureTables(body, source, 'bounds')
    const result = mediateTable(table, { skill: 'range', label_column: 0, value_column: 1, upper_column: 2, bounds_label: 'Observed daily minimum and maximum', ...extra })
    return { ...result, card: readCard(tableCard('Show the observed bounds', result.material!))! }
  }
  const body = '| Day | Low (ms) | High (ms) |\n|---|---|---|\n| Mon | 1.23456 | 4.56789 |\n| Tue | — | — |\n| Wed | 2 | 5 |'
  it('preserves bound semantics, exact values, missing pairs and source cells through the reader', () => {
    const { card, trace } = prepare(body)
    expect(trace.outcome).toBe('ready')
    expect(blockOf(card, 'chart')).toMatchObject({ form: 'range', title: 'Observed daily minimum and maximum', unit: 'ms', series: [{ values: [1.23456, null, 2] }, { values: [4.56789, null, 5] }] })
    expect(blockOf(card, 'table')?.rows[0].cells.map((cell) => cell.text)).toEqual(['Mon', '1.23456', '4.56789'])
    expect(card.sources[0].url).toBe(source.url)
  })
  it.each([
    [body.replace('4.56789', '0'), {}],
    [body.replace('| Tue | — | — |', '| Tue | — | 4 |'), {}],
    [body.replace('High (ms)', 'High (kg)'), {}],
    [body.replace('4.56789', 'uncertain'), {}],
    [body, { upper_column: 1 }],
    [body, { bounds_label: '' }],
  ])('falls back to raw data for incompatible bounds', (text, extra) => {
    const { card, trace } = prepare(text as string, extra as Record<string, unknown>)
    expect(trace.outcome).toBe('fallback')
    expect(blockOf(card, 'chart')).toBeUndefined()
    expect(blockOf(card, 'table')?.rows).toHaveLength(3)
    expect(blockOf(card, 'note')).toBeDefined()
  })
})

function visual(text: string, skill: string, group_column?: number) {
  const [table] = captureTables(text, { title: 'Synthetic', url: 'https://example.org/data', fetchedAt: '2026-09-19T00:00:00Z' }, 't')
  const result = mediateTable(table, { skill, label_column: 0, value_column: 1, group_column })
  return { ...result, card: result.material ? readCard(tableCard('q', result.material))! : null }
}

describe('scatter category', () => {
  it('keeps paired observations together when sorting the numeric x axis', () => {
    const { card } = visual('| Hours | Score |\n|---|---|\n| 8 | 70 |\n| 2 | 40 |\n| 8 | 85 |', 'scatter')
    expect(blockOf(card!, 'chart')).toMatchObject({ form: 'scatter', positions: [2, 8, 8], series: [{ values: [40, 70, 85] }] })
  })
  it('falls back for missing pairs, mixed horizontal units or header conflicts', () => {
    for (const text of ['| Hours | Score |\n|---|---|\n| 2 | — |\n| 3 | 4 |\n| 4 | 6 |', '| Distance | Score |\n|---|---|\n| 2 km | 4 |\n| 3 kg | 6 |', '| Distance (km) | Score |\n|---|---|\n| 2 kg | 4 |\n| 3 kg | 6 |']) {
      const result = visual(text, 'scatter')
      expect(result.trace.outcome).toBe('fallback')
      expect(blockOf(result.card!, 'chart')).toBeUndefined()
    }
  })
  it('keeps tiny nonzero coordinates on a meaningful axis', () => {
    const scale = niceScale(1e-25, 5e-25)
    expect(scale.min).toBeLessThanOrEqual(1e-25)
    expect(scale.max).toBeGreaterThanOrEqual(5e-25)
    expect(new Set(scale.ticks).size).toBe(scale.ticks.length)
  })
})

describe('distribution category', () => {
  it('counts every observation once, including both endpoints and duplicates', () => {
    const bins = histogram([0, 0, 1, 2, 3, 4, 4])
    expect(bins.counts.reduce((a, b) => a + b, 0)).toBe(7)
    expect(bins.counts[0]).toBeGreaterThanOrEqual(2)
    expect(bins.counts.at(-1)).toBeGreaterThanOrEqual(2)
  })
  it('round-trips a histogram with bin methodology and source observations', () => {
    const { card } = visual('| Sample | Latency (ms) |\n|---|---|\n| A | 10 |\n| B | 20 |\n| C | 30 |\n| D | 40 |', 'distribution')
    expect(blockOf(card!, 'chart')).toMatchObject({ form: 'histogram', series: [{ values: [2, 2] }] })
    expect(blockOf(card!, 'chart')?.summary).toContain('lower bound')
    expect(blockOf(card!, 'table')?.rows).toHaveLength(4)
  })
  it('supports a constant distribution as one bin', () => {
    const result = visual('| Sample | Latency |\n|---|---|\n| A | 5 |\n| B | 5 |\n| C | 5 |', 'distribution')
    expect(blockOf(result.card!, 'chart')).toMatchObject({ x: ['5'], series: [{ values: [3] }] })
  })
  it('does not imply a distribution from averages or incomplete observations', () => {
    for (const text of ['| Sample | Average latency |\n|---|---|\n| A | 10 |\n| B | 20 |\n| C | 30 |', '| Sample | Latency |\n|---|---|\n| A | 10 |\n| B | — |\n| C | 30 |']) {
      const result = visual(text, 'distribution')
      expect(result.trace.outcome).toBe('fallback')
      expect(blockOf(result.card!, 'chart')).toBeUndefined()
    }
  })
})

describe('heatmap category', () => {
  it('builds a sparse matrix with zero distinct from a missing pair', () => {
    const { card } = visual('| Day | Visits | Team |\n|---|---|---|\n| Mon | 0 | Alpha |\n| Tue | 4 | Alpha |\n| Mon | 8 | Beta |', 'heatmap', 2)
    expect(blockOf(card!, 'chart')).toMatchObject({ form: 'heatmap', x: ['Mon', 'Tue'], yLabel: 'Team', series: [{ label: 'Alpha', values: [0, 4] }, { label: 'Beta', values: [8, null] }] })
  })
  it('retains entirely missing groups instead of silently dropping them', () => {
    const { card } = visual('| Day | Visits | Team |\n|---|---|---|\n| Mon | 2 | Alpha |\n| Tue | 4 | Alpha |\n| Mon | — | Beta |', 'heatmap', 2)
    expect(blockOf(card!, 'chart')?.series[1]).toMatchObject({ label: 'Beta', values: [null, null] })
  })
  it('rejects duplicate pairs and unspecified dimensions', () => {
    const text = '| Day | Visits | Team |\n|---|---|---|\n| Mon | 2 | Alpha |\n| Mon | 4 | Alpha |'
    expect(visual(text, 'heatmap', 2).trace.reason).toBe('duplicate_labels')
    expect(visual(text, 'heatmap').trace.reason).toBe('invalid_selection')
  })
  it('rejects malformed wire shapes rather than losing numeric observations', () => {
    const { card } = visual('| Hours | Score |\n|---|---|\n| 2 | 4 |\n| 3 | 6 |', 'scatter')
    const chart = blockOf(card!, 'chart')!
    for (const modified of [{ ...chart, positions: undefined }, { ...chart, series: [{ key: 'v', label: 'v', values: [2, null] }] }]) {
      expect(readCard({ ...card, blocks: [modified] })).toBeNull()
    }
  })
})
