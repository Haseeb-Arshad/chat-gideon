import { usePostHog } from '@posthog/react'
import type { CSSProperties } from 'react'
import { useState } from 'react'
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
  const [allShown, setAllShown] = useState(false)

  // Only cards: a searching pane that never became one has nothing to come back to.
  const cards = entries.filter((entry) => entry.card && !entry.leaving)
  // Everything the fixed shelf cannot show stays one press away rather than
  // falling out of reach: older cards stay in state and can still be restored.
  const shelved = (allShown ? cards : cards.slice(-SHELF_SIZE)).reverse()
  const hidden = cards.length - Math.min(cards.length, SHELF_SIZE)
  if (!shelved.length) return null

  return (
    <nav className="stage-shelf" aria-label="Cards put away">
      {!allShown && hidden > 0 ? (
        <GlassButton
          type="button"
          className="shelf-tab shelf-more"
          onClick={() => {
            posthog.capture('card_shelf_expanded', { hidden_cards: hidden })
            setAllShown(true)
          }}
          aria-label={`Show ${hidden} older card${hidden === 1 ? '' : 's'}`}
        >
          <span className="shelf-thumb">
            <b>+{hidden}</b>
          </span>
          <span className="shelf-text">
            <span>Earlier cards</span>
            <small>Show all</small>
          </span>
        </GlassButton>
      ) : null}
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
