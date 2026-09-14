import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import {
  formatNumber,
  labelIndices,
  niceScale,
  summarizeChart,
  withUnit,
  type Scale,
} from '../../../lib/cards/chart-math'
import { SERIES } from '../../../lib/cards/palette'
import type { CardSize, ChartBlock, ChartSeries, TableBlock } from '../../../lib/cards/schema'
import { rise } from '../stagger'
import { Table } from './Table'

/**
 * A chart in a well.
 *
 * Drawn to one scale in the card's own pixels, so its text stays sharp at any
 * size. Lines are straight between their points: a smoothed curve invents
 * values between the ones that exist. Bars start at zero, a missing value is a
 * gap rather than a zero, the axis sits on round numbers, and series take the
 * palette's colours in its fixed order.
 *
 * Nothing is only readable by hovering: the readout under the pointer (or the
 * arrow keys) repeats what the table view shows in full, and the summary under
 * the chart says what the line does in words.
 */

const HEIGHT: Record<CardSize, number> = { glance: 132, standard: 200, wide: 236, feature: 296 }
/** Ranked bars: the height of each row, and the space above the first and below the last. */
const BAR_ROW = 28
const BAR_TOP = 6
/** A standard card's chart width on a wide screen, for when there is no layout to measure. */
const FALLBACK_WIDTH = 560
/** A mono character at the axis size, for measuring labels before they are drawn. */
const CHAR = 6.4
const RING = '#0b0e15'

interface ChartProps {
  block: ChartBlock
  start: number
  size: CardSize
  front: boolean
  /** The card has other data under the chart, a table say, so the chart gives up some height to it. */
  shared?: boolean
  /** Positions on the axis GIDEON has just mentioned, which light up. */
  said?: Set<number>
}

/**
 * The width a chart has to draw in, in pixels, or null before it is known.
 *
 * Read once, synchronously, before the first paint, and then kept current by
 * an observer. The first read cannot be left to the observer: a page that is
 * not visible (a background tab, a hidden pane) runs no rendering steps, so
 * the observer never reports, and a chart drawn at a guessed width would stay
 * at that width until someone looked at it. It measures the figure, which is
 * always there, rather than the well, which is swapped for a table and back.
 */
