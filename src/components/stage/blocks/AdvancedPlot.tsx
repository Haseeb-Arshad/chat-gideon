import type { ReactNode } from 'react'
import type { ChartBlock } from '../../../lib/cards/schema'
import { niceScale, formatNumber, withUnit } from '../../../lib/cards/chart-math'
import { advancedTableOf, flowLayout, treeLayout } from '../../../lib/cards/advanced-layout'
import { SERIES } from '../../../lib/cards/palette'

interface Props { block: ChartBlock; width: number; height: number; front: boolean; focus: number | null; onFocus: (index: number | null) => void; summary: string }
const color = (index: number) => SERIES[index % SERIES.length]
const short = (text: string, count = 18) => text.length > count ? `${text.slice(0, count - 1)}…` : text
const numbers = (block: ChartBlock) => block.series.flatMap((s) => s.values.filter((v): v is number => v !== null))
const dateLabel = (value: number) => new Date(value).toISOString().slice(0, 10)

export function AdvancedPlot({ block: b, width, height, front, focus, onFocus, summary }: Props) {
  const { form, x, series, analysis: a = {} } = b
  const left = Math.min(130, Math.max(65, width * 0.3)), right = 18, top = 24, bottom = 34
  const plotW = Math.max(30, width - left - right), plotH = height - top - bottom
  const all = [...numbers(b), ...(a.outliers ?? []).flat()], scale = niceScale(Math.min(...all, 0), Math.max(...all, 1), { zero: true })
  const sx = (v: number) => left + (v - scale.min) / (scale.max - scale.min) * plotW
  const sy = (v: number) => top + plotH - (v - scale.min) / (scale.max - scale.min) * plotH
  const rowY = (i: number) => top + (i + 0.5) * plotH / x.length
  const label = (i: number, y = rowY(i)) => <text x={left - 8} y={y + 4} textAnchor="end" className="chart-category"><title>{x[i]}</title>{short(x[i], Math.max(5, Math.floor((left - 10) / 7)))}</text>
  const mark = (i: number, children: ReactNode) => <g key={i} data-point={i} data-selected={focus === i || undefined} onClick={() => { if (front) onFocus(i) }} onPointerEnter={(event) => { if (front && event.pointerType !== 'touch') onFocus(i) }} style={{ cursor: front ? 'pointer' : undefined }}>{children}</g>
  const horizontalAxis = <g className="chart-grid">{scale.ticks.map((v) => <g key={v}><line x1={sx(v)} x2={sx(v)} y1={top - 8} y2={height - bottom} /><text x={sx(v)} y={height - 12} textAnchor="middle">{formatNumber(v, scale.decimals)}</text></g>)}</g>
  const pointsPath = (values: Array<number | null>, atX: (i: number) => number, atY: (v: number) => number) => values.map((v, i) => v === null ? '' : `${i === 0 || values[i - 1] === null ? 'M' : 'L'}${atX(i)},${atY(v)}`).join(' ')
  let drawing: ReactNode = null
  let drawingWidth = width

  if (['dot', 'dumbbell', 'bullet', 'box'].includes(form)) {
    drawing = <>{horizontalAxis}{x.map((_, i) => mark(i, <>
      {focus === i ? <rect x={0} y={rowY(i) - 13} width={width} height={26} className="chart-band" /> : null}{label(i)}
      {form === 'dot' && series[0].values[i] !== null ? <circle cx={sx(series[0].values[i]!)} cy={rowY(i)} r={5} fill={color(0)} stroke="#fff" /> : null}
      {form === 'dumbbell' ? <><line x1={sx(series[0].values[i]!)} x2={sx(series[1].values[i]!)} y1={rowY(i)} y2={rowY(i)} stroke="#c4cedb" strokeWidth={2} /><circle cx={sx(series[0].values[i]!)} cy={rowY(i)} r={5} fill={color(0)} /><rect x={sx(series[1].values[i]!) - 4} y={rowY(i) - 4} width={8} height={8} fill={color(1)} /></> : null}
      {form === 'bullet' ? <><rect x={Math.min(sx(0), sx(series[0].values[i]!))} y={rowY(i) - 7} width={Math.abs(sx(series[0].values[i]!) - sx(0))} height={14} fill={color(0)} /><line x1={sx(series[1].values[i]!)} x2={sx(series[1].values[i]!)} y1={rowY(i) - 12} y2={rowY(i) + 12} stroke="#fff" strokeWidth={3} /></> : null}
      {form === 'box' ? <><line x1={sx(series[0].values[i]!)} x2={sx(series[4].values[i]!)} y1={rowY(i)} y2={rowY(i)} stroke="#c4cedb" /><rect x={sx(series[1].values[i]!)} y={rowY(i) - 9} width={Math.max(0, sx(series[3].values[i]!) - sx(series[1].values[i]!))} height={18} fill={color(0)} stroke="#dce5f1" /><line x1={sx(series[2].values[i]!)} x2={sx(series[2].values[i]!)} y1={rowY(i) - 10} y2={rowY(i) + 10} stroke="#fff" strokeWidth={2} />{[0, 4].map((s) => <line key={s} x1={sx(series[s].values[i]!)} x2={sx(series[s].values[i]!)} y1={rowY(i) - 5} y2={rowY(i) + 5} stroke="#c4cedb" />)}{a.outliers![i].map((v, j) => <circle key={j} cx={sx(v)} cy={rowY(i)} r={3} fill="none" stroke="#fff" />)}</> : null}
    </>))}</>
  } else if (form === 'slope') {
    const x1 = 44, x2 = width - 26
    drawing = <><g className="chart-grid">{scale.ticks.map(v => <g key={v}><line x1={x1} x2={x2} y1={sy(v)} y2={sy(v)} /><text x={x1 - 6} y={sy(v) + 3} textAnchor="end">{formatNumber(v, scale.decimals)}</text></g>)}</g><text x={x1} y={14} className="chart-x">{short(series[0].label)}</text><text x={x2} y={14} textAnchor="end" className="chart-x">{short(series[1].label)}</text>{x.map((_, i) => mark(i, <><line x1={x1} x2={x2} y1={sy(series[0].values[i]!)} y2={sy(series[1].values[i]!)} stroke={color(i)} strokeWidth={focus === i ? 4 : 2} strokeDasharray={i % 2 ? '6 3' : undefined} /><circle cx={x1} cy={sy(series[0].values[i]!)} r={4} fill={color(i)} /><rect x={x2 - 4} y={sy(series[1].values[i]!) - 4} width={8} height={8} fill={color(i)} /></>))}</>
  } else if (form === 'stacked' || form === 'stacked-percent' || form === 'waterfall') {
    const sums = form === 'waterfall' ? series[0].values.map((_, i) => i === x.length - 1 ? series[0].values[i]! : series[0].values.slice(0, i + 1).reduce<number>((sum, v) => sum + v!, 0)) : a.totals!
    const domain = form === 'stacked-percent' ? niceScale(0, 100, { zero: true }) : niceScale(Math.min(...sums, 0), Math.max(...sums, 0), { zero: true })
    const px = 42, pw = width - px - 12, band = pw / x.length, bw = Math.min(42, band * 0.7)
    const atY = (v: number) => top + plotH * (1 - (v - domain.min) / (domain.max - domain.min))
    drawing = <><g className="chart-grid">{domain.ticks.map((v) => <g key={v}><line x1={px} x2={width - 12} y1={atY(v)} y2={atY(v)} /><text x={px - 5} y={atY(v) + 3} textAnchor="end">{formatNumber(v, domain.decimals)}{form === 'stacked-percent' ? '%' : ''}</text></g>)}</g>{x.map((name, i) => {
      let running = 0
      return mark(i, <>{series.map((s, j) => {
        const raw = s.values[i]!, value = form === 'stacked-percent' ? raw / a.totals![i] * 100 : raw
        const start = form === 'waterfall' ? i === 0 || i === x.length - 1 ? 0 : sums[i - 1] : running
        const end = form === 'waterfall' ? sums[i] : running + value; running += value
        return <rect key={s.key} x={px + band * (i + 0.5) - bw / 2} y={Math.min(atY(start), atY(end))} width={bw} height={Math.abs(atY(end) - atY(start))} fill={form === 'waterfall' ? raw < 0 ? color(2) : color(0) : color(j)} stroke={focus === i ? '#fff' : '#101722'} />
      })}{form === 'waterfall' && i < x.length - 1 ? <line x1={px + band * (i + 0.5) + bw / 2} x2={px + band * (i + 1.5) - bw / 2} y1={atY(sums[i])} y2={atY(sums[i])} stroke="#a9b1bd" strokeDasharray="3 3" /> : null}<text x={px + band * (i + 0.5)} y={height - 12} textAnchor="middle" className="chart-x">{short(name, Math.max(3, Math.floor(band / 7)))}</text></>)
    })}</>
  } else if (form === 'donut' || form === 'waffle') {
    const total = a.totals![0], values = series[0].values as number[]
    let offset = 0
    const radius = Math.min(68, width * 0.3), circumference = 2 * Math.PI * radius
    const shares = values.map((v) => v / total * 100), allocations = shares.map(Math.floor)
    ;[...shares.keys()].sort((i, j) => (shares[j] - allocations[j]) - (shares[i] - allocations[i])).slice(0, 100 - allocations.reduce((sum, v) => sum + v, 0)).forEach((i) => allocations[i]++)
    const tiles = allocations.flatMap((count, i) => Array<number>(count).fill(i))
    drawing = <>{form === 'donut' ? values.map((value, i) => { const before = offset; offset += value / total * circumference; return mark(i, <circle cx={width / 2} cy={90} r={radius} fill="none" stroke={color(i)} strokeWidth={focus === i ? 32 : 26} strokeDasharray={`${value / total * circumference} ${circumference - value / total * circumference}`} strokeDashoffset={-before} transform={`rotate(-90 ${width / 2} 90)`} />) }) : tiles.map((part, tile) => <rect key={tile} x={width / 2 - 70 + tile % 10 * 14} y={18 + Math.floor(tile / 10) * 14} width={12} height={12} fill={color(part)} stroke={focus === part ? '#fff' : 'none'} onClick={() => { if (front) onFocus(part) }} />)}{x.map((name, i) => mark(i, <><rect x={12} y={180 + i * 19} width={8} height={8} fill={color(i)} /><text x={27} y={188 + i * 19} className="chart-x">{short(name, Math.max(6, Math.floor((width - 110) / 7)))} · {formatNumber(shares[i], 1)}%</text></>))}</>
  } else if (form === 'bubble' || form === 'geo-symbol') {
    const geo = form === 'geo-symbol'
    const xs = geo ? series[2].values as number[] : b.positions!, ys = geo ? series[1].values as number[] : series[0].values as number[], sizes = series[geo ? 0 : 1].values as number[]
    const xd = geo ? { min: -180, max: 180, ticks: [-180, -90, 0, 90, 180], decimals: 0 } : niceScale(Math.min(...xs), Math.max(...xs))
    const yd = geo ? { min: -90, max: 90, ticks: [-90, -45, 0, 45, 90], decimals: 0 } : niceScale(Math.min(...ys), Math.max(...ys))
    const atX = (v: number) => 46 + (v - xd.min) / (xd.max - xd.min) * (width - 65), atY = (v: number) => 20 + (1 - (v - yd.min) / (yd.max - yd.min)) * (height - 65)
    drawing = <><g className="chart-grid">{xd.ticks.map((v) => <g key={v}><line x1={atX(v)} x2={atX(v)} y1={20} y2={height - 45} /><text x={atX(v)} y={height - 28} textAnchor="middle">{formatNumber(v, xd.decimals)}</text></g>)}{yd.ticks.map((v) => <g key={v}><line x1={46} x2={width - 19} y1={atY(v)} y2={atY(v)} /><text x={40} y={atY(v) + 4} textAnchor="end">{formatNumber(v, yd.decimals)}</text></g>)}</g>{x.map((_, i) => mark(i, sizes[i] === 0 ? <path d={`M${atX(xs[i]) - 3},${atY(ys[i])}h6M${atX(xs[i])},${atY(ys[i]) - 3}v6`} stroke="#fff" /> : <circle cx={atX(xs[i])} cy={atY(ys[i])} r={Math.sqrt(sizes[i] / Math.max(...sizes, 1)) * 24} fill={color(0)} fillOpacity={0.55} stroke={focus === i ? '#fff' : color(0)} strokeWidth={focus === i ? 2.5 : 1} />))}<text x={width / 2} y={height - 7} textAnchor="middle" className="chart-x">{geo ? 'Longitude (°); vertical axis: latitude (°)' : `${b.xLabel ?? 'X'}${b.xUnit ? ` (${b.xUnit})` : ''}`}</text></>
  } else if (form === 'calendar') {
    const start = Math.min(...x.map((date) => Date.parse(`${date}T00:00:00Z`))), end = Math.max(...x.map((date) => Date.parse(`${date}T00:00:00Z`)))
    const offset = (new Date(start).getUTCDay() + 6) % 7, count = Math.round((end - start) / 86400000) + 1, weeks = Math.ceil((count + offset) / 7)
    drawingWidth = Math.max(width, weeks * 13 + 32)
    const cell = Math.min(18, (drawingWidth - 32) / weeks), defined = series[0].values.filter((v): v is number => v !== null), lo = Math.min(...defined), hi = Math.max(...defined)
    const byDate = new Map(x.map((date, i) => [date, i]))
    drawing = <>{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, i) => <text key={i} x={3} y={29 + i * cell} className="chart-x">{day}</text>)}{Array.from({ length: count }, (_, day) => {
      const date = dateLabel(start + day * 86400000), index = byDate.get(date), v = index === undefined ? null : series[0].values[index]
      const px = 22 + Math.floor((day + offset) / 7) * cell, py = 18 + ((day + offset) % 7) * cell
      return <g key={date} onClick={() => { if (front && index !== undefined) onFocus(index) }}><title>{date}: {v === null ? 'not available' : String(v)}</title><rect x={px} y={py} width={cell - 2} height={cell - 2} fill={v === null ? '#141b26' : `rgba(83,166,245,${hi === lo ? 0.65 : 0.22 + (v - lo) / (hi - lo) * 0.7})`} stroke={focus === index ? '#fff' : v === null ? '#647084' : 'none'} strokeDasharray={v === null ? '2 2' : undefined} />{date.endsWith('-01') || day === 0 ? <text x={px} y={11} className="chart-x">{date.slice(0, 7)}</text> : null}</g>
    })}</>
  } else if (form === 'gantt') {
    const starts = series[0].values as number[], ends = series[1].values.map((v) => v ?? Date.parse(`${a.period}T00:00:00Z`)), lo = Math.min(...starts), hi = Math.max(...ends, lo + 86400000), at = (v: number) => left + (v - lo) / (hi - lo) * plotW
    drawing = <>{[lo, hi].map((v) => <text key={v} x={at(v)} y={height - 12} textAnchor={v === lo ? 'start' : 'end'} className="chart-x">{dateLabel(v)}</text>)}{x.map((_, i) => mark(i, <>{label(i)}<line x1={at(starts[i])} x2={at(ends[i])} y1={rowY(i)} y2={rowY(i)} stroke={color(i)} strokeWidth={12} strokeDasharray={series[1].values[i] === null ? '5 3' : undefined} /><circle cx={at(starts[i])} cy={rowY(i)} r={4} fill="#fff" /><circle cx={at(ends[i])} cy={rowY(i)} r={4} fill={series[1].values[i] === null ? '#101722' : '#fff'} stroke="#fff" /></>))}</>
  } else if (form === 'treemap') {
    drawing = treeLayout(b, width - 8, height - 8).map((r) => mark(r.index, <><rect x={r.x + 4} y={r.y + 4} width={r.width} height={r.height} fill={r.leaf ? color(r.index) : '#15202d'} fillOpacity={r.leaf ? 0.5 : 1} stroke={focus === r.index ? '#fff' : '#0b101a'} strokeWidth={2} />{r.width > 35 && r.height > 20 ? <text x={r.x + 8} y={r.y + 17} className="chart-value">{short(x[r.index], Math.max(3, Math.floor((r.width - 10) / 7)))}</text> : null}</>))
  } else if (form === 'sankey') {
    const layout = flowLayout(b, Math.max(40, width - 20), height - 40)
    drawing = <g transform="translate(10 20)">{layout.links.map((link) => mark(link.index, <path d={`M${link.x1},${link.y1}C${(link.x1 + link.x2) / 2},${link.y1} ${(link.x1 + link.x2) / 2},${link.y2} ${link.x2},${link.y2}`} fill="none" stroke={color(link.index)} strokeWidth={link.thickness} opacity={focus === link.index ? 0.9 : 0.5} />))}{layout.nodes.map((node) => <g key={node.name}><rect x={node.x} y={node.y} width={12} height={node.height} fill="#a9bed5" /><text x={node.x < width / 2 ? node.x + 15 : node.x - 3} y={node.y + node.height / 2 + 4} textAnchor={node.x < width / 2 ? 'start' : 'end'} className="chart-value">{short(node.name, 12)}</text></g>)}</g>
  } else if (form === 'funnel') {
    const max = series[0].values[0] || 1, band = plotH / x.length
    drawing = x.map((_, i) => {
      const w = series[0].values[i]! / max * plotW, next = (series[0].values[i + 1] ?? series[0].values[i])! / max * plotW, cx = left + plotW / 2, y = top + i * band
      return mark(i, <>{label(i)}<path d={`M${cx - w / 2},${y}H${cx + w / 2}L${cx + next / 2},${y + band - 4}H${cx - next / 2}Z`} fill={color(i)} fillOpacity={0.6} stroke={focus === i ? '#fff' : 'none'} /><text x={cx} y={y + band / 2} textAnchor="middle" className="chart-value">{series[0].values[i]}</text></>)
    })
  } else if (form === 'band' || form === 'small-multiples' || form === 'editorial' || form === 'event-timeline') {
    const positions = b.positions!, lo = Math.min(...positions), hi = Math.max(...positions), atX = (i: number) => 44 + (positions[i] - lo) / (hi - lo || 1) * (width - 64)
    if (form === 'event-timeline') drawing = <><line x1={44} x2={width - 20} y1={80} y2={80} stroke="#a9b1bd" />{x.map((date, i) => mark(i, <><circle cx={atX(i)} cy={80} r={focus === i ? 7 : 4} fill={color(i)} /><text x={atX(i)} y={i % 2 ? 112 : 57} textAnchor={i === 0 ? 'start' : i === x.length - 1 ? 'end' : 'middle'} className="chart-x">{focus === i || x.length <= 6 ? date : ''}</text></>))}</>
    else if (form === 'small-multiples') drawing = series.map((s, j) => {
      const base = j * 160, atY = (v: number) => base + 125 - (v - scale.min) / (scale.max - scale.min) * 92
      return <g key={s.key}><text x={44} y={base + 17} className="chart-value">{short(s.label, Math.floor((width - 60) / 7))}</text><g className="chart-grid">{scale.ticks.map((v) => <g key={v}><line x1={44} x2={width - 20} y1={atY(v)} y2={atY(v)} /><text x={40} y={atY(v) + 3} textAnchor="end">{formatNumber(v, scale.decimals)}</text></g>)}</g><path d={pointsPath(s.values, atX, atY)} fill="none" stroke={color(j)} strokeWidth={2} />{x.map((_, i) => s.values[i] === null ? null : mark(i, <circle cx={atX(i)} cy={atY(s.values[i]!)} r={focus === i ? 5 : 2} fill={color(j)} />))}<text x={44} y={base + 146} className="chart-x">{x[0]}</text><text x={width - 20} y={base + 146} textAnchor="end" className="chart-x">{x.at(-1)}</text></g>
    })
    else {
      const atY = (v: number) => 24 + (1 - (v - scale.min) / (scale.max - scale.min)) * (height - (form === 'editorial' ? 100 : 58))
      const central = form === 'band' ? series[1] : series[0]
      const runs: number[][] = []; let run: number[] = []
      central.values.forEach((v, i) => { if (v === null) { if (run.length) runs.push(run); run = [] } else run.push(i) }); if (run.length) runs.push(run)
      drawing = <><g className="chart-grid">{scale.ticks.map((v) => <g key={v}><line x1={44} x2={width - 20} y1={atY(v)} y2={atY(v)} /><text x={40} y={atY(v) + 3} textAnchor="end">{formatNumber(v, scale.decimals)}</text></g>)}</g>{form === 'band' ? runs.map((r, i) => <path key={i} d={`M${r.map((j) => `${atX(j)},${atY(series[0].values[j]!)}`).join('L')}L${[...r].reverse().map((j) => `${atX(j)},${atY(series[2].values[j]!)}`).join('L')}Z`} fill={color(0)} fillOpacity={0.25} />) : null}<path d={pointsPath(central.values, atX, atY)} fill="none" stroke={color(0)} strokeWidth={2} />{x.map((_, i) => central.values[i] === null ? null : mark(i, <circle cx={atX(i)} cy={atY(central.values[i]!)} r={focus === i ? 6 : 3} fill={color(0)} stroke={focus === i ? '#fff' : 'none'} />))}<text x={44} y={height - 12} className="chart-x">{x[0]}</text><text x={width - 20} y={height - 12} textAnchor="end" className="chart-x">{x.at(-1)}</text>{form === 'editorial' && focus !== null && central.values[focus] !== null ? <><text x={44} y={height - 67} className="chart-value">Selected: {short(x[focus])} · {withUnit(String(central.values[focus]), b.unit)}</text><rect x={44} y={height - 55} width={Math.abs(central.values[focus]!) / Math.max(...central.values.map((v) => Math.abs(v ?? 0)), 1) * (width - 64)} height={14} fill={color(0)} /></> : null}</>
    }
  }
  const table = advancedTableOf(b), selected = focus === null ? null : table.rows[focus]
  return <div className="advanced-chart">
    <p className="advanced-instructions">Use arrow keys or select a mark to inspect exact values. The table includes every entry.</p>
    {a.denominator ? <p className="advanced-instructions">Denominator: {a.denominator}{a.totals?.length === 1 ? ` = ${withUnit(String(a.totals[0]), b.unit)}` : '. Exact totals appear in the table.'}{form === 'waffle' ? ' Each cell approximates 1%; exact shares remain in the values.' : ''}</p> : null}
    {a.cohort || a.period || a.timezone ? <p className="advanced-instructions">{[a.cohort && `Cohort: ${a.cohort}`, a.period && `Period: ${a.period}`, a.timezone].filter(Boolean).join(' · ')}</p> : null}
    {['stacked', 'stacked-percent', 'dumbbell', 'bullet', 'band'].includes(form) ? <p className="advanced-legend">{series.map((s, i) => <span key={s.key}><i style={{ background: color(i) }} />{s.label}{form === 'bullet' && i === 1 ? ' (target line)' : ''}{form === 'dumbbell' ? i === 0 ? ' (circle)' : ' (square)' : ''}</span>)}</p> : null}
    <div className="advanced-canvas"><svg width={drawingWidth} height={height} viewBox={`0 0 ${drawingWidth} ${height}`} role="img" aria-label={`${b.title}. ${summary}`} tabIndex={front ? 0 : -1} className="card-chart-svg" onKeyDown={(event) => {
      if (!front) return
      const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? Math.min(x.length - 1, focus === null ? 0 : focus + 1) : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? Math.max(0, focus === null ? x.length - 1 : focus - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? x.length - 1 : event.key === 'Escape' ? null : undefined
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); onFocus(next) }
    }}>{drawing}</svg></div>
    {form === 'editorial' ? <nav className="advanced-story" aria-label="Source story"><button type="button" disabled={!front || (focus ?? 0) <= 0} onClick={() => onFocus(Math.max(0, (focus ?? 0) - 1))}>Previous</button><span>{(focus ?? 0) + 1} / {x.length}</span><button type="button" disabled={!front || (focus ?? 0) >= x.length - 1} onClick={() => onFocus(Math.min(x.length - 1, (focus ?? 0) + 1))}>Next</button></nav> : null}
    <div className="advanced-readout" aria-live="polite">{selected ? selected.cells.map((cell, i) => <span key={i}><small>{table.columns[i].label}</small><strong>{cell.text || 'No value'}{table.columns[i].unit ? ` ${table.columns[i].unit}` : ''}</strong></span>) : <span>Select an entry to inspect its source values.</span>}</div>
  </div>
}
