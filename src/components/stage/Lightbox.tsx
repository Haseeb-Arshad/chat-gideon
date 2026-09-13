import { ArrowUpRight, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CardPicture } from '../../lib/cards/schema'

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
export function Lightbox({ pictures, index, onStep, onClose }: LightboxProps) {
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
