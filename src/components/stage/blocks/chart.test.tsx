// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { CardV2, ChartBlock } from '../../../lib/cards/schema'
import { Stage } from '../Stage'

/**
 * Charts as they are read: a gap in the data is a gap in the line, identity is
 * never colour alone, and every value the pointer can find is also reachable
 * from the keyboard and in the table view.
 */

afterEach(cleanup)

function stage(chart: Omit<ChartBlock, 'id' | 'slot'>) {
  const card: CardV2 = {
    schema: 2,
    recipe: 'trend',
    size: 'wide',
    query: 'q',
    title: 'Chart',
    blocks: [{ id: 'chart', slot: 'body', ...chart } as ChartBlock],
    sources: [],
    asOf: null,
    partial: false,
  }
  const entries = [{ id: 'a', query: 'q', hint: 'web' as const, card, leaving: false }]
  return render(
    <Stage entries={entries} frontId="a" tucking={false} spoken="" onFocus={() => undefined} onTuck={() => undefined} />,
  )
}

const years = ['2018', '2019', '2020', '2021', '2022']

describe('local chart exploration', () => {
  it('switches compatible views, filters categories and resets without mutating values', () => {
    const chart = { type: 'chart' as const, form: 'bar' as const, title: 'Counts', x: ['Alpha', 'Beta'], series: [{ key: 'v', label: 'Count', values: [4, 9] }] }
    const view = stage(chart)
    fireEvent.change(view.getByRole('combobox', { name: 'Chart type' }), { target: { value: 'dot' } })
    expect(view.container.querySelector('figure')?.getAttribute('data-form')).toBe('dot')
    fireEvent.change(view.getByRole('textbox', { name: 'Filter chart categories' }), { target: { value: 'Beta' } })
    fireEvent.click(view.getByRole('button', { name: 'Show as table' }))
    expect(view.container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(view.container.querySelector('tbody')?.textContent).toContain('9')
    fireEvent.click(view.getByRole('button', { name: 'Reset view' }))
    expect(view.container.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(chart.series[0].values).toEqual([4, 9])
  })
  it('hides a measure without changing its table values or remaining palette identity', () => {
    const view = stage({ type: 'chart', form: 'line', title: 'Counts', x: ['2020', '2021'], positions: [2020, 2021], series: [{ key: 'a', label: 'First', values: [4, 6] }, { key: 'b', label: 'Second', values: [8, 9] }] })
    fireEvent.click(view.getByRole('checkbox', { name: 'First' }))
    expect(view.getByRole('checkbox', { name: 'Second' })).toHaveProperty('disabled', true)
    fireEvent.click(view.getByRole('button', { name: 'Show as table' }))
    expect(view.container.querySelector('tbody')?.textContent).toContain('4')
    expect(view.container.querySelector('tbody')?.textContent).toContain('8')
  })
})

describe('irregular time and touch inspection', () => {
  it('expands the selected period and dismisses details while preserving the original selection', () => {
    const { getByRole, queryByRole } = stage({ type: 'chart', form: 'line', title: 'Counts', x: ['2020', '2021', '2025'], positions: [2020, 2021, 2025], series: [{ key: 'v', label: 'Count', values: [2, 4, 9] }] })
    fireEvent.change(getByRole('combobox', { name: 'Start date' }), { target: { value: '1' } })
    fireEvent.click(getByRole('button', { name: 'Expand chart' }))
    const dialog = getByRole('dialog', { name: 'Counts' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show as table' }))
    expect(within(dialog).getAllByRole('row')).toHaveLength(3)
    expect(within(dialog).queryByText('2020')).toBeNull()
    fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }))
    expect(queryByRole('dialog')).toBeNull()
    expect(getByRole('combobox', { name: 'Start date' })).toHaveProperty('value', '1')
  })
  it('filters dates and table values together and resets without mutating captured data', () => {
    const chart: Omit<ChartBlock, 'id' | 'slot'> = { type: 'chart', form: 'line', title: 'Counts', x: ['2020', '2021', '2025'], positions: [2020, 2021, 2025], series: [{ key: 'v', label: 'Count', values: [2, 4, 9] }], marks: [{ at: 2, label: 'Latest' }] }
    const { container, getByRole } = stage(chart)
    fireEvent.change(getByRole('combobox', { name: 'Start date' }), { target: { value: '1' } })
    expect(getByRole('status').textContent).toContain('Showing 2 of 3')
    expect(container.querySelector('.chart-mark-label')?.textContent).toBe('Latest')
    fireEvent.click(getByRole('button', { name: 'Show as table' }))
    expect(container.querySelectorAll('.card-table tbody tr')).toHaveLength(2)
    expect(container.querySelector('.card-table tbody')?.textContent).not.toContain('2020')
    fireEvent.click(getByRole('button', { name: 'Reset dates' }))
    expect(container.querySelectorAll('.card-table tbody tr')).toHaveLength(3)
    expect(chart.series[0].values).toEqual([2, 4, 9])
  })
  it('handles a selected period with only missing observations without drawing invented endpoints', () => {
    const { container, getByRole, getByText } = stage({ type: 'chart', form: 'line', title: 'Counts', x: ['2020', '2021', '2022', '2025'], positions: [2020, 2021, 2022, 2025], series: [{ key: 'v', label: 'Count', values: [null, null, 2, 4] }] })
    fireEvent.change(getByRole('combobox', { name: 'End date' }), { target: { value: '1' } })
    expect(getByText('No values to plot. Choose another period or inspect the table.')).toBeDefined()
    expect(container.querySelector('.card-chart-svg')).toBeNull()
    fireEvent.click(getByRole('button', { name: 'Show as table' }))
    expect(container.querySelectorAll('.card-table tbody tr')).toHaveLength(2)
  })
  it('keeps a touch selection after the finger leaves the surface', () => {
    const { container } = stage({ type: 'chart', form: 'line', title: 'Counts', x: ['A', 'B'], series: [{ key: 'v', label: 'Count', values: [2, 4] }] })
    for (const type of ['pointerdown', 'pointerout']) {
      const event = new Event(type, { bubbles: true })
      Object.assign(event, { pointerType: 'touch', clientX: 40, clientY: 30 })
      fireEvent(container.querySelector('.card-chart-svg')!, event)
    }
    expect(container.querySelector('.card-chart-readout')).not.toBeNull()
  })
  it('does not round range endpoints during exact inspection', () => {
    const { container, getByRole } = stage({ type: 'chart', form: 'range', title: 'Bounds', x: ['A', 'B'], series: [{ key: 'low', label: 'Low', values: [1.23456, 2] }, { key: 'high', label: 'High', values: [1234567, 4] }] })
    fireEvent.keyDown(container.querySelector('svg')!, { key: 'Home' })
    expect(container.querySelector('.card-chart-readout')?.textContent).toContain('1.23456 to 1234567')
    fireEvent.click(getByRole('button', { name: 'Show as table' }))
    expect(container.querySelector('.card-table')?.textContent).toContain('1.23456')
  })
  it('draws negative ranked values to the left of zero and exposes their exact readout', () => {
    const { container } = stage({ type: 'chart', form: 'bar', title: 'Change', x: ['Gain', 'Loss'], series: [{ key: 'v', label: 'Change', values: [10, -12.3456] }] })
    const zero = Number(container.querySelector('.chart-baseline')!.getAttribute('x1'))
    const path = container.querySelectorAll('.chart-bar-across')[1].getAttribute('d')!
    expect(Number(path.match(/^M([\d.]+)/)![1])).toBeLessThan(zero)
    fireEvent.keyDown(container.querySelector('svg')!, { key: 'End' })
    expect(container.querySelector('.card-chart-readout')?.textContent).toContain('-12.3456')
  })
  it('preserves exact values in readouts and the data table', () => {
    const { container, getByRole } = stage({ type: 'chart', form: 'line', title: 'Measurements', x: ['A', 'B'], series: [{ key: 'v', label: 'Measure', values: [0.0001234, 1234567] }] })
    fireEvent.keyDown(container.querySelector('svg')!, { key: 'Home' })
    expect(container.querySelector('.card-chart-readout')?.textContent).toContain('0.0001234')
    fireEvent.click(getByRole('button', { name: 'Show as table' }))
    expect(container.querySelector('.card-table')?.textContent).toContain('1234567')
    expect(container.querySelector('.card-table')?.textContent).toContain('0.0001234')
  })
  it('spaces observations by elapsed time, not array index', () => {
    const { container } = stage({ type: 'chart', form: 'line', title: 'Counts', x: ['2020', '2021', '2025'], positions: [2020, 2021, 2025], series: [{ key: 'count', label: 'Count', values: [2, 3, 4] }] })
    const ticks = [...container.querySelectorAll('.chart-x')].map((element) => Number(element.getAttribute('x')))
    expect(ticks).toHaveLength(3)
    expect((ticks[1] - ticks[0]) / (ticks[2] - ticks[0])).toBeCloseTo(0.2)
  })
  it('opens a readout with a touch pointer, with no hover required', () => {
    const { container } = stage({ type: 'chart', form: 'line', title: 'Counts', x: ['2020', '2025'], positions: [2020, 2025], series: [{ key: 'count', label: 'Count', values: [2, 4] }] })
    const event = new Event('pointerdown', { bubbles: true })
    Object.assign(event, { pointerType: 'touch', clientX: 40, clientY: 30 })
    fireEvent(container.querySelector('.card-chart-svg')!, event)
    expect(container.querySelector('.card-chart-readout')?.textContent).toContain('2020')
  })
})

describe('analytical chart interactions', () => {
  it('renders scatter points without connecting them and inspects repeated x coordinates by keyboard', () => {
    const { container } = stage({ type: 'chart', form: 'scatter', title: 'Score', xLabel: 'Hours', x: ['2', '4', '4'], positions: [2, 4, 4], series: [{ key: 'score', label: 'Score', values: [48, 68, 57] }] })
    expect(container.querySelectorAll('.chart-scatter-point')).toHaveLength(3)
    expect(container.querySelector('.chart-line')).toBeNull()
    fireEvent.keyDown(container.querySelector('svg')!, { key: 'End' })
    expect(container.querySelector('.card-chart-readout')?.textContent).toContain('57')
    fireEvent.keyDown(container.querySelector('svg')!, { key: 'ArrowLeft' })
    expect(container.querySelector('.card-chart-readout')?.textContent).toContain('68')
  })
  it('renders a constant histogram and its frequency table', () => {
    const { container, getByRole } = stage({ type: 'chart', form: 'histogram', title: 'Latency', x: ['5'], series: [{ key: 'count', label: 'Frequency', values: [3] }] })
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(1)
    fireEvent.click(getByRole('button', { name: 'Show as table' }))
    expect(container.querySelector('.card-table tbody')?.textContent).toContain('53')
  })
  it('shows missing heatmap cells differently from zero and supports cell selection', () => {
    const { container, getByRole } = stage({ type: 'chart', form: 'heatmap', title: 'Visits', xLabel: 'Day', yLabel: 'Team', x: ['Mon', 'Tue'], series: [{ key: 'a', label: 'Alpha', values: [0, 18] }, { key: 'b', label: 'Beta', values: [8, null] }] })
    expect(getByRole('button', { name: 'Alpha, Mon: 0' }).textContent).toBe('0')
    const missing = getByRole('button', { name: 'Beta, Tue: no value' })
    expect(missing.textContent).toBe('—')
    fireEvent.click(missing)
    expect(container.querySelector('.chart-heatmap-selection')?.textContent).toContain('Beta · Tue: no value')
    fireEvent.click(getByRole('button', { name: 'Show as table' }))
    expect(container.querySelector('.card-table tbody')?.textContent).toContain('Tue18—')
  })
})

describe('a line chart', () => {
  it('breaks the line at a gap, and marks a value stranded between gaps with a dot', () => {
    const { container } = stage({
      type: 'chart',
      form: 'line',
      title: 'Passengers',
      x: years,
      series: [{ key: 'p', label: 'Passengers', values: [4.2, 4.4, null, 2.6, null] }],
    })
    expect(container.querySelectorAll('.chart-line')).toHaveLength(1)
    // 2018 to 2019 is a line; 2021 on its own is a dot, beside its end marker.
    expect(container.querySelectorAll('.card-chart-svg circle:not(.chart-end)')).toHaveLength(1)
  })

  it('says what the line does in words, from its values', () => {
    const { container } = stage({
      type: 'chart',
      form: 'line',
      title: 'Passengers',
      unit: 'M',
      x: years,
      series: [{ key: 'p', label: 'Passengers', values: [3.1, 4.4, 1.9, 3.5, 4.9] }],
    })
    expect(container.querySelector('.card-chart-summary')?.textContent).toBe(
      'Rose from 3.1 M in 2018 to 4.9 M in 2022, with a low of 1.9 M in 2020.',
    )
    expect(container.querySelector('.card-chart-svg')?.getAttribute('aria-label')).toContain('Rose from 3.1 M')
  })

  it('gives two series a legend, and reads both values at a position from the keyboard', () => {
    const { container } = stage({
      type: 'chart',
      form: 'line',
      title: 'Passengers',
      unit: 'M',
      x: years,
      series: [
        { key: 'ferry', label: 'Ferry', values: [3.1, 3.3, 1.9, 2.6, 3.5] },
        { key: 'tram', label: 'Tram', values: [5, 5.2, 3, 4.1, 5.4] },
      ],
    })
    expect([...container.querySelectorAll('.card-chart-legend li')].map((item) => item.textContent)).toEqual(['Ferry', 'Tram'])
    const svg = container.querySelector('.card-chart-svg')!
    fireEvent.keyDown(svg, { key: 'End' })
    const readout = container.querySelector('.card-chart-readout')!
    expect(readout.textContent).toContain('2022')
    expect([...readout.querySelectorAll('b')].map((value) => value.textContent)).toEqual(['3.5 M', '5.4 M'])
    fireEvent.keyDown(svg, { key: 'ArrowLeft' })
    expect(container.querySelector('.card-chart-readout')?.textContent).toContain('2021')
    fireEvent.keyDown(svg, { key: 'Escape' })
    expect(container.querySelector('.card-chart-readout')).toBeNull()
  })

  it('shows the same values as a table, with a gap as a dash', () => {
    const { container, getByRole } = stage({
      type: 'chart',
      form: 'line',
      title: 'Passengers',
      xLabel: 'Year',
      x: years,
      series: [{ key: 'p', label: 'Passengers', values: [3.1, 4.4, null, 3.5, 4.9] }],
    })
    fireEvent.click(getByRole('button', { name: 'Show as table' }))
    const rows = [...container.querySelectorAll('.card-table tbody tr')].map((row) =>
      [...row.children].map((cell) => cell.textContent),
    )
    expect(rows).toEqual([
      ['2018', '3.1'],
      ['2019', '4.4'],
      ['2020', '—'],
      ['2021', '3.5'],
      ['2022', '4.9'],
    ])
    expect(container.querySelector('.card-chart-svg')).toBeNull()

    // And back: the chart is drawn again, not left as an empty well.
    fireEvent.click(getByRole('button', { name: 'Show as chart' }))
    expect(container.querySelector('.card-chart-svg')).not.toBeNull()
    expect(container.querySelectorAll('.chart-line').length).toBeGreaterThan(0)
  })
})

describe('bars', () => {
  it('starts columns at zero, and labels each one when there are few', () => {
    const { container } = stage({
      type: 'chart',
      form: 'column',
      title: 'Chance of rain',
      unit: '%',
      x: ['Mon', 'Tue', 'Wed'],
      series: [{ key: 'rain', label: 'Rain', values: [10, 60, 30] }],
    })
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(3)
    expect([...container.querySelectorAll('.chart-value')].map((label) => label.textContent)).toEqual(['10', '60', '30'])
    expect(container.querySelector('.chart-grid line[data-zero="true"]')).not.toBeNull()
  })

  it('ranks bars across, each category and value set in ink', () => {
    const { container } = stage({
      type: 'chart',
      form: 'bar',
      title: 'Busiest routes',
      x: ['Harbour', 'North Quay', 'Station'],
      series: [{ key: 'p', label: 'Passengers', values: [4.9, 3.2, 2.6] }],
    })
    expect([...container.querySelectorAll('.chart-category')].map((label) => label.textContent)).toEqual([
      'Harbour',
      'North Quay',
      'Station',
    ])
    expect(container.querySelectorAll('.chart-bar-across')).toHaveLength(3)
  })

  it('draws a low and a high at each point as one capsule, without a legend', () => {
    const { container } = stage({
      type: 'chart',
      form: 'range',
      title: 'Temperature',
      unit: '°C',
      x: ['Sat', 'Sun'],
      series: [
        { key: 'low', label: 'Low', values: [18, 17] },
        { key: 'high', label: 'High', values: [27, 25] },
      ],
    })
    expect(container.querySelectorAll('rect.chart-bar')).toHaveLength(2)
    expect(container.querySelector('.card-chart-legend')).toBeNull()
  })
})
