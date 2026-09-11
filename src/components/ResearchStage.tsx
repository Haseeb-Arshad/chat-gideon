import { ArrowUpRight, X } from 'lucide-react'
import { useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { numbersIn, type Card, type CardFact, type CardImage } from '../lib/cards'

/**
 * What GIDEON found, on panes of glass.
 *
 * The newest card holds the middle of the room. The one before it steps back
 * to the right edge and waits there, half visible, and a tap brings it
 * forward again. Anything older is held out of sight behind that one.
 *
 * Each card is three layers, and the split is load-bearing. The outer one owns
 * the card's place on the stage and slides between places. The middle one
 * floats and tilts toward the pointer. The inner one is the glass itself, and
 * it is the only one that ever fades or blurs: opacity or a filter on an
 * ancestor would cut the glass off from the room behind it, and the blur
 * would be of nothing.
 */

export interface StageEntry {
  /** The turn and the tool call it came from, so a card finds its pane. */
  id: string
  /** What is being looked up, shown while the desk works. */
  query: string
  /** Null while the research is still running. */
  card: Card | null
  /** Set once the card is dissolving: its place in the order they go, newest first. */
  leaving: number | null
}

type Slot = 'front' | 'peek' | 'behind'

interface ResearchStageProps {
  entries: StageEntry[]
  frontId: string | null
  /** What GIDEON has said aloud so far, so facts can light up as they are spoken. */
  spoken: string
  onFocus: (id: string) => void
  onClose: (id: string) => void
}

export function ResearchStage({ entries, frontId, spoken, onFocus, onClose }: ResearchStageProps) {
  // A dissolving card keeps the place it had, rather than jumping to the front
  // on its way out, so the last known slot of every card is remembered.
  const slots = useRef(new Map<string, Slot>())
  const live = entries.filter((entry) => entry.leaving === null)
  const front = live.find((entry) => entry.id === frontId) ?? live.at(-1)
  const others = live.filter((entry) => entry !== front)
  const peek = others.at(-1)
  for (const entry of live) {
    slots.current.set(entry.id, entry === front ? 'front' : entry === peek ? 'peek' : 'behind')
  }
  for (const id of slots.current.keys()) {
    if (!entries.some((entry) => entry.id === id)) slots.current.delete(id)
  }

  return (
    <div className="research-stage" role="region" aria-label="What GIDEON found">
      {entries.map((entry) => (
        <GlassCard
          key={entry.id}
          entry={entry}
          slot={slots.current.get(entry.id) ?? 'front'}
          spoken={entry === front ? spoken : ''}
          behind={entry === peek ? others.length - 1 : 0}
          onFocus={onFocus}
          onClose={onClose}
        />
      ))}
    </div>
  )
}

interface GlassCardProps {
  entry: StageEntry
  slot: Slot
  spoken: string
  /** How many more cards are held behind this one, when it is the one peeking. */
  behind: number
  onFocus: (id: string) => void
  onClose: (id: string) => void
}

function GlassCard({ entry, slot, spoken, behind, onFocus, onClose }: GlassCardProps) {
  const [imageFailed, setImageFailed] = useState(false)
  const { card } = entry
  const image = card?.image && !imageFailed ? card.image : null
  const leaving = entry.leaving !== null
  const title = card?.title ?? entry.query

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
    node.style.setProperty('--tilt-x', `${((0.5 - y) * 4).toFixed(2)}deg`)
    node.style.setProperty('--tilt-y', `${((x - 0.5) * 6).toFixed(2)}deg`)
  }
  const settle = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.style.setProperty('--tilt-x', '0deg')
    event.currentTarget.style.setProperty('--tilt-y', '0deg')
  }

  return (
    <article
      className="glass-card"
      data-slot={slot}
      data-leaving={leaving}
      style={{ '--leave-i': entry.leaving ?? 0 } as CSSProperties}
      onPointerMove={lean}
      onPointerLeave={settle}
      aria-hidden={slot === 'behind' || leaving}
    >
      <div className="glass-float">
        <div
          className="glass-pane"
          data-state={card ? 'ready' : 'searching'}
          data-kind={card?.kind}
          data-media={image ? 'true' : undefined}
        >
          {card ? (
            <CardFace card={card} image={image} spoken={spoken} onImageError={() => setImageFailed(true)} />
          ) : (
            <SearchingFace query={entry.query} />
          )}
          {slot === 'front' && !leaving ? (
            <button
              type="button"
              className="card-close"
              onClick={() => onClose(entry.id)}
              aria-label={`Close ${title}`}
            >
              <X size={15} strokeWidth={2.2} />
            </button>
          ) : null}
        </div>
      </div>

      {slot === 'peek' && !leaving ? (
        <button
          type="button"
          className="peek-hit"
          onClick={() => onFocus(entry.id)}
          aria-label={`Bring back ${title}`}
        >
          {behind > 0 ? <span>+{behind}</span> : null}
        </button>
      ) : null}
    </article>
  )
}

