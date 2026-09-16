import { ArrowUpRight, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
 * them, so Escape closes the picture rather than putting the cards away. The
 * dialog takes the focus when it opens, keeps Tab cycling inside itself while
 * it is up, and hands focus back to whatever opened it.
 */
export function Lightbox({ pictures, index, onStep, onClose }: LightboxProps) {
  const picture = pictures[index]
  const [src, setSrc] = useState(picture.url)
  const count = pictures.length
  const dialogRef = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)

  useEffect(() => setSrc(picture.url), [picture.url])

  useEffect(() => {
    opener.current = document.activeElement
    const dialog = dialogRef.current!
    const siblings: Array<{ element: HTMLElement; inert: boolean }> = []
    let branch: HTMLElement = dialog
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          siblings.push({ element: sibling, inert: sibling.inert })
          sibling.inert = true
        }
      }
      branch = branch.parentElement
      if (branch === document.body) break
    }
    const containFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) dialog.focus()
    }
    document.addEventListener('focusin', containFocus)
    dialog.querySelector<HTMLButtonElement>('.lightbox-close')?.focus()
    return () => {
      document.removeEventListener('focusin', containFocus)
      for (const { element, inert } of siblings) element.inert = inert
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'Tab') {
        // Cycle within the dialog: the page behind it is hidden while it is up.
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled])',
        )
        if (!focusable || focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
          event.preventDefault()
          first.focus()
        }
        event.stopPropagation()
        return
      } else if (event.key === 'ArrowRight' && count > 1) onStep((index + 1) % count)
      else if (event.key === 'ArrowLeft' && count > 1) onStep((index - 1 + count) % count)
      else return
      event.stopPropagation()
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [count, index, onClose, onStep])

  return (
    <div className="gallery-lightbox" role="dialog" aria-modal="true" aria-label={picture.alt} ref={dialogRef} tabIndex={-1}>
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
