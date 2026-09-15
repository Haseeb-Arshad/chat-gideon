import { formatNumber } from '../../../lib/cards/chart-math'
import { SERIES } from '../../../lib/cards/palette'
import type { MeterBlock } from '../../../lib/cards/schema'
import { rise } from '../stagger'

/**
 * A value on a fixed scale with named bands: the UV index on the WHO's.
 *
 * The bands and their names come from the skill that made the card, never
 * from a model, and the reading is always said in words beside its mark, so a
 * colour is never the only thing that says whether a value is high.
 */

/** Bands in order, from the calm end of the scale to the alarming one, in the palette's own colours. */
const BAND_COLOURS = [SERIES[2], SERIES[3], SERIES[1], SERIES[7], SERIES[6]]

export function Meter({ block, start }: { block: MeterBlock; start: number }) {
  const band = block.bands.find((each) => block.value >= each.from && block.value < each.to) ?? block.bands.at(-1)
  const at = (value: number) => ((Math.min(Math.max(value, block.min), block.max) - block.min) / (block.max - block.min)) * 100
  const reading = formatNumber(Math.round(block.value), 0)
  return (
    <div
      className="card-meter"
      style={rise(start)}
      role="meter"
      aria-label={block.label}
      aria-valuemin={block.min}
      aria-valuemax={block.max}
      aria-valuenow={block.value}
      aria-valuetext={band ? `${reading}, ${band.label}` : reading}
    >
      <p className="card-meter-label">{block.label}</p>
      <p className="card-meter-reading">
        <strong>{reading}</strong>
        {band ? <span>{band.label}</span> : null}
      </p>
      <div className="card-meter-track" aria-hidden="true">
        {block.bands.map((each, index) => (
          <i
            key={each.label}
            style={{ left: `${at(each.from)}%`, width: `${at(each.to) - at(each.from)}%`, background: BAND_COLOURS[Math.min(index, BAND_COLOURS.length - 1)] }}
          />
        ))}
        <b style={{ left: `${at(block.value)}%` }} />
      </div>
    </div>
  )
}
