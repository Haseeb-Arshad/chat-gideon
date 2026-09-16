import { usePostHog } from '@posthog/react'
import type { CSSProperties } from 'react'
import { RECIPES } from '../lib/cards/recipes'
import { cardThumbnail } from '../lib/cards/schema'
import { GlassButton } from './LiquidGlass'
import type { StageEntry } from './stage/Stage'

/**
 * Where cards wait once the conversation has moved on.
 *
 * Each is a tab at the right edge of the screen, mostly out of sight, showing
 * its picture or its initial. Pointing at one slides it out far enough to read
 * its name; pressing it brings the card back to the middle of the room, and
 * the face goes back to the corner to look at it. The same happens by itself
 * when the conversation returns to a card's topic.
 */

/** The newest few, newest at the top. */
const SHELF_SIZE = 5

export function StageShelf({
  entries,
  onShow,
}: {
  entries: StageEntry[]
  onShow: (id: string) => void
}) {
  const posthog = usePostHog()

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
        const picture = cardThumbnail(card)
        return (
          <GlassButton
            type="button"
            className="shelf-tab"
            key={entry.id}
            onClick={() => {
              posthog.capture('card_restored', {
                card_recipe: card.recipe,
                shelf_position: index,
              })
              onShow(entry.id)
            }}
            style={{ '--i': index } as CSSProperties}
            aria-label={`Bring back ${card.title}`}
          >
            <span className="shelf-thumb" data-recipe={card.recipe}>
              {picture ? (
                <img src={picture} alt="" decoding="async" referrerPolicy="no-referrer" />
              ) : (
                <b>{card.title.charAt(0)}</b>
              )}
            </span>
            <span className="shelf-text">
              <span>{card.title}</span>
              <small>{RECIPES[card.recipe].label}</small>
            </span>
          </GlassButton>
        )
      })}
    </nav>
  )
}