function useWidth() {
  const ref = useRef<HTMLElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const settle = (next: number) => {
      const rounded = Math.round(next)
      if (rounded > 0) setWidth((current) => (current !== null && Math.abs(current - rounded) < 2 ? current : rounded))
    }
    // Nothing laid out yet (no layout engine at all, or an element not yet
    // displayed) measures zero; the chart draws at a likely width and the
    // observer corrects it once there is something to measure.
    settle(node.clientWidth || FALLBACK_WIDTH)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => settle(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

export function Chart({ block, start, size, front, shared = false, said }: ChartProps) {
  const [figure, width] = useWidth()
  const [asTable, setAsTable] = useState(false)
  const [focus, setFocus] = useState<number | null>(null)
  const summary = block.summary || summarizeChart(block)
  const legend = block.series.length > 1 && block.form !== 'range'

  return (
    <figure className="card-chart" data-form={block.form} style={rise(start)} ref={figure}>
      <figcaption className="card-chart-head">
        <span className="card-chart-title">
          {block.title}
          {block.unit ? <small>{block.unit}</small> : null}
        </span>
        {block.asOf ? <small className="card-chart-asof">{block.asOf}</small> : null}
      </figcaption>

      {legend ? (
        <ul className="card-chart-legend">
          {block.series.map((series, index) => (
            <li key={series.key}>
              <i data-key={block.form === 'column' ? 'box' : 'line'} style={{ background: SERIES[index] }} />
              {series.label}
            </li>
          ))}
        </ul>
      ) : null}

      {asTable ? (
        <Table block={tableOf(block)} start={0} />
      ) : (
        <div className="card-well card-chart-well" style={{ minHeight: plotHeight(block, size, shared) + 4 }}>
          {width === null ? null : (
            <Plot block={block} width={width} height={plotHeight(block, size, shared)} front={front} focus={focus} onFocus={setFocus} summary={summary} said={said} />
          )}
        </div>
      )}

      <div className="card-chart-foot">
        {summary ? <p className="card-chart-summary">{summary}</p> : <span />}
        <button type="button" className="card-chart-view" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
          {asTable ? 'Show as chart' : 'Show as table'}
        </button>
      </div>
    </figure>
  )
}

/** Ranked bars take a row each; everything else is as tall as its card's size allows. */
function plotHeight(block: ChartBlock, size: CardSize, shared: boolean): number {
  if (block.form === 'bar') return BAR_TOP * 2 + block.x.length * BAR_ROW
  return shared ? Math.round(HEIGHT[size] * 0.7) : HEIGHT[size]
}

/** The chart's values as a table: the same numbers, reachable without a pointer. */
function tableOf(block: ChartBlock): TableBlock {
  const isRange = block.form === 'range'
  return {
    id: 'chart-table',
    slot: 'body',
    type: 'table',
    rowHeaders: true,
    columns: [
      { key: 'x', label: block.xLabel ?? '', kind: 'text' },
      ...block.series.map((series) => ({
        key: series.key,
        label: isRange ? series.label : series.label || block.title,
        kind: 'number' as const,
        ...(block.unit ? { unit: block.unit } : {}),
      })),
    ],
    rows: block.x.map((label, index) => ({
      id: `${index}`,
      cells: [
        { text: label },
        ...block.series.map((series) => {
          const value = series.values[index]
          return value === null ? { text: '' } : { text: formatNumber(value, decimalsOf(series)), value }
        }),
      ],
    })),
  }
}

function decimalsOf(series: ChartSeries): number {
  let decimals = 0
  for (const value of series.values) {
    if (value === null) continue
    decimals = Math.max(decimals, Math.min(2, (String(value).split('.')[1] ?? '').length))
  }
  return decimals
}

interface PlotProps {
  block: ChartBlock
  width: number
  height: number
  front: boolean
  focus: number | null
  onFocus: (index: number | null) => void
  summary: string
  said?: Set<number>
}

function Plot(props: PlotProps) {
  return props.block.form === 'bar' ? <BarPlot {...props} /> : <AxisPlot {...props} />
}

/** Lines, an area, columns or ranges over x positions, against a y-axis. */
function AxisPlot({ block, width, height, front, focus, onFocus, summary, said }: PlotProps) {
  const { form, x, series } = block
  const values = series.flatMap((each) => each.values.filter((value): value is number => value !== null))
  const scale = niceScale(Math.min(...values), Math.max(...values), { zero: form === 'area' || form === 'column' })
  const tickText = scale.ticks.map((tick) => formatNumber(tick, scale.decimals))

  const endLabels = form === 'line' && series.length > 1 && series.length <= 4
  const left = Math.ceil(Math.max(...tickText.map((label) => label.length)) * CHAR) + 14
  const right = endLabels ? Math.ceil(Math.max(...series.map((each) => each.label.length)) * 6.6) + 22 : 18
  const top = 16
  // A label set under its mark needs a line of room above the day or year labels.
  const labelsBelow =
    (form === 'range' && rangeLabelled(block)) || (form === 'column' && columnLabelled(block) && values.some((value) => value < 0))
  const bottom = labelsBelow ? 42 : 26
  const plotWidth = Math.max(40, width - left - right)
  const plotHeight = Math.max(40, height - top - bottom)
  const banded = form === 'column' || form === 'range'
  const band = plotWidth / x.length
  const xAt = (index: number) =>
    banded ? left + band * (index + 0.5) : left + (x.length === 1 ? plotWidth / 2 : (index / (x.length - 1)) * plotWidth)
  const yAt = (value: number) => top + (1 - (value - scale.min) / (scale.max - scale.min || 1)) * plotHeight
  const shownLabels = labelIndices(x, plotWidth)

  const nearest = (clientX: number, box: DOMRect) => {
    const local = clientX - box.left - left
    const index = banded ? Math.floor(local / band) : Math.round((local / plotWidth) * (x.length - 1))
    return Math.max(0, Math.min(x.length - 1, index))
  }

  return (
    <Interactive
      width={width}
      height={height}
      front={front}
      label={`${block.title}. ${summary}`}
      count={x.length}
      focus={focus}
      onFocus={onFocus}
      locate={nearest}
      readout={focus === null ? null : <Readout block={block} index={focus} x={xAt(focus)} width={width} />}
    >
      <Grid scale={scale} tickText={tickText} left={left} right={width - right} yAt={yAt} />

      {focus !== null && !banded ? (
        <line className="chart-cross" x1={xAt(focus)} x2={xAt(focus)} y1={top} y2={top + plotHeight} />
      ) : null}
      {focus !== null && banded ? (
        <rect className="chart-band" x={xAt(focus) - band / 2} y={top} width={band} height={plotHeight} />
      ) : null}

      {form === 'line' || form === 'area' ? (
        <Lines block={block} xAt={xAt} yAt={yAt} baseline={yAt(Math.max(scale.min, Math.min(0, scale.max)))} endLabels={endLabels} focus={focus} />
      ) : form === 'column' ? (
        <Columns block={block} xAt={xAt} yAt={yAt} band={band} zero={yAt(0)} />
      ) : (
        <Ranges block={block} xAt={xAt} yAt={yAt} band={band} />
      )}

      <Marks block={block} xAt={xAt} yAt={yAt} top={top} />

      {said?.size ? <Said block={block} said={said} xAt={xAt} yAt={yAt} top={top} height={plotHeight} band={band} banded={banded} /> : null}

      {shownLabels.map((index) => (
        <text key={index} className="chart-x" x={xAt(index)} y={height - 8} textAnchor={xAnchor(index, x.length, banded)}>
          {x[index]}
        </text>
      ))}
    </Interactive>
  )
}

function xAnchor(index: number, count: number, banded: boolean): 'start' | 'middle' | 'end' {
  if (banded || count < 3) return 'middle'
  return index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle'
}

function Grid({ scale, tickText, left, right, yAt }: { scale: Scale; tickText: string[]; left: number; right: number; yAt: (value: number) => number }) {
  return (
    <g className="chart-grid">
      {scale.ticks.map((tick, index) => (
        <g key={tick}>
          <line x1={left} x2={right} y1={yAt(tick)} y2={yAt(tick)} data-zero={tick === 0 ? 'true' : undefined} />
          <text x={left - 8} y={yAt(tick) + 3.5} textAnchor="end">
            {tickText[index]}
          </text>
        </g>
      ))}
    </g>
  )
}

/** The position of the last value a series has. */
function lastValueAt(values: Array<number | null>): number {
  for (let index = values.length - 1; index >= 0; index -= 1) if (values[index] !== null) return index
  return 0
}

/** Contiguous runs of values, so a gap in the data is a gap in the line. */
function runs(values: Array<number | null>): number[][] {
  const out: number[][] = []
  let current: number[] = []
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) out.push(current)
      current = []
    } else current.push(index)
  })
  if (current.length) out.push(current)
  return out
}

