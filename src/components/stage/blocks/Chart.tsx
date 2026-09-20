import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  formatNumber,
  labelIndices,
  niceScale,
  summarizeChart,
  withUnit,
  type Scale,
} from '../../../lib/cards/chart-math'
import { SERIES } from '../../../lib/cards/palette'
import type { CardSize, CardSource, ChartBlock, ChartSeries, TableBlock } from '../../../lib/cards/schema'
import { rise } from '../stagger'
import { Table } from './Table'
import { useWidth } from './useWidth'
import { isAdvancedForm } from '../../../lib/cards/advanced-types'
import { advancedHeight, advancedTableOf } from '../../../lib/cards/advanced-layout'
import { AdvancedPlot } from './AdvancedPlot'

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
  sources?: CardSource[]
  sourceTable?: TableBlock
  details?: boolean
}

export function Chart({ block: sourceBlock, start, size, front, shared = false, said, sources = [], sourceTable, details = false }: ChartProps) {
  const [figure, width] = useWidth(FALLBACK_WIDTH)
  const [asTable, setAsTable] = useState(false)
  const [focus, setFocus] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [selection, setSelection] = useState<{ source: ChartBlock; from: number; to: number } | null>(null)
  const canSelectDates = ['line', 'area', 'band', 'small-multiples', 'editorial', 'calendar'].includes(sourceBlock.form) && Boolean(sourceBlock.positions) && sourceBlock.x.length > 2 && sourceBlock.x.every((label) => /^\d{4}(?:-\d{2}-\d{2})?$/.test(label))
  const from = selection?.source === sourceBlock ? selection.from : 0
  const to = selection?.source === sourceBlock ? selection.to : sourceBlock.x.length - 1
  const filtered = canSelectDates && (from !== 0 || to !== sourceBlock.x.length - 1)
  const block = useMemo(() => filtered ? {
    ...sourceBlock,
    x: sourceBlock.x.slice(from, to + 1),
    positions: sourceBlock.positions?.slice(from, to + 1),
    series: sourceBlock.series.map((series) => ({ ...series, values: series.values.slice(from, to + 1) })),
    marks: sourceBlock.marks?.filter((mark) => mark.at >= from && mark.at <= to).map((mark) => ({ ...mark, at: mark.at - from })),
    analysis: sourceBlock.analysis ? { ...sourceBlock.analysis, ...(sourceBlock.analysis.annotations ? { annotations: sourceBlock.analysis.annotations.slice(from, to + 1) } : {}) } : undefined,
    summary: undefined,
  } : sourceBlock, [sourceBlock, filtered, from, to])
  const visibleSaid = filtered && said ? new Set([...said].filter((index) => index >= from && index <= to).map((index) => index - from)) : said
  const focusCount = block.form === 'heatmap' ? block.x.length * block.series.length : block.x.length
  const activeFocus = focus !== null && focus < focusCount ? focus : null
  const selectDates = (nextFrom: number, nextTo: number) => {
    setFocus(null)
    setSelection({ source: sourceBlock, from: nextFrom, to: nextTo })
  }
  const hasValues = block.series.some((series) => series.values.some((value) => value !== null))
  const summary = hasValues ? block.summary || summarizeChart(block) : 'No observations are available in the selected period.'
  const legend = block.series.length > 1 && block.form !== 'range' && block.form !== 'heatmap' && !isAdvancedForm(block.form)

  return (
    <figure className="card-chart" data-form={block.form} style={rise(start)} ref={figure}>
      <figcaption className="card-chart-head">
        <span className="card-chart-title">
          {block.title}
          {block.unit ? <small>{block.unit}</small> : null}
        </span>
        {block.asOf ? <small className="card-chart-asof">{block.asOf}</small> : null}
        {!details && front ? <button type="button" className="card-chart-view" onClick={() => setExpanded(true)}>Expand chart</button> : null}
      </figcaption>

      {canSelectDates ? <div className="card-chart-controls">
        <label>From <select aria-label="Start date" value={from} onChange={(event) => selectDates(Number(event.target.value), to)}>
          {sourceBlock.x.slice(0, to).map((label, index) => <option key={index} value={index}>{label}</option>)}
        </select></label>
        <label>To <select aria-label="End date" value={to} onChange={(event) => selectDates(from, Number(event.target.value))}>
          {sourceBlock.x.map((label, index) => index > from ? <option key={index} value={index}>{label}</option> : null)}
        </select></label>
        {filtered ? <button type="button" className="card-chart-view" onClick={() => selectDates(0, sourceBlock.x.length - 1)}>Reset dates</button> : null}
      </div> : null}
      {filtered ? <p className="card-chart-summary" role="status">Showing {block.x.length} of {sourceBlock.x.length} captured observations: {block.x[0]} to {block.x[block.x.length - 1]}. Source data is unchanged.</p> : null}

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
          {!hasValues ? <p className="card-chart-summary" role="status">No values to plot. Choose another period or inspect the table.</p> : width === null ? null : (
            <Plot block={block} width={width} height={plotHeight(block, size, shared)} front={front} focus={activeFocus} onFocus={setFocus} summary={summary} said={visibleSaid} />
          )}
        </div>
      )}

      <div className="card-chart-foot">
        {summary ? <p className="card-chart-summary">{summary}</p> : <span />}
        <button type="button" className="card-chart-view" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
          {asTable ? 'Show as chart' : 'Show as table'}
        </button>
      </div>
      {expanded && front ? <ChartDetails block={block} sources={sources} sourceTable={sourceTable} onClose={() => setExpanded(false)} /> : null}
    </figure>
  )
}

