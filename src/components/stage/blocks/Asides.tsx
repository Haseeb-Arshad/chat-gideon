import { Clock3, Info, Scale, Timer } from 'lucide-react'
import type { ChipsBlock, NoteBlock, QuoteBlock } from '../../../lib/cards/schema'
import { rise } from '../stagger'

/**
 * The blocks beside the answer rather than in it: a caveat, the questions
 * worth asking next, and a pull quote.
 */

const NOTE_ICON = {
  info: Info,
  stale: Clock3,
  disagree: Scale,
  delayed: Timer,
} as const

/** A caveat. Its tone is said by an icon and by its words, never by colour alone. */
export function Note({ block, start }: { block: NoteBlock; start: number }) {
  const Icon = NOTE_ICON[block.tone]
  return (
    <p className="card-note" data-tone={block.tone} style={rise(start)}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <span>{block.text}</span>
    </p>
  )
}

/** Follow-up questions. Pressing one asks it, exactly as if it had been typed. */
export function Chips({
  block,
  start,
  front,
  onAsk,
}: {
  block: ChipsBlock
  start: number
  front: boolean
  onAsk?: (text: string) => void
}) {
  return (
    <div className="card-chips" style={rise(start)} role="group" aria-label="Ask next">
      {block.items.map((chip) => (
        <button
          type="button"
          key={chip.label}
          onClick={() => onAsk?.(chip.ask)}
          disabled={!front || !onAsk}
          title={chip.ask === chip.label ? undefined : chip.ask}
        >
          {chip.label}
        </button>
      ))}
    </div>
  )
}

/** Words someone said, exactly as the page they were read on has them. */
export function Quote({ block, start }: { block: QuoteBlock; start: number }) {
  return (
    <blockquote className="card-quote" style={rise(start)}>
      <p>{block.text}</p>
      {block.who ? <footer>{block.who}</footer> : null}
    </blockquote>
  )
}
