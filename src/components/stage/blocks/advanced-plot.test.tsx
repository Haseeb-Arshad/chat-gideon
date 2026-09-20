// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ADVANCED_FIXTURES } from '../../../lab/advanced-fixtures'
import { AdvancedPlot } from './AdvancedPlot'
import { isAdvancedForm } from '../../../lib/cards/advanced-types'
import { advancedHeight } from '../../../lib/cards/advanced-layout'
import type { ChartBlock } from '../../../lib/cards/schema'
afterEach(cleanup)
const charts = ADVANCED_FIXTURES.flatMap(f => f.card.blocks.filter((b): b is ChartBlock => b.type === 'chart' && isAdvancedForm(b.form)))
it.each(charts)('$form renders bounded geometry and supports keyboard inspection', block => {
  const onFocus = vi.fn()
  const view = render(<AdvancedPlot block={block} width={320} height={advancedHeight(block)} front focus={null} onFocus={onFocus} summary="Source example" />)
  expect(view.container.innerHTML).not.toMatch(/NaN|Infinity/)
  const svg = view.container.querySelector('svg')!
  fireEvent.keyDown(svg, { key: 'ArrowRight' })
  expect(onFocus).toHaveBeenCalled()
  fireEvent.keyDown(svg, { key: 'Escape' })
  expect(onFocus).toHaveBeenLastCalledWith(null)
})
