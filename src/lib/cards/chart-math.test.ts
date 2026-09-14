import { describe, expect, it } from 'vitest'
import { formatNumber, labelIndices, niceScale, niceStep, summarize, summarizeChart, thin, withUnit } from './chart-math'

/** The arithmetic under a chart, where being wrong would be quiet and visible. */

describe('niceScale', () => {
  it('lands on round numbers that cover the values', () => {
    expect(niceScale(3.1, 4.9)).toMatchObject({ min: 3, max: 5, ticks: [3, 3.5, 4, 4.5, 5] })
    expect(niceScale(94.3, 128.1)).toMatchObject({ ticks: [90, 100, 110, 120, 130] })
  })

  it('keeps zero on the axis when a bar or an area needs it', () => {
    const scale = niceScale(1.9, 4.9, { zero: true })
    expect(scale.min).toBe(0)
    expect(scale.max).toBeGreaterThanOrEqual(4.9)
    expect(scale.ticks.length).toBeLessThanOrEqual(5)
  })

  it('never gives more than five ticks, and survives a flat line', () => {
    for (const [low, high] of [[0, 97], [0.001, 0.0093], [-40, 55], [1_234_567, 9_876_543]]) {
      expect(niceScale(low, high).ticks.length).toBeLessThanOrEqual(5)
    }
    const flat = niceScale(7, 7)
    expect(flat.min).toBeLessThan(7)
    expect(flat.max).toBeGreaterThan(7)
  })

  it('does not print floating point noise', () => {
    expect(niceScale(0.1, 0.7).ticks.every((tick) => String(tick).length <= 4)).toBe(true)
    expect(niceStep(0.3, 3)).toBe(0.1)
  })
})

describe('formatNumber', () => {
  it('groups, and goes compact once large', () => {
    expect(formatNumber(1234)).toBe('1,234')
    expect(formatNumber(3.5, 1)).toBe('3.5')
    expect(formatNumber(1_250_000)).toBe('1.3M')
  })
})

describe('labelIndices', () => {
  it('always shows the first and the last, and spaces the rest to fit', () => {
    const years = Array.from({ length: 64 }, (_, index) => String(1960 + index))
    const shown = labelIndices(years, 420)
    expect(shown[0]).toBe(0)
    expect(shown.at(-1)).toBe(63)
    expect(shown.length).toBeLessThanOrEqual(Math.floor(420 / (4 * 6.4 + 14)))
  })

  it('shows every label when there is room', () => {
    expect(labelIndices(['Mon', 'Tue', 'Wed'], 600)).toEqual([0, 1, 2])
  })
})

describe('summarize', () => {
  const years = ['2014', '2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025']

  it('says where a series started and ended, and a low worth mentioning', () => {
    expect(summarize(years, [3.1, 3.3, 3.6, 3.9, 4.2, 4.4, 1.9, 2.6, 3.5, 4.1, 4.5, 4.9], 'M')).toBe(
      'Rose from 3.1 M in 2014 to 4.9 M in 2025, with a low of 1.9 M in 2020.',
    )
  })

  it('mentions a peak in between, and skips a gap', () => {
    expect(summarize(['Mon', 'Tue', 'Wed', 'Thu'], [18, null, 27, 20], '°C')).toBe(
      'Rose from 18 °C in Mon to 20 °C in Thu, with a peak of 27 °C in Wed.',
    )
  })

  it('says nothing about fewer than two values', () => {
    expect(summarize(['a', 'b'], [1, null])).toBe('')
  })

  it('does not call a line flat when it ends where it started', () => {
    expect(summarize(['2019', '2020', '2021'], [4, 2, 4], 'M')).toBe('From 4 M in 2019 back to 4 M in 2021, with a low of 2 M in 2020.')
    expect(summarize(['2019', '2020', '2021'], [4, 4, 4], 'M')).toBe('Held at 4 M from 2019 to 2021.')
  })
})

describe('withUnit', () => {
  it('spaces a unit, except a percent sign', () => {
    expect(withUnit('18', '°C')).toBe('18 °C')
    expect(withUnit('70', '%')).toBe('70%')
    expect(withUnit('4.9')).toBe('4.9')
  })
})

describe('summarizeChart', () => {
  const days = ['Sat', 'Sun', 'Mon', 'Tue']

  it('reads columns as a comparison, on the days they fall on', () => {
    expect(
      summarizeChart({ form: 'column', x: days, xLabel: 'Day', unit: '%', series: [{ label: 'Rain', values: [5, 10, 70, 0] }] }),
    ).toBe('Highest on Mon at 70%, lowest on Tue at 0%.')
  })

  it('reads ranked bars by name', () => {
    expect(
      summarizeChart({ form: 'bar', x: ['Harbour', 'Castle'], unit: 'M', series: [{ label: 'Passengers', values: [4.9, 0.8] }] }),
    ).toBe('Harbour is highest at 4.9 M, and Castle lowest at 0.8 M.')
  })

  it('gives a range the span of its highs and of its lows, each in its own precision', () => {
    expect(
      summarizeChart({
        form: 'range',
        x: days,
        unit: '°C',
        series: [
          { label: 'Low', values: [18, 17, 15, 16] },
          { label: 'High', values: [27.5, 25, 22.5, 23] },
        ],
      }),
    ).toBe('Highs from 22.5 to 27.5 °C, lows from 15 to 18 °C.')
  })

  it('names the series it summarizes when a line has more than one, and at the hour for hours', () => {
    expect(
      summarizeChart({
        form: 'line',
        x: ['09:00', '12:00', '15:00'],
        xLabel: 'Hour',
        unit: '°C',
        series: [
          { label: 'Lisbon', values: [19, 24, 27] },
          { label: 'Porto', values: [17, 21, 24] },
        ],
      }),
    ).toBe('Lisbon: Rose from 19 °C at 09:00 to 27 °C at 15:00.')
  })

  it('says nothing when there is nothing to compare', () => {
    expect(summarizeChart({ form: 'column', x: ['Mon'], series: [{ label: 'Rain', values: [5] }] })).toBe('')
    expect(summarizeChart({ form: 'line', x: [], series: [] })).toBe('')
  })
})

describe('thin', () => {
  it('keeps the first, the last, the peak and the low', () => {
    const values = Array.from({ length: 1000 }, (_, index) => Math.sin(index / 40) * 10 + (index === 517 ? 50 : 0))
    values[733] = -80
    const kept = thin(values, 100)
    expect(kept.length).toBeLessThanOrEqual(100)
    expect(kept[0]).toBe(0)
    expect(kept.at(-1)).toBe(999)
    expect(kept).toContain(517)
    expect(kept).toContain(733)
    expect([...kept].sort((a, b) => a - b)).toEqual(kept)
  })

  it('leaves a short series alone', () => {
    expect(thin([1, 2, 3], 400)).toEqual([0, 1, 2])
  })
})
