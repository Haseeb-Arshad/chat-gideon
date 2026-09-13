import { Maximize2 } from 'lucide-react'
import { useState } from 'react'
import type { CardImage, CardPicture, CardSource } from '../../../lib/cards/schema'
import { Lightbox } from '../Lightbox'

export type MediaShape = 'tall' | 'wide'

interface MediaProps {
  image: CardImage
  sources: CardSource[]
  /** Only the card in front can be opened; the ones behind it are scenery. */
  front: boolean
  onShape: (shape: MediaShape) => void
  onError: () => void
}

/**
 * The card's own picture, in the shape the full-size viewer takes.
 *
 * The viewer wants somewhere to send you, and a card keeps its picture's
 * credit rather than the page it came from, so the source whose host matches
 * that credit is the page being credited. Failing that, the first source is
 * where the card came from, and failing that the picture is its own page.
 */
function imageAsPicture(image: CardImage, sources: CardSource[]): CardPicture {
  const from = sources.find((source) => source.host === image.credit) ?? sources[0]
  return {
    url: image.url,
    thumb: image.url,
    alt: image.alt,
    pageUrl: from?.url ?? image.url,
    host: image.credit || from?.host || 'source',
  }
}

export function Media({ image, sources, front, onShape, onError }: MediaProps) {
  const [zoomed, setZoomed] = useState(false)

  return (
    <>
      <figure className="card-media">
        <button
          type="button"
          className="card-media-hit"
          onClick={() => setZoomed(true)}
          aria-label={`See ${image.alt} at full size`}
        >
          <img
            src={image.url}
            alt={image.alt}
            decoding="async"
            referrerPolicy="no-referrer"
            // The file is the only honest account of its own shape: a chart
            // arrives wider than it is tall and must not be cropped to fit a
            // column drawn for a face.
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth && naturalHeight) {
                onShape(naturalWidth > naturalHeight * 1.15 ? 'wide' : 'tall')
              }
            }}
            onError={onError}
          />
          <span className="card-media-zoom" aria-hidden="true">
            <Maximize2 size={13} strokeWidth={2.2} />
          </span>
        </button>
        <figcaption>{image.credit}</figcaption>
      </figure>

      {zoomed && front ? (
        <Lightbox
          pictures={[imageAsPicture(image, sources)]}
          index={0}
          onStep={() => undefined}
          onClose={() => setZoomed(false)}
        />
      ) : null}
    </>
  )
}
