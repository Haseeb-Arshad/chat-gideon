import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Droplet, Moon, Sun, type LucideIcon } from 'lucide-react'
import type { CSSProperties, RefObject } from 'react'
import { SERIES } from '../../../lib/cards/palette'
import type { ForecastBlock, ForecastHour } from '../../../lib/cards/schema'
import { WET_DAY_CHANCE, conditionOf, degrees, type WeatherKind } from '../../../lib/cards/weather'
import { rise } from '../stagger'
import { useWidth } from './useWidth'

/**
 * The weather to come, in a well: the next hours as a temperature line with
 * the chance of rain in columns under it, sharing the hours rather than an
 * axis, and the week as low-to-high bars on one scale, so a cold day looks
 * cold beside a warm one.
 *
 * Every figure is rounded the way a forecast is read and nothing is drawn
 * that the forecast did not give: an hour without a chance of rain has no
 * column, not a column of nothing.
 */

const beat = (index: number) => ({ '--row': index }) as CSSProperties

const ICONS: Record<WeatherKind, readonly [day: LucideIcon, night: LucideIcon]> = {
  clear: [Sun, Moon],
  partly: [CloudSun, CloudMoon],
  cloud: [Cloud, Cloud],
  fog: [CloudFog, CloudFog],
  drizzle: [CloudDrizzle, CloudDrizzle],
  rain: [CloudRain, CloudRain],
  snow: [CloudSnow, CloudSnow],
  storm: [CloudLightning, CloudLightning],
}

/** The sky as a picture, named for anyone who cannot see it. */
export function WeatherIcon({ code, isDay = true, size }: { code: number; isDay?: boolean; size: number }) {
  const { text, kind } = conditionOf(code, isDay)
  const Icon = ICONS[kind][isDay ? 0 : 1]
  return <Icon className="weather-icon" data-kind={kind} size={size} strokeWidth={1.7} role="img" aria-label={text} />
}

/**
 * A temperature's colour, on one scale from cold to hot whatever the unit, in
 * the palette's own colours: blue, green, amber, orange.
 */
const STOPS: Array<[celsius: number, rgb: [number, number, number]]> = [
  [0, [0x39, 0x87, 0xe5]],
  [12, [0x19, 0x9e, 0x70]],
  [22, [0xc9, 0x85, 0x00]],
  [32, [0xd9, 0x59, 0x26]],
]

export function temperatureColour(value: number, unit: ForecastBlock['unit']): string {
  const celsius = unit === '°F' ? ((value - 32) * 5) / 9 : value
  const upper = STOPS.findIndex(([at]) => celsius <= at)
  if (upper <= 0) {
    const [, rgb] = STOPS[upper === 0 ? 0 : STOPS.length - 1]
    return `rgb(${rgb.join(' ')})`
  }
  const [fromAt, from] = STOPS[upper - 1]
  const [toAt, to] = STOPS[upper]
  const share = (celsius - fromAt) / (toAt - fromAt)
  return `rgb(${from.map((channel, index) => Math.round(channel + (to[index] - channel) * share)).join(' ')})`
}

const PLOT = { padX: 16, labels: 20, line: 72, gap: 12, rain: 30, axis: 20 }
/** What the hours draw at before the strip has been measured. */
const FALLBACK_WIDTH = 420

/** Runs of night hours, as index ranges, to shade behind the line. */
function nights(hours: ForecastHour[]): Array<[from: number, to: number]> {
  const runs: Array<[number, number]> = []
  hours.forEach((hour, index) => {
    if (hour.isDay) return
    const last = runs.at(-1)
    if (last && last[1] === index - 1) last[1] = index
    else runs.push([index, index])
  })
  return runs
}

/** What the line shows, in words, for a reader that cannot see it. */
function hoursSummary(block: ForecastBlock): string {
  const { hours } = block
  const warmest = hours.reduce((best, hour) => (hour.temperature > best.temperature ? hour : best))
  const coolest = hours.reduce((best, hour) => (hour.temperature < best.temperature ? hour : best))
  const wettest = hours.reduce((best, hour) => ((hour.rainChance ?? 0) > (best.rainChance ?? 0) ? hour : best))
  const rain = (wettest.rainChance ?? 0) < 10 ? 'no rain expected' : `rain most likely at ${wettest.time}, ${wettest.rainChance}%`
  return `Next ${hours.length} hours: ${degrees(hours[0].temperature)} now, warmest ${degrees(warmest.temperature)} at ${warmest.time}, coolest ${degrees(coolest.temperature)} at ${coolest.time}, ${rain}.`
}