/** A native modal supplies focus containment and Escape; the same captured values render larger. */
function ChartDetails({ block, sources, sourceTable, onClose }: { block: ChartBlock; sources: CardSource[]; sourceTable?: TableBlock; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement as HTMLElement | null
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    return () => {
      if (typeof element.close === 'function' && element.open) element.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return createPortal(<dialog ref={dialog} className="chart-details" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose() }}>
    <header><h2 id={titleId}>{block.title}</h2><button type="button" className="card-chart-view" onClick={onClose} autoFocus>Close details</button></header>
    <Chart block={block} start={0} size="feature" front details />
    {sourceTable ? <section><h3>Original source table</h3><Table block={sourceTable} start={0} /></section> : null}
    {sources.length ? <section><h3>Sources</h3><ul>{sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></li>)}</ul></section> : null}
  </dialog>, document.body)
}

/** Ranked bars take a row each; everything else is as tall as its card's size allows. */
function plotHeight(block: ChartBlock, size: CardSize, shared: boolean): number {
  if (isAdvancedForm(block.form)) return advancedHeight(block)
  if (block.form === 'bar') return BAR_TOP * 2 + block.x.length * BAR_ROW
  if (block.form === 'heatmap') return 48 + block.series.length * 34
  return shared ? Math.round(HEIGHT[size] * 0.7) : HEIGHT[size]
}

/** The chart's values as a table: the same numbers, reachable without a pointer. */
function tableOf(block: ChartBlock): TableBlock {
  if (isAdvancedForm(block.form)) return advancedTableOf(block)
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
          return value === null ? { text: '' } : { text: String(value), value }
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
  if (isAdvancedForm(props.block.form)) return <AdvancedPlot {...props} />
  if (props.block.form === 'heatmap') return <HeatmapPlot {...props} />
  return props.block.form === 'bar' ? <BarPlot {...props} /> : <AxisPlot {...props} />
}

function HeatmapPlot({ block, front, focus, onFocus }: PlotProps) {
  const values = block.series.flatMap((series) => series.values.filter((value): value is number => value !== null))
  const low = Math.min(...values)
  const high = Math.max(...values)
  return (
    <div className="chart-heatmap">
      <table aria-label={`${block.title}: ${block.yLabel ?? 'rows'} by ${block.xLabel ?? 'columns'}`}>
        <thead><tr><th scope="col">{block.yLabel ?? ''} / {block.xLabel ?? ''}</th>{block.x.map((label, index) => <th key={index} scope="col">{label}</th>)}</tr></thead>
        <tbody>{block.series.map((series, row) => <tr key={series.key}>
          <th scope="row">{series.label}</th>
          {series.values.map((value, column) => {
            const index = row * block.x.length + column
            const label = `${series.label}, ${block.x[column]}: ${value === null ? 'no value' : withUnit(String(value), block.unit)}`
            const alpha = value === null ? 0 : high === low ? 0.45 : 0.12 + 0.53 * (value - low) / (high - low)
            return <td key={column}><button type="button" tabIndex={front ? 0 : -1} aria-label={label} aria-pressed={focus === index} onFocus={() => onFocus(index)} onClick={() => onFocus(index)} style={{ background: `rgba(57,135,229,${alpha})` }}>{value === null ? '—' : String(value)}</button></td>
          })}
        </tr>)}</tbody>
      </table>
      <p className="chart-heatmap-scale">Light to dark: {withUnit(String(low), block.unit)} to {withUnit(String(high), block.unit)}. — no value.</p>
      {focus !== null ? <p className="chart-heatmap-selection" aria-live="polite">{block.series[Math.floor(focus / block.x.length)]?.label} · {block.x[focus % block.x.length]}: {block.series[Math.floor(focus / block.x.length)]?.values[focus % block.x.length] == null ? 'no value' : withUnit(String(block.series[Math.floor(focus / block.x.length)].values[focus % block.x.length]), block.unit)}</p> : null}
    </div>
  )
}

