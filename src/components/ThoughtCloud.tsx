import { Brain, Image, Layers, MessageCircle, PenLine, Search, Timer } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Thought, ThoughtIcon } from '../lib/thoughts'

/**
 * The cloud beside GIDEON's eyes: what it is turning over, in a few words.
 *
 * Three puffs lead up from the face to a small panel, the way a thought is
 * drawn, so it reads as coming from the eyes rather than as a label stuck near
 * them. It is decoration for someone watching: the status line under the face
 * already says the same thing to a screen reader, so this stays out of the
 * accessibility tree.
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

  if (!shown) return null
  const Icon = shown.icon === 'dots' ? null : ICONS[shown.icon]

  return (
    <div className="thought-cloud" data-open={open} data-kind={shown.kind} aria-hidden="true">
      <span className="thought-puff" />
      <span className="thought-puff" />
      <span className="thought-puff" />
      <div className="thought-body" key={shown.key}>
        {Icon ? (
          <Icon size={14} strokeWidth={1.8} />
        ) : (
          <span className="thought-dots">
            <i />
            <i />
            <i />
          </span>
        )}
        {shown.text ? <span className="thought-text">{shown.text}</span> : null}
      </div>
    </div>
  )
}