export function HourStrip({ block, start }: { block: ForecastBlock; start: number }) {
  const [plot, measured] = useWidth(FALLBACK_WIDTH)
  const { hours } = block
  if (hours.length < 2) return null

  const width = measured ?? FALLBACK_WIDTH
  const step = (width - PLOT.padX * 2) / (hours.length - 1)
  const x = (index: number) => PLOT.padX + index * step
  const temperatures = hours.map((hour) => hour.temperature)
  const high = Math.max(...temperatures)
  const low = Math.min(...temperatures)
  // A flat day still draws as a gentle line in the middle, not a jagged one filling the height.
  const span = Math.max(high - low, 6)
  const middle = (high + low) / 2
  const lineTop = PLOT.labels
  const y = (value: number) => lineTop + PLOT.line / 2 - ((value - middle) / span) * PLOT.line
  const rainBottom = lineTop + PLOT.line + PLOT.gap + PLOT.rain
  const height = rainBottom + PLOT.axis
  const column = Math.max(3, Math.min(10, step * 0.55))

  const warmest = temperatures.indexOf(high)
  const coolest = temperatures.indexOf(low)
  // Now, the warmest and the coolest are named; two of them that fall close together are named once.
  const named = [0, warmest, coolest].filter((index, at, all) => all.findIndex((other) => Math.abs(x(other) - x(index)) < 34) === at)

  return (
    <figure className="forecast-hours card-well" style={rise(start)}>
      <figcaption>Next {hours.length} hours</figcaption>
      <div className="forecast-plot" ref={plot as RefObject<HTMLDivElement | null>}>
        <svg width={width} height={height} role="img" aria-label={hoursSummary(block)}>
          {nights(hours).map(([from, to]) => (
            <rect
              key={from}
              className="forecast-night"
              x={Math.max(0, x(from) - step / 2)}
              y={0}
              width={Math.min(width, x(to) + step / 2) - Math.max(0, x(from) - step / 2)}
              height={rainBottom}
              rx={6}
            />
          ))}
          <polyline className="forecast-line" points={hours.map((hour, index) => `${x(index).toFixed(1)},${y(hour.temperature).toFixed(1)}`).join(' ')} />
          {named.map((index) => (
            <g key={index} className="forecast-point" data-now={index === 0 ? 'true' : undefined}>
              <circle cx={x(index)} cy={y(temperatures[index])} r={3.5} />
              <text x={x(index)} y={index === coolest && index !== warmest ? y(temperatures[index]) + 17 : y(temperatures[index]) - 9} textAnchor={index === 0 ? 'start' : 'middle'}>
                {degrees(temperatures[index])}
              </text>
            </g>
          ))}
          <line className="forecast-rain-base" x1={PLOT.padX - column / 2} x2={width - PLOT.padX + column / 2} y1={rainBottom} y2={rainBottom} />
          {hours.map((hour, index) =>
            hour.rainChance ? (
              <rect
                key={hour.time}
                className="forecast-rain"
                x={x(index) - column / 2}
                y={rainBottom - (hour.rainChance / 100) * PLOT.rain}
                width={column}
                height={(hour.rainChance / 100) * PLOT.rain}
                rx={1.5}
                fill={SERIES[0]}
                opacity={0.35 + (hour.rainChance / 100) * 0.65}
              />
            ) : null,
          )}
          {hours.map((hour, index) =>
            index % 3 === 0 ? (
              <text key={hour.time} className="forecast-hour" x={x(index)} y={height - 5} textAnchor={index === 0 ? 'start' : 'middle'}>
                {index === 0 ? 'Now' : hour.time.slice(0, 2)}
              </text>
            ) : null,
          )}
        </svg>
      </div>
    </figure>
  )
}

export function WeekDays({ block, start, said }: { block: ForecastBlock; start: number; said?: Set<string> }) {
  const { days, unit } = block
  if (!days.length) return null
  const low = Math.min(...days.map((day) => day.low))
  const high = Math.max(...days.map((day) => day.high))
  const span = Math.max(high - low, 1)
  return (
    <ol className="forecast-days card-well" style={rise(start)} aria-label="The week">
      {days.map((day, index) => (
        <li key={day.id} style={beat(index)} data-said={said?.has(day.id) ? 'true' : undefined}>
          <span className="forecast-day">{day.day}</span>
          <WeatherIcon code={day.code} size={17} />
          <span className="forecast-chance">
            {day.rainChance !== null && day.rainChance >= WET_DAY_CHANCE ? (
              <>
                <Droplet size={10} strokeWidth={2.2} aria-hidden="true" />
                {day.rainChance}%
              </>
            ) : null}
          </span>
          <span className="forecast-low" aria-label={`low ${degrees(day.low)}`}>
            {degrees(day.low)}
          </span>
          <span className="forecast-range" aria-hidden="true">
            <i
              style={{
                left: `${((day.low - low) / span) * 100}%`,
                right: `${((high - day.high) / span) * 100}%`,
                background: `linear-gradient(90deg, ${temperatureColour(day.low, unit)}, ${temperatureColour(day.high, unit)})`,
              }}
            />
          </span>
          <span className="forecast-high" aria-label={`high ${degrees(day.high)}`}>
            {degrees(day.high)}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The hours and the days together, for a card that is not laid out as the weather. */
export function Forecast({ block, start, said }: { block: ForecastBlock; start: number; said?: Set<string> }) {
  return (
    <div className="card-forecast" style={rise(start)}>
      <HourStrip block={block} start={start} />
      <WeekDays block={block} start={start} said={said} />
    </div>
  )
}
