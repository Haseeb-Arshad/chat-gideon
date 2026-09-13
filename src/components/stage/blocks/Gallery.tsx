import { useState, type CSSProperties, type ReactNode } from 'react'
import type { CardPicture } from '../../../lib/cards/schema'
import { Lightbox } from '../Lightbox'

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

interface GalleryProps {
  pictures: CardPicture[]
  front: boolean
  /** Where in the card's rising order the first tile comes. */
  first: number
  /** Told how many tiles are showing, so what follows can rise after them. */
  children?: (shown: number) => ReactNode
}

export function Gallery({ pictures: all, front, first, children }: GalleryProps) {
  // A picture that will not load is taken out rather than left as a hole;
  // whatever remains is laid out again as if it had never been there.
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState<number | null>(null)
  const usable = all.filter((picture) => !failed.has(picture.thumb))
  const pictures = usable.slice(0, galleryCount(usable.length))
  const lose = (picture: CardPicture) => setFailed((current) => new Set(current).add(picture.thumb))

  return (
    <>
      {pictures.length ? (
        <div className="gallery-grid" data-count={pictures.length}>
          {pictures.map((picture, index) => (
            <button
              type="button"
              className="gallery-tile"
              key={picture.thumb}
              style={{ '--i': first + index } as CSSProperties}
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

      {children?.(pictures.length)}

      {open !== null && pictures[open] && front ? (
        <Lightbox pictures={pictures} index={open} onStep={setOpen} onClose={() => setOpen(null)} />
      ) : null}
    </>
  )
}
