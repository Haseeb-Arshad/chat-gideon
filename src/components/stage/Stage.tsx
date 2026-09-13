import { useRef } from 'react'
import type { CardV2 } from '../../lib/cards/schema'
import { CardFrame, type Slot } from './CardFrame'
import type { SearchHint } from './SearchingFace'

/**
 * What GIDEON found, on panes of glass.
 *
 * The newest card holds the middle of the room. The one before it steps back
 * to the right edge and waits there, half visible, and a tap brings it
 * forward again. Anything older is held out of sight behind that one. When the
 * conversation moves on, all of them slide off to the right together and wait
 * on the shelf at the edge of the screen until their topic comes back.
 */

export interface StageEntry {
  /** The turn and the tool call it came from, so a card finds its pane. */
  id: string
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
}

export function Stage({ entries, frontId, tucking, spoken, onFocus, onTuck }: StageProps) {
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
      // The card in front decides how much room is left for the one peeking beside it.
      data-front-size={front?.card?.size ?? 'standard'}
      role="region"
      aria-label="What GIDEON found"
    >
      {entries.map((entry) => (
        <CardFrame
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
