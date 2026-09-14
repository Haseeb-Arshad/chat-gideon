import { X } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { blockOf } from '../../lib/cards/schema'
import { useGlass } from '../LiquidGlass'
import { CardBoundary } from './CardBoundary'
import { CardFace } from './CardFace'
import type { MediaShape } from './blocks/Media'
import { SearchingFace } from './SearchingFace'
import type { StageEntry } from './Stage'
import { glanceAt } from './glance'

export type Slot = 'front' | 'peek' | 'behind'

/** A glance every sentence at most: a face darting at every word looks nervous, not attentive. */
const GLANCE_GAP_MS = 900

interface CardFrameProps {
  entry: StageEntry
  slot: Slot
  spoken: string
  /** How many more cards are held behind this one, when it is the one peeking. */
  behind: number
  /** On its way to the shelf, so nothing on it can be pressed. */
  quiet: boolean
  onFocus: (id: string) => void
  onTuck: () => void
  onAsk?: (text: string) => void
}

/**
 * One card on the stage, in three layers.
 *
 * The outer layer owns the card's place and slides between places. The middle
 * one floats and tilts toward the pointer. The inner one is the glass itself,
 * and it is the only one that ever fades or blurs: opacity or a filter on an
 * ancestor would cut the glass off from the room behind it, and the blur would
 * be of nothing.
 */
export function CardFrame({ entry, slot, spoken, behind, quiet, onFocus, onTuck, onAsk }: CardFrameProps) {
  const { card } = entry
  /**
   * The picture that would not load, by its address, so a card whose picture
   * changes gets a fresh chance to show the new one.
   */
  const [failedImage, setFailedImage] = useState<string | null>(null)
  /**
   * Which way the picture runs, which decides where it sits. A portrait is a
   * panel down the side, the shape a face wants. Anything wider than it is
   * tall (a chart, a diagram, a photograph of a place) cannot survive being
   * cropped to a narrow column, so it becomes a banner across the top and is
   * shown whole. Until the file has loaded nothing is known, and the panel is
   * the safer guess: it is what the card was drawn around.
   */
  const [shape, setShape] = useState<{ url: string; shape: MediaShape } | null>(null)

  const lead = card ? blockOf(card, 'media') : undefined
  const media = lead && lead.image.url !== failedImage ? lead : null
  const mediaShape = media && shape?.url === media.image.url ? shape.shape : 'tall'
  const idle = entry.leaving || quiet
  const front = slot === 'front' && !idle
  // Only the card in front is worth refracting: the ones behind it are dimmed
  // and half off the screen, and each map costs a pane-sized image to build.
  const glass = useGlass({ enabled: front, blur: 14, saturate: 180 })

  // What has lit up so far in this reply, so the face glances only at what is new.
  const pane = useRef<HTMLDivElement | null>(null)
  const lit = useRef(new WeakSet<Element>())
  const heardSoFar = useRef('')
  const lastGlance = useRef(0)
  useEffect(() => {
    const node = pane.current
    if (!front || !node) return
    // A new reply starts again from nothing: the same row said twice is worth two glances.
    if (!spoken.startsWith(heardSoFar.current)) lit.current = new WeakSet()
    heardSoFar.current = spoken
    if (!spoken) return
    const fresh = [...node.querySelectorAll('[data-said="true"]')].filter((element) => !lit.current.has(element))
    for (const element of fresh) lit.current.add(element)
    const newest = fresh.at(-1)
    const now = performance.now()
    if (!newest || now - lastGlance.current < GLANCE_GAP_MS) return
    lastGlance.current = now
    glanceAt(newest)
  }, [front, spoken])

  // The sheen follows the pointer across the glass, and the pane leans toward
  // it a few degrees. Written straight to the element; nothing re-renders.
  const lean = (event: PointerEvent<HTMLElement>) => {
    if (slot !== 'front' || event.pointerType === 'touch') return
    const node = event.currentTarget
    const box = node.getBoundingClientRect()
    const x = (event.clientX - box.left) / box.width
    const y = (event.clientY - box.top) / box.height
    node.style.setProperty('--sheen-x', `${(x * 100).toFixed(1)}%`)
    node.style.setProperty('--sheen-y', `${(y * 100).toFixed(1)}%`)
    node.style.setProperty('--tilt-x', `${((0.5 - y) * 3).toFixed(2)}deg`)
    node.style.setProperty('--tilt-y', `${((x - 0.5) * 4).toFixed(2)}deg`)
    // Where the light is coming from, for the rim to answer: the bearing from
    // the middle of the card out to the pointer. Zero degrees is up, which is
    // where a conic gradient starts, so the rim brightens on the near side.
    const angle = (Math.atan2(y - 0.5, x - 0.5) * 180) / Math.PI + 90
    node.style.setProperty('--sheen-angle', `${angle.toFixed(1)}deg`)
  }
  const settle = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.style.setProperty('--tilt-x', '0deg')
    event.currentTarget.style.setProperty('--tilt-y', '0deg')
  }

  return (
    <article
      className="glass-card"
      data-slot={slot}
      data-size={card?.size ?? 'standard'}
      data-leaving={entry.leaving}
      onPointerMove={lean}
      onPointerLeave={settle}
      aria-hidden={slot === 'behind' || idle}
    >
      <div className="glass-float">
        <div
          className="glass-pane"
          ref={(node) => {
            glass.ref(node)
            pane.current = node
          }}
          style={glass.style}
          data-state={card ? 'ready' : 'searching'}
          data-recipe={card?.recipe}
          data-size={card?.size}
          data-media={media ? mediaShape : undefined}
          data-refracting={glass.refracting ? 'true' : undefined}
        >
          {card ? (
            <CardBoundary resetKey={card}>
              <CardFace
                card={card}
                media={media}
                spoken={spoken}
                front={front}
                onShape={(next) => media && setShape({ url: media.image.url, shape: next })}
                onMediaError={() => media && setFailedImage(media.image.url)}
                onAsk={onAsk}
              />
            </CardBoundary>
          ) : (
            <SearchingFace query={entry.query} hint={entry.hint} />
          )}
          {front ? (
            <button type="button" className="card-close" onClick={onTuck} aria-label="Put the cards away">
              <X size={15} strokeWidth={2.2} />
            </button>
          ) : null}
        </div>
      </div>

      {slot === 'peek' && !idle ? (
        <button
          type="button"
          className="peek-hit"
          onClick={() => onFocus(entry.id)}
          aria-label={`Bring back ${card?.title ?? entry.query}`}
        >
          {behind > 0 ? <span>+{behind}</span> : null}
        </button>
      ) : null}
    </article>
  )
}
