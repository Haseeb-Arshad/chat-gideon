import { useRef, type CSSProperties } from 'react'
import type { CardV2 } from '../../lib/cards/schema'
import { CardFrame, type Slot } from './CardFrame'
import type { SearchHint } from './SearchingFace'

/**
 * What GIDEON found, on panes of glass.
 *
 * The card being talked about is large. Every other card of the conversation
 * stands beside it, whole and small, in a column: the most recent at the top,
 * and past three, the rest wait behind the last with a count. Pressing one
 * brings it forward, and the one that was in front shrinks into its place, so
 * nothing is ever half off the screen. When the conversation moves on, all of
 * them slide off to the right together and wait on the shelf at the edge of the
 * screen until their topic comes back.
 */

/** How many cards stand beside the one in front before the rest wait behind the last. */
export const SIDE_MAX = 3

export interface StageEntry {
  /** The turn and the tool call it came from, so a card finds its pane. */
  id: string
  /** Stable server-issued artifact identity, present after a card lands. */
  artifactId?: string
  /** Server-issued display version, incremented when the card grows. */
  displayRevision?: number
  sourceTurnId?: string
  /** What is being looked up, shown while the search runs. */
  query: string
  /** What kind of search is running, for the pane shown before the card. */
  hint: SearchHint
  /** Null while the search is still running. */
  card: CardV2 | null
  /** Dissolving because nothing came of it, so there is nothing to put away. */
  leaving: boolean
}

interface StageProps {
  entries: StageEntry[]
  frontId: string | null
  /** Everything is sliding off to the shelf at the right edge. */
  tucking: boolean
  /** What GIDEON has said aloud so far, so facts can light up as they are spoken. */
  spoken: string
  onFocus: (id: string) => void
  /** Put every card away, as the close button does. */
  onTuck: () => void
  /** Asks a follow-up question from a card, as if it had been typed. */
  onAsk?: (text: string) => void
}

export function Stage({ entries, frontId, tucking, spoken, onFocus, onTuck, onAsk }: StageProps) {
  // A card on its way out keeps the place it had, rather than jumping to the
  // front as it goes, so the last known slot of every card is remembered.
  const slots = useRef(new Map<string, { slot: Slot; index: number }>())
  const live = entries.filter((entry) => !entry.leaving)
  const front = live.find((entry) => entry.id === frontId) ?? live.at(-1)
  // The most recent first, so the card just talked about is nearest the top.
  const others = live.filter((entry) => entry !== front).reverse()
  const side = others.slice(0, SIDE_MAX)
  const waiting = others.length - side.length
  for (const entry of live) {
    const index = side.indexOf(entry)
    slots.current.set(
      entry.id,
      entry === front ? { slot: 'front', index: 0 } : index >= 0 ? { slot: 'side', index } : { slot: 'behind', index: side.length - 1 },
    )
  }
  for (const id of slots.current.keys()) {
    if (!entries.some((entry) => entry.id === id)) slots.current.delete(id)
  }

  return (
    <div
      className="research-stage"
      data-tucking={tucking}
      data-layout={side.length ? 'split' : 'single'}
      style={{ '--side-n': Math.max(side.length, 1) } as CSSProperties}
      role="region"
      aria-label="What GIDEON found"
    >
      {entries.map((entry) => (
        <CardFrame
          key={entry.id}
          entry={entry}
          slot={slots.current.get(entry.id)?.slot ?? 'front'}
          sideIndex={slots.current.get(entry.id)?.index ?? 0}
          spoken={entry === front ? spoken : ''}
          behind={entry === side.at(-1) ? waiting : 0}
          quiet={tucking}
          onFocus={onFocus}
          onTuck={onTuck}
          onAsk={onAsk}
        />
      ))}
    </div>
  )
}
