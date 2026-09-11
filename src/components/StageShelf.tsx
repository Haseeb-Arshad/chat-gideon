import type { CSSProperties } from 'react'
import type { CardKind } from '../lib/cards'
import type { StageEntry } from './ResearchStage'

/**
 * Where cards wait once the conversation has moved on.
 *
 * Each is a tab at the right edge of the screen, mostly out of sight, showing
 * its picture or its initial. Pointing at one slides it out far enough to read
 * its name; pressing it brings the card back to the middle of the room, and
 * the face goes back to the corner to look at it. The same happens by itself
 * when the conversation returns to a card's topic.
 */

const KIND_LABEL: Record<CardKind, string> = {
  entity: 'Card',
  figure: 'Figure',
  news: 'News',
  answer: 'Answer',
  gallery: 'Pictures',
}

/** The newest few, newest at the top. */
const SHELF_SIZE = 5

export function StageShelf({
  entries,
  onShow,
}: {
  entries: StageEntry[]
  onShow: (id: string) => void
}) {
  // Only cards: a searching pane that never became one has nothing to come back to.
  const shelved = entries
    .filter((entry) => entry.card && !entry.leaving)
    .slice(-SHELF_SIZE)
    .reverse()
  if (!shelved.length) return null

  return (
    <nav className="stage-shelf" aria-label="Cards put away">
      {shelved.map((entry, index) => {
        const card = entry.card!
        // Optional on purpose: a card from a server one release older has no pictures.
        const picture = card.image?.url ?? card.pictures?.[0]?.thumb
        return (
          <button
            type="button"
            className="shelf-tab"
            key={entry.id}
            onClick={() => onShow(entry.id)}
            style={{ '--i': index } as CSSProperties}
            aria-label={`Bring back ${card.title}`}
          >
            <span className="shelf-thumb" data-kind={card.kind}>
              {picture ? (
                <img src={picture} alt="" decoding="async" referrerPolicy="no-referrer" />
              ) : (
                <b>{card.title.charAt(0)}</b>
              )}
            </span>
            <span className="shelf-text">
              <span>{card.title}</span>
              <small>{KIND_LABEL[card.kind]}</small>
            </span>
          </button>
        )
      })}
    </nav>
  )
}
