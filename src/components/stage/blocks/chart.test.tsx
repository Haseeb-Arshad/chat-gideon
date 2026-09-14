// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
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