function SearchingFace({ query }: { query: string }) {
  return (
    <div className="card-searching">
      <p className="card-kicker">
        <span className="search-pulse" aria-hidden="true" />
        Searching the web
      </p>
      <h2 className="card-query">{query || 'Looking that up'}</h2>
      <div className="search-lines" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </div>
  )
}

interface CardFaceProps {
  card: Card
  image: CardImage | null
  spoken: string
  onImageError: () => void
}

function CardFace({ card, image, spoken, onImageError }: CardFaceProps) {
  // Every piece of the card rises in turn, so it reads top to bottom as it
  // arrives rather than landing as one block.
  let order = 0
  const next = () => ({ '--i': order++ }) as CSSProperties

  return (
    <>
      {image ? (
        <figure className="card-media">
          <img
            src={image.url}
            alt={image.alt}
            decoding="async"
            referrerPolicy="no-referrer"
            onError={onImageError}
          />
          <figcaption>{image.credit}</figcaption>
        </figure>
      ) : null}

      <div className="card-body">
        {card.kicker ? (
          <p className="card-kicker" style={next()}>
            {card.kicker}
          </p>
        ) : null}
        <h2 className="card-title" style={next()}>
          {card.title}
        </h2>
        {card.subtitle ? (
          <p className="card-subtitle" style={next()}>
            {card.subtitle}
          </p>
        ) : null}
        {card.figure ? (
          <p className="card-figure" style={next()}>
            <strong>{card.figure.value}</strong>
            {card.figure.label ? <span>{card.figure.label}</span> : null}
          </p>
        ) : null}
        {card.summary ? (
          <p className="card-summary" style={next()}>
            {card.summary}
          </p>
        ) : null}
        {card.facts.length ? (
          <dl className="card-facts">
            {card.facts.map((fact) => (
              <div
                className="card-fact"
                key={fact.label}
                data-said={factSpoken(fact, spoken)}
                style={next()}
              >
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {card.sources.length ? (
          <ul className="card-sources" style={next()}>
            {card.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer noopener" title={source.title}>
                  {source.host}
                  <ArrowUpRight size={11} strokeWidth={2.2} />
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  )
}

/**
 * Whether GIDEON has said this fact out loud yet.
 *
 * A number is the surest sign: "born in 1879" is the fact whose value holds
 * 1879. Without one, most of the value's longer words have to have been said.
 */
export function factSpoken(fact: CardFact, spoken: string): boolean {
  if (!spoken) return false
  const numbers = numbersIn(fact.value)
  if (numbers.length) {
    const heard = new Set(numbersIn(spoken))
    return numbers.some((number) => heard.has(number))
  }
  const said = spoken.toLowerCase()
  const words = fact.value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 3)
  if (!words.length) return false
  return words.filter((word) => said.includes(word)).length / words.length >= 0.6
}
