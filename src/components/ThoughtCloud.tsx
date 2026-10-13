import { Brain, Image, Layers, MessageCircle, PenLine, Search, Timer } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cloudOutline } from '../lib/cloud-shape'
import type { Thought, ThoughtIcon } from '../lib/thoughts'

/**
 * The cloud beside GIDEON's eyes: what it is turning over, in a few words.
 *
 * Three puffs lead up from the face to a cloud, the way a thought is drawn, so
 * it reads as coming from the eyes rather than as a label stuck near them. The
 * cloud is drawn to fit the words, whatever their length. It is decoration for
 * someone watching: the status line under the face already says the same thing
 * to a screen reader, so this stays out of the accessibility tree.
 */

const ICONS: Record<Exclude<ThoughtIcon, 'dots'>, typeof Search> = {
  search: Search,
  picture: Image,
  draw: PenLine,
  memory: Brain,
  topic: MessageCircle,
  card: Layers,
  timer: Timer,
}

/** Long enough for the cloud to drift off before it is taken away. */
const LEAVE_MS = 460

/** Words longer than this go on two lines. */
const ONE_LINE = 18
/** A letter of the cloud's type against the `ch` unit, which leaves out its letter spacing. */
const LETTER = 1.07

/** Half the words and a little slack, since a line can only break at a space. */
function foldedWidth(text: string): string | undefined {
  return text.length > ONE_LINE ? `${((Math.ceil(text.length / 2) + 3) * LETTER).toFixed(1)}ch` : undefined
}

export function ThoughtCloud({ thought }: { thought: Thought | null }) {
  // The last thought is kept while it leaves, so it fades rather than vanishes.
  const [shown, setShown] = useState<Thought | null>(thought)
  const [open, setOpen] = useState(Boolean(thought))

  useEffect(() => {
    if (thought) {
      setShown(thought)
      setOpen(true)
      return
    }
    setOpen(false)
    const timer = setTimeout(() => setShown(null), LEAVE_MS)
    return () => clearTimeout(timer)
    // Keyed on the thought itself, not the object: the page builds a new one each render.
  }, [thought?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  // The cloud is drawn round the words as they were actually laid out, measured
  // before the first paint and again if the font arrives late.
  const bodyRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const measure = () => {
      const width = body.offsetWidth
      const height = body.offsetHeight
      setBox((last) => (last && last.width === width && last.height === height ? last : { width, height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [shown?.key])
  const outline = useMemo(() => (box ? cloudOutline(box.width, box.height) : null), [box])

  if (!shown) return null
  const Icon = shown.icon === 'dots' ? null : ICONS[shown.icon]

  return (
    <div className="thought-cloud" data-open={open} data-kind={shown.kind} aria-hidden="true">
      <span className="thought-puff" />
      <span className="thought-puff" />
      <span className="thought-puff" />
      <div className="thought-body" key={shown.key} ref={bodyRef}>
        {box && outline ? (
          <svg className="thought-shape" width={box.width} height={box.height} viewBox={`0 0 ${box.width} ${box.height}`}>
            <path d={outline.d} />
          </svg>
        ) : null}
        {Icon ? (
          <Icon className="thought-icon" size={15} strokeWidth={1.8} />
        ) : (
          <span className="thought-dots">
            <i />
            <i />
            <i />
          </span>
        )}
        {shown.text ? (
          <span className="thought-text" style={{ maxWidth: foldedWidth(shown.text) }}>
            {shown.text}
          </span>
        ) : null}
      </div>
    </div>
  )
}
