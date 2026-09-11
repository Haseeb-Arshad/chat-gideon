import { ArrowUpRight, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { numbersIn, type Card, type CardFact, type CardImage, type CardPicture } from '../lib/cards'

/**
 * What GIDEON found, on panes of glass.
 *
 * The newest card holds the middle of the room. The one before it steps back
 * to the right edge and waits there, half visible, and a tap brings it
 * forward again. Anything older is held out of sight behind that one. When the
 * conversation moves on, all of them slide off to the right together and wait
 * on the shelf at the edge of the screen until their topic comes back.
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
  /** What is being looked up, shown while the search runs. */
  query: string
  /** What kind of search is running, for the pane shown before the card. */
  hint: 'web' | 'pictures'
  /** Null while the search is still running. */
  card: Card | null
  /** Dissolving because nothing came of it, so there is nothing to put away. */
  leaving: boolean
}

type Slot = 'front' | 'peek' | 'behind'

interface ResearchStageProps {
  entries: StageEntry[]
  frontId: string | null
  /** Everything is sliding off to the shelf at the right edge. */
  tucking: boolean
  /** What GIDEON has said aloud so far, so facts can light up as they are spoken. */
  spoken: string
  onFocus: (id: string) => void
  /** Put every card away, as the close button does. */
  onTuck: () => void
}

