import { expect, it } from 'vitest'
import { ADVANCED_FIXTURES } from '../../lab/advanced-fixtures'
import { compatibleForms, filterCategories } from './chart-exploration'
import type { ChartBlock } from './schema'
it('keeps composition and flow intact when a category filter is requested', () => {
  for (const f of ADVANCED_FIXTURES.filter(f => /composition|flow|share|hierarchy/.test(f.id))) {
    const chart = f.card.blocks.find(b => b.type === 'chart')!
    expect(filterCategories(chart, 'Alpha')).toBe(chart)
  }
})
it('offers small multiples only with valid ordered positions', () => {
  const b: ChartBlock = { id: 'c', slot: 'data', type: 'chart', form: 'line', title: 'Count', x: ['A', 'B'], series: [{ key: 'a', label: 'A', values: [1, 2] }, { key: 'b', label: 'B', values: [3, 4] }] }
  expect(compatibleForms(b)).toEqual(['line'])
  expect(compatibleForms({ ...b, positions: [2020, 2021] })).toContain('small-multiples')
})