/** Lines, an area, columns or ranges over x positions, against a y-axis. */
function AxisPlot({ block, width, height, front, focus, onFocus, summary, said }: PlotProps) {
  const { form, x, series } = block
  const columns = form === 'column' || form === 'histogram'
  const values = series.flatMap((each) => each.values.filter((value): value is number => value !== null))
  const scale = niceScale(Math.min(...values), Math.max(...values), { zero: form === 'area' || columns })
  const tickText = scale.ticks.map((tick) => formatNumber(tick, scale.decimals))

  const endLabels = form === 'line' && series.length > 1 && series.length <= 4 && width >= 500 && series.every((each) => each.label.length <= 24)
  const left = Math.ceil(Math.max(...tickText.map((label) => label.length)) * CHAR) + 14
  const right = endLabels ? Math.ceil(Math.max(...series.map((each) => each.label.length)) * 6.6) + 22 : 18
  const top = 16
  // A label set under its mark needs a line of room above the day or year labels.
  const labelsBelow =
    (form === 'range' && rangeLabelled(block)) || (columns && columnLabelled(block) && values.some((value) => value < 0))
  const bottom = form === 'scatter' ? 46 : labelsBelow ? 42 : 26
  const plotWidth = Math.max(40, width - left - right)
  const plotHeight = Math.max(40, height - top - bottom)
  const banded = columns || form === 'range'
  const band = plotWidth / x.length
  const positions = block.positions
  const xScale = form === 'scatter' && positions ? niceScale(Math.min(...positions), Math.max(...positions), { maxTicks: width < 400 ? 3 : 5 }) : null
  const xAt = (index: number) =>
    xScale && positions ? left + ((positions[index] - xScale.min) / (xScale.max - xScale.min || 1)) * plotWidth : banded ? left + band * (index + 0.5) : positions
      ? left + ((positions[index] - positions[0]) / (positions[positions.length - 1] - positions[0])) * plotWidth
      : left + (x.length === 1 ? plotWidth / 2 : (index / (x.length - 1)) * plotWidth)
  const yAt = (value: number) => top + (1 - (value - scale.min) / (scale.max - scale.min || 1)) * plotHeight
  const candidates = labelIndices(x, plotWidth)
  // Irregular dates can be close together despite being far apart in the array.
  const shownLabels = positions && form !== 'scatter' ? candidates.filter((index, slot) => {
    if (slot === 0 || slot === candidates.length - 1) return true
    const previous = candidates[slot - 1]
    const next = candidates[slot + 1]
    const room = (other: number) => (x[index].length + x[other].length) * CHAR / 2 + 14
    return xAt(index) - xAt(previous) >= room(previous) && xAt(next) - xAt(index) >= room(next)
  }) : candidates

  const nearest = (clientX: number, box: DOMRect, clientY: number) => {
    const local = (clientX - box.left) * (box.width ? width / box.width : 1) - left
    if (form === 'scatter') {
      const px = (clientX - box.left) * (box.width ? width / box.width : 1)
      const py = (clientY - box.top) * (box.height ? height / box.height : 1)
      const distance = (index: number) => (xAt(index) - px) ** 2 + (yAt(series[0].values[index]!) - py) ** 2
      return x.reduce((best, _, index) => distance(index) < distance(best) ? index : best, 0)
    }
    if (positions) return positions.reduce((best, _, index) => Math.abs(xAt(index) - left - local) < Math.abs(xAt(best) - left - local) ? index : best, 0)
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
      ) : form === 'scatter' ? (
        <g>{series[0].values.map((value, index) => value === null ? null : <circle key={index} className="chart-scatter-point" cx={xAt(index)} cy={yAt(value)} r={focus === index ? 6 : 4} fill={SERIES[0]} stroke={RING} strokeWidth={1.5} />)}</g>
      ) : columns ? (
        <Columns block={block} xAt={xAt} yAt={yAt} band={band} zero={yAt(0)} />
      ) : (
        <Ranges block={block} xAt={xAt} yAt={yAt} band={band} />
      )}

      <Marks block={block} xAt={xAt} yAt={yAt} top={top} />

      {said?.size ? <Said block={block} said={said} xAt={xAt} yAt={yAt} top={top} height={plotHeight} band={band} banded={banded} /> : null}

      {xScale ? xScale.ticks.map((tick, index) => <text key={tick} className="chart-x" x={left + (tick - xScale.min) / (xScale.max - xScale.min || 1) * plotWidth} y={height - 25} textAnchor={index === 0 ? 'start' : index === xScale.ticks.length - 1 ? 'end' : 'middle'}>{formatNumber(tick, xScale.decimals)}</text>) : shownLabels.map((index) => (
        <text key={index} className="chart-x" x={xAt(index)} y={height - 8} textAnchor={xAnchor(index, x.length, banded)}>
          {x[index]}
        </text>
      ))}
      {form === 'scatter' ? <text className="chart-x" x={left + plotWidth / 2} y={height - 6} textAnchor="middle">{block.xLabel}{block.xUnit && !block.xLabel?.includes(block.xUnit) ? ` (${block.xUnit})` : ''}</text> : null}
    </Interactive>
  )
}