export function ResearchStage({ entries, frontId, tucking, spoken, onFocus, onTuck }: ResearchStageProps) {
  // A card on its way out keeps the place it had, rather than jumping to the
  // front as it goes, so the last known slot of every card is remembered.
  const slots = useRef(new Map<string, Slot>())
  const live = entries.filter((entry) => !entry.leaving)
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
    <div
      className="research-stage"
      data-tucking={tucking}
      role="region"
      aria-label="What GIDEON found"
    >
      {entries.map((entry) => (
        <GlassCard
          key={entry.id}
          entry={entry}
          slot={slots.current.get(entry.id) ?? 'front'}
          spoken={entry === front ? spoken : ''}
          behind={entry === peek ? others.length - 1 : 0}
          quiet={tucking}
          onFocus={onFocus}
          onTuck={onTuck}
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
  /** On its way to the shelf, so nothing on it can be pressed. */
  quiet: boolean
  onFocus: (id: string) => void
  onTuck: () => void
}

function GlassCard({ entry, slot, spoken, behind, quiet, onFocus, onTuck }: GlassCardProps) {
  const [imageFailed, setImageFailed] = useState(false)
  const { card } = entry
  const image = card?.image && !imageFailed ? card.image : null
  const idle = entry.leaving || quiet

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
  }
  const settle = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.style.setProperty('--tilt-x', '0deg')
    event.currentTarget.style.setProperty('--tilt-y', '0deg')
  }

  return (
    <article
      className="glass-card"
      data-slot={slot}
      data-leaving={entry.leaving}
      onPointerMove={lean}
      onPointerLeave={settle}
      aria-hidden={slot === 'behind' || idle}
    >
      <div className="glass-float">
        <div
          className="glass-pane"
          data-state={card ? 'ready' : 'searching'}
          data-kind={card?.kind}
          data-media={image ? 'true' : undefined}
        >
          {!card ? (
            <SearchingFace query={entry.query} hint={entry.hint} />
          ) : card.kind === 'gallery' ? (
            <GalleryFace card={card} front={slot === 'front' && !idle} />
          ) : (
            <CardFace card={card} image={image} spoken={spoken} onImageError={() => setImageFailed(true)} />
          )}
          {slot === 'front' && !idle ? (
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

function SearchingFace({ query, hint }: { query: string; hint: StageEntry['hint'] }) {
  return (
    <div className="card-searching" data-hint={hint}>
      <p className="card-kicker">
        <span className="search-pulse" aria-hidden="true" />
        {hint === 'pictures' ? 'Finding pictures' : 'Searching the web'}
      </p>
      <h2 className="card-query">{query || (hint === 'pictures' ? 'Pictures' : 'Looking that up')}</h2>
      {hint === 'pictures' ? (
        <div className="search-tiles" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <i key={index} style={{ '--i': index } as CSSProperties} />
          ))}
        </div>
      ) : (
        <div className="search-lines" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      )}
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
        <Sources card={card} style={next()} />
      </div>
    </>
  )
}

function Sources({ card, style }: { card: Card; style?: CSSProperties }) {
  if (!card.sources.length) return null
  return (
    <ul className="card-sources" style={style}>
      {card.sources.map((source) => (
        <li key={source.url}>
          <a href={source.url} target="_blank" rel="noreferrer noopener" title={source.title}>
            {source.host}
            <ArrowUpRight size={11} strokeWidth={2.2} />
          </a>
        </li>
      ))}
    </ul>
  )
}

/**
 * How many pictures fill the grid with no gaps. Around a large lead picture,
 * nine fill four columns or three, six fill three, and five fill four; fewer
 * than that simply sit side by side. The stylesheet lays out each count.
 */
export function galleryCount(available: number): number {
  if (available >= 9) return 9
  if (available >= 6) return 6
  return available
}

/**
 * Whether a loaded picture could be a photograph at all.
 *
 * Some pages name an icon as their picture, a language flag or a badge, and
 * nothing in its address says so. Its size does, once it has arrived: anything
 * this small, or shaped like a banner, is taken out of the gallery.
 */
function photograph(image: HTMLImageElement): boolean {
  const { naturalWidth: width, naturalHeight: height } = image
  if (width < 320 || height < 200) return false
  const ratio = width / height
  return ratio <= 3 && ratio >= 1 / 3
}

function GalleryFace({ card, front }: { card: Card; front: boolean }) {
  // A picture that will not load is taken out rather than left as a hole;
  // whatever remains is laid out again as if it had never been there.
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState<number | null>(null)
  const usable = card.pictures.filter((picture) => !failed.has(picture.thumb))
  const pictures = usable.slice(0, galleryCount(usable.length))
  const lose = (picture: CardPicture) =>
    setFailed((current) => new Set(current).add(picture.thumb))

  return (
    <div className="card-gallery">
      <header className="gallery-head">
        <p className="card-kicker" style={{ '--i': 0 } as CSSProperties}>
          Pictures
        </p>
        <h2 className="card-title" style={{ '--i': 1 } as CSSProperties}>
          {card.title}
        </h2>
      </header>

      {pictures.length ? (
        <div className="gallery-grid" data-count={pictures.length}>
          {pictures.map((picture, index) => (
            <button
              type="button"
              className="gallery-tile"
              key={picture.thumb}
              style={{ '--i': 2 + index } as CSSProperties}
              onClick={() => setOpen(index)}
              tabIndex={front ? 0 : -1}
              aria-label={`Open ${picture.alt}`}
            >
              <img
                src={picture.thumb}
                alt={picture.alt}
                decoding="async"
                referrerPolicy="no-referrer"
                onLoad={(event) => {
                  if (!photograph(event.currentTarget)) lose(picture)
                }}
                onError={() => lose(picture)}
              />
              <span className="gallery-host">{picture.host}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="card-summary">None of the pictures would load.</p>
      )}

      <Sources card={card} style={{ '--i': 2 + pictures.length } as CSSProperties} />

      {open !== null && pictures[open] && front ? (
        <Lightbox
          pictures={pictures}
          index={open}
          onStep={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  )
}

interface LightboxProps {
  pictures: CardPicture[]
  index: number
  onStep: (index: number) => void
  onClose: () => void
}

/**
 * One picture at full size, inside the card it came from.
 *
 * Its keys are caught on the way down, before anything else on the page hears
 * them, so Escape closes the picture rather than putting the cards away.
 */
function Lightbox({ pictures, index, onStep, onClose }: LightboxProps) {
  const picture = pictures[index]
  const [src, setSrc] = useState(picture.url)
  const count = pictures.length

  useEffect(() => setSrc(picture.url), [picture.url])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight' && count > 1) onStep((index + 1) % count)
      else if (event.key === 'ArrowLeft' && count > 1) onStep((index - 1 + count) % count)
      else return
      event.stopPropagation()
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [count, index, onClose, onStep])

  return (
    <div className="gallery-lightbox" role="dialog" aria-label={picture.alt}>
      <img
        key={picture.url}
        src={src}
        alt={picture.alt}
        referrerPolicy="no-referrer"
        // The full-size copy is the one most often refused by a host; the
        // tile-sized one has already loaded, so it stands in.
        onError={() => setSrc(picture.thumb)}
      />
      <div className="lightbox-bar">
        <a href={picture.pageUrl} target="_blank" rel="noreferrer noopener" title={picture.alt}>
          {picture.host}
          <ArrowUpRight size={12} strokeWidth={2.2} />
        </a>
        <span>
          {index + 1} / {count}
        </span>
      </div>
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close picture">
        <X size={16} strokeWidth={2.2} />
      </button>
      {count > 1 ? (
        <>
          <button
            type="button"
            className="lightbox-step"
            data-dir="back"
            onClick={() => onStep((index - 1 + count) % count)}
            aria-label="Previous picture"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            className="lightbox-step"
            data-dir="next"
            onClick={() => onStep((index + 1) % count)}
            aria-label="Next picture"
          >
            <ChevronRight size={20} />
          </button>
        </>
      ) : null}
    </div>
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
