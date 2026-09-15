import { useState } from 'react'
import { compactOf } from '../../lib/cards/compact'
import type { StageEntry } from './Stage'
import { WeatherIcon } from './blocks/Forecast'

/**
 * A card beside the one in front, drawn small: what it is, its name, one line
 * of what it says, and a picture of it when it has one. The whole tile is
 * pressed to bring the card forward, so nothing on it is a control.
 */
export function CompactFace({ entry }: { entry: StageEntry }) {
  const [broken, setBroken] = useState<string | null>(null)
  if (!entry.card) {
    return (
      <div className="compact-face" data-state="searching">
        <div className="compact-text">
          <span className="compact-kicker">Looking</span>
          <strong className="compact-title">{entry.query}</strong>
        </div>
      </div>
    )
  }

  const { kicker, title, detail, thumb } = compactOf(entry.card)
  const picture = thumb?.kind === 'image' && thumb.url !== broken ? thumb.url : null

  return (
    <div className="compact-face" data-thumb={thumb && (thumb.kind === 'sky' || picture) ? thumb.kind : undefined}>
      {thumb?.kind === 'sky' ? (
        <span className="compact-thumb" aria-hidden="true">
          <WeatherIcon code={thumb.code} isDay={thumb.isDay} size={30} />
        </span>
      ) : picture ? (
        <span className="compact-thumb" aria-hidden="true">
          <img src={picture} alt="" decoding="async" loading="lazy" onError={() => setBroken(picture)} />
        </span>
      ) : null}
      <div className="compact-text">
        {kicker ? <span className="compact-kicker">{kicker}</span> : null}
        <strong className="compact-title">{title}</strong>
        {detail ? <span className="compact-detail">{detail}</span> : null}
      </div>
    </div>
  )
}