function Lines({
  block,
  xAt,
  yAt,
  baseline,
  endLabels,
  focus,
}: {
  block: ChartBlock
  xAt: (index: number) => number
  yAt: (value: number) => number
  baseline: number
  endLabels: boolean
  focus: number | null
}) {
  const ends = block.series.map((series) => {
    const last = lastValueAt(series.values)
    return { series, index: last, y: yAt(series.values[last] as number) }
  })
  // End labels only when they would not run into each other; the legend carries them otherwise.
  const sortedY = ends.map((end) => end.y).sort((a, b) => a - b)
  const labelsFit = endLabels && sortedY.every((y, index) => index === 0 || y - sortedY[index - 1] >= 13)

  return (
    <g>
      {block.series.map((series, seriesIndex) => {
        const color = SERIES[seriesIndex]
        return (
          <g key={series.key}>
            {runs(series.values).map((run, runIndex) => {
              const d = run.map((index, at) => `${at ? 'L' : 'M'}${xAt(index).toFixed(1)},${yAt(series.values[index] as number).toFixed(1)}`).join('')
              return (
                <g key={runIndex}>
                  {block.form === 'area' ? (
                    <path
                      className="chart-area"
                      d={`${d}L${xAt(run[run.length - 1]).toFixed(1)},${baseline.toFixed(1)}L${xAt(run[0]).toFixed(1)},${baseline.toFixed(1)}Z`}
                      fill={color}
                    />
                  ) : null}
                  {run.length > 1 ? (
                    <path className="chart-line" d={d} stroke={color} pathLength={1} />
                  ) : (
                    // A value with gaps either side has no line to be part of, so it is a dot.
                    <circle cx={xAt(run[0])} cy={yAt(series.values[run[0]] as number)} r={2.5} fill={color} />
                  )}
                </g>
              )
            })}
            {focus !== null && series.values[focus] !== null ? (
              <circle className="chart-dot" cx={xAt(focus)} cy={yAt(series.values[focus] as number)} r={4.5} fill={color} stroke={RING} strokeWidth={2} />
            ) : null}
          </g>
        )
      })}
      {ends.map(({ series, index, y }, seriesIndex) => (
        <g key={series.key}>
          <circle className="chart-end" cx={xAt(index)} cy={y} r={4} fill={SERIES[seriesIndex]} stroke={RING} strokeWidth={2} />
          {labelsFit ? (
            <text className="chart-end-label" x={xAt(index) + 9} y={y + 3.5}>
              {series.label}
            </text>
          ) : null}
        </g>
      ))}
    </g>
  )
}