function xAnchor(index: number, count: number, banded: boolean): 'start' | 'middle' | 'end' {
  if (banded || count === 1) return 'middle'
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
  const ends = block.series.flatMap((series, seriesIndex) => {
    if (series.values.every((value) => value === null)) return []
    const last = lastValueAt(series.values)
    return [{ series, seriesIndex, index: last, y: yAt(series.values[last] as number) }]
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
      {ends.map(({ series, seriesIndex, index, y }) => (
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
  const barWidth = block.form === 'histogram' ? Math.max(2, band - 1) : Math.max(2, Math.min(24, (band * 0.72 - (count - 1) * gap) / count))
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
  const scale = niceScale(Math.min(...defined, 0), Math.max(...defined, 0), { zero: true })
  const valueAt = (value: number) => barLeft + (value - scale.min) / (scale.max - scale.min || 1) * barRoom
  const zero = valueAt(0)
  const length = (value: number) => Math.abs(valueAt(value) - zero)
  const labelChars = Math.max(3, Math.floor((labelWidth - 18) / 6.8))

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
      readout={focus === null ? null : <Readout block={block} index={focus} x={width / 2} width={width} />}
    >
      <line className="chart-baseline" x1={zero} x2={zero} y1={top} y2={height - top} />
      {block.x.map((label, index) => {
        const value = series.values[index]
        const y = top + index * rowHeight
        return (
          <g key={index} data-focus={focus === index ? 'true' : undefined} data-said={said?.has(index) ? 'true' : undefined}>
            {focus === index ? <rect className="chart-band" x={0} y={y} width={width} height={rowHeight} /> : null}
            <text className="chart-category" x={barLeft - 10} y={y + rowHeight / 2 + 4} textAnchor="end">
              {label.length > labelChars ? `${label.slice(0, labelChars - 1)}…` : label}
            </text>
            {value === null ? null : (
              <>
                <path
                  className="chart-bar chart-bar-across"
                  d={barAcross(Math.min(zero, valueAt(value)), y + (rowHeight - 16) / 2, length(value), 16)}
                  fill={SERIES[0]}
                  style={{ '--k': index } as CSSProperties}
                />
                <text className="chart-value" x={barLeft + barRoom + 8} y={y + rowHeight / 2 + 4}>
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
        onPointerDown={(event) => {
          if (front && event.pointerType === 'touch') onFocus(locate(event.clientX, event.currentTarget.getBoundingClientRect(), event.clientY))
        }}
        onPointerLeave={(event) => { if (event.pointerType !== 'touch') onFocus(null) }}
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
            text: value === null ? 'no value' : withUnit(String(value), block.unit),
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
    `${String(low)} to ${String(high)}`,
    block.unit,
  )
}