/** One series of a dozen columns or fewer carries its values on the columns themselves. */
function columnLabelled(block: ChartBlock): boolean {
  return block.series.length === 1 && block.x.length <= 12
}

/** Ten ranges or fewer carry their low and high beside each capsule. */
function rangeLabelled(block: ChartBlock): boolean {
  return block.x.length <= 10
}

/** The data end of a bar is rounded; the end on the baseline is square. */
function barPath(x: number, from: number, to: number, width: number): string {
  const height = Math.abs(to - from)
  const radius = Math.min(4, width / 2, height)
  if (to <= from) {
    return `M${x},${from}V${to + radius}Q${x},${to} ${x + radius},${to}H${x + width - radius}Q${x + width},${to} ${x + width},${to + radius}V${from}Z`
  }
  return `M${x},${from}V${to - radius}Q${x},${to} ${x + radius},${to}H${x + width - radius}Q${x + width},${to} ${x + width},${to - radius}V${from}Z`
}

function Columns({
  block,
  xAt,
  yAt,
  band,
  zero,
}: {
  block: ChartBlock
  xAt: (index: number) => number
  yAt: (value: number) => number
  band: number
  zero: number
}) {
  const count = block.series.length
  const gap = 2
  const barWidth = Math.max(2, Math.min(24, (band * 0.72 - (count - 1) * gap) / count))
  const group = count * barWidth + (count - 1) * gap
  const labelled = columnLabelled(block)
  return (
    <g>
      {block.x.map((_, index) =>
        block.series.map((series, seriesIndex) => {
          const value = series.values[index]
          if (value === null) return null
          const x = xAt(index) - group / 2 + seriesIndex * (barWidth + gap)
          return (
            <g key={`${series.key}-${index}`}>
              <path
                className="chart-bar"
                d={barPath(x, zero, yAt(value), barWidth)}
                fill={SERIES[seriesIndex]}
                style={{ '--k': index } as CSSProperties}
              />
              {labelled ? (
                <text className="chart-value" x={x + barWidth / 2} y={value >= 0 ? yAt(value) - 6 : yAt(value) + 13} textAnchor="middle">
                  {formatNumber(value, decimalsOf(series))}
                </text>
              ) : null}
            </g>
          )
        }),
      )}
    </g>
  )
}

function Ranges({
  block,
  xAt,
  yAt,
  band,
}: {
  block: ChartBlock
  xAt: (index: number) => number
  yAt: (value: number) => number
  band: number
}) {
  const [lows, highs] = block.series
  const width = Math.max(4, Math.min(12, band * 0.5))
  const labelled = rangeLabelled(block)
  return (
    <g>
      {block.x.map((_, index) => {
        const low = lows.values[index]
        const high = highs.values[index]
        if (low === null || high === null) return null
        const top = yAt(Math.max(low, high))
        const bottom = yAt(Math.min(low, high))
        return (
          <g key={index}>
            <rect
              className="chart-bar"
              x={xAt(index) - width / 2}
              y={top}
              width={width}
              height={Math.max(width, bottom - top)}
              rx={width / 2}
              fill={SERIES[0]}
              style={{ '--k': index } as CSSProperties}
            />
            {labelled ? (
              <>
                <text className="chart-value" x={xAt(index)} y={top - 6} textAnchor="middle">
                  {formatNumber(Math.max(low, high), decimalsOf(highs))}
                </text>
                <text className="chart-value chart-value-low" x={xAt(index)} y={bottom + 14} textAnchor="middle">
                  {formatNumber(Math.min(low, high), decimalsOf(lows))}
                </text>
              </>
            ) : null}
          </g>
        )
      })}
    </g>
  )
}

/**
 * What GIDEON has just mentioned, marked on the chart: a ring on every line's
 * point at that position, or the band behind a column. The ring pulses once
 * as it appears and then stays, the way a finger stays on a line being read.
 */
function Said({
  block,
  said,
  xAt,
  yAt,
  top,
  height,
  band,
  banded,
}: {
  block: ChartBlock
  said: Set<number>
  xAt: (index: number) => number
  yAt: (value: number) => number
  top: number
  height: number
  band: number
  banded: boolean
}) {
  return (
    <g className="chart-said">
      {[...said].map((index) =>
        banded ? (
          <rect key={index} className="chart-said-band" x={xAt(index) - band / 2} y={top} width={band} height={height} />
        ) : (
          block.series.map((series, seriesIndex) => {
            const value = series.values[index]
            return value === null ? null : (
              <circle key={`${index}-${series.key}`} className="chart-said-ring" cx={xAt(index)} cy={yAt(value)} r={7} stroke={SERIES[seriesIndex]} />
            )
          })
        ),
      )}
    </g>
  )
}

function Marks({ block, xAt, yAt, top }: { block: ChartBlock; xAt: (index: number) => number; yAt: (value: number) => number; top: number }) {
  if (!block.marks?.length || block.form === 'range') return null
  return (
    <g className="chart-marks">
      {block.marks.map((mark) => {
        const series = block.series.find((each) => each.key === mark.series) ?? block.series[0]
        const value = series.values[mark.at]
        if (value === null) return null
        const y = yAt(value)
        const above = y - 12 > top + 8
        return (
          <g key={`${mark.at}-${mark.label}`}>
            <circle className="chart-mark" cx={xAt(mark.at)} cy={y} r={6.5} />
            <text className="chart-mark-label" x={xAt(mark.at)} y={above ? y - 12 : y + 20} textAnchor="middle">
              {mark.label}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/** Ranked bars, the largest first, each labelled at its tip. */
function BarPlot({ block, width, front, focus, onFocus, summary, said }: PlotProps) {
  const series = block.series[0]
  const rowHeight = BAR_ROW
  const top = BAR_TOP
  const height = top * 2 + block.x.length * rowHeight
  const decimals = decimalsOf(series)
  const valueText = series.values.map((value) => (value === null ? '' : formatNumber(value, decimals)))
  const labelWidth = Math.min(width * 0.42, Math.ceil(Math.max(...block.x.map((label) => label.length)) * 6.8) + 18)
  const valueWidth = Math.ceil(Math.max(...valueText.map((label) => label.length)) * CHAR) + 16
  const barLeft = labelWidth
  const barRoom = Math.max(30, width - barLeft - valueWidth - 10)
  const defined = series.values.filter((value): value is number => value !== null)
  const scale = niceScale(0, Math.max(...defined, 0), { zero: true })
  const length = (value: number) => (Math.max(0, value) / (scale.max || 1)) * barRoom

  return (
    <Interactive
      width={width}
      height={height}
      front={front}
      label={`${block.title}. ${summary}`}
      count={block.x.length}
      focus={focus}
      onFocus={onFocus}
      vertical
      locate={(_, box, clientY) => Math.max(0, Math.min(block.x.length - 1, Math.floor((clientY - box.top - top) / rowHeight)))}
      readout={null}
    >
      <line className="chart-baseline" x1={barLeft} x2={barLeft} y1={top} y2={height - top} />
      {block.x.map((label, index) => {
        const value = series.values[index]
        const y = top + index * rowHeight
        return (
          <g key={index} data-focus={focus === index ? 'true' : undefined} data-said={said?.has(index) ? 'true' : undefined}>
            {focus === index ? <rect className="chart-band" x={0} y={y} width={width} height={rowHeight} /> : null}
            <text className="chart-category" x={barLeft - 10} y={y + rowHeight / 2 + 4} textAnchor="end">
              {label}
            </text>
            {value === null ? null : (
              <>
                <path
                  className="chart-bar chart-bar-across"
                  d={barAcross(barLeft, y + (rowHeight - 16) / 2, length(value), 16)}
                  fill={SERIES[0]}
                  style={{ '--k': index } as CSSProperties}
                />
                <text className="chart-value" x={barLeft + length(value) + 8} y={y + rowHeight / 2 + 4}>
                  {valueText[index]}
                </text>
              </>
            )}
          </g>
        )
      })}
    </Interactive>
  )
}

function barAcross(x: number, y: number, length: number, thickness: number): string {
  const radius = Math.min(4, thickness / 2, length)
  return `M${x},${y}H${x + length - radius}Q${x + length},${y} ${x + length},${y + radius}V${y + thickness - radius}Q${x + length},${y + thickness} ${x + length - radius},${y + thickness}H${x}Z`
}

interface InteractiveProps {
  width: number
  height: number
  front: boolean
  label: string
  count: number
  focus: number | null
  onFocus: (index: number | null) => void
  locate: (clientX: number, box: DOMRect, clientY: number) => number
  readout: ReactNode
  vertical?: boolean
  children: ReactNode
}

/**
 * The drawing, and the ways to read a value off it: the pointer, which finds
 * the nearest position, and the arrow keys, which step through them. Only the
 * card in front takes either.
 */
function Interactive({ width, height, front, label, count, focus, onFocus, locate, readout, vertical, children }: InteractiveProps) {
  const move = (event: PointerEvent<SVGSVGElement>) => {
    if (!front || event.pointerType === 'touch') return
    onFocus(locate(event.clientX, event.currentTarget.getBoundingClientRect(), event.clientY))
  }
  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    const forward = vertical ? 'ArrowDown' : 'ArrowRight'
    const back = vertical ? 'ArrowUp' : 'ArrowLeft'
    let next: number | null = null
    if (event.key === forward) next = focus === null ? 0 : Math.min(count - 1, focus + 1)
    else if (event.key === back) next = focus === null ? count - 1 : Math.max(0, focus - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else if (event.key === 'Escape') onFocus(null)
    else return
    event.preventDefault()
    event.stopPropagation()
    if (next !== null) onFocus(next)
  }

  return (
    <>
      <svg
        className="card-chart-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        tabIndex={front ? 0 : -1}
        onPointerMove={move}
        onPointerLeave={() => onFocus(null)}
        onKeyDown={step}
        onBlur={() => onFocus(null)}
      >
        {children}
      </svg>
      {readout}
    </>
  )
}

/** Every series' value at one position, the value first and the name after it. */
function Readout({ block, index, x, width }: { block: ChartBlock; index: number; x: number; width: number }) {
  const place = Math.max(90, Math.min(width - 90, x))
  const rows =
    block.form === 'range'
      ? [{ key: 'range', label: `${block.series[0].label} to ${block.series[1].label}`, text: rangeText(block, index), color: SERIES[0] }]
      : block.series.map((series, seriesIndex) => {
          const value = series.values[index]
          return {
            key: series.key,
            label: block.series.length > 1 ? series.label : '',
            text: value === null ? 'no value' : withUnit(formatNumber(value, decimalsOf(series)), block.unit),
            color: SERIES[seriesIndex],
          }
        })
  return (
    <div className="card-chart-readout" style={{ left: place }} aria-live="polite">
      <span className="card-chart-readout-x">
        {block.xLabel ? `${block.xLabel} ` : ''}
        {block.x[index]}
      </span>
      {rows.map((row) => (
        <span key={row.key} className="card-chart-readout-row">
          <i style={{ background: row.color }} />
          <b>{row.text}</b>
          {row.label ? <small>{row.label}</small> : null}
        </span>
      ))}
    </div>
  )
}

function rangeText(block: ChartBlock, index: number): string {
  const [lows, highs] = block.series
  const low = lows.values[index]
  const high = highs.values[index]
  if (low === null || high === null) return 'no value'
  return withUnit(
    `${formatNumber(Math.min(low, high), decimalsOf(lows))} to ${formatNumber(Math.max(low, high), decimalsOf(highs))}`,
    block.unit,
  )
}
