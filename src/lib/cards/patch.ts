/**
 * A card growing after it first appears.
 *
 * A card is sent as soon as something on it is certain, a portrait and a name
 * say, and grows as the slower parts are ready: the summary once the brief is
 * written, a chart once its series has been fetched. Each growth is a patch:
 * blocks added or replaced by id, blocks taken away, and the card's sources
 * when they have changed. The last patch says the card is no longer partial.
 *
 * A patch crosses the same wire as a card and is read the same way.
 */

import { readBlocks, readSources } from './read'
import type { Block, CardSource, CardV2 } from './schema'

export interface CardPatch {
  /** Blocks to add, or to replace where one with the same id is already there. */
  blocks: Block[]
  /** Ids of blocks to take away. */
  drop: string[]
  /** The card's sources, whole, when they have changed. */
  sources?: CardSource[]
  /** More is still coming. */
  partial: boolean
}

/**
 * A patch as it arrives, or null when there is nothing in it to apply.
 *
 * Block citations are checked against the sources the card will have once the
 * patch is applied, which is the patch's own list when it carries one.
 */
export function readPatch(value: unknown, sourcesOnCard = 8): CardPatch | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const sources = Array.isArray(input.sources) ? readSources(input.sources) : undefined
  const blocks = readBlocks(input.blocks, sources?.length ?? sourcesOnCard)
  const drop = (Array.isArray(input.drop) ? input.drop : [])
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64)
    .slice(0, 40)
  const partial = input.partial === true
  if (!blocks.length && !drop.length && !sources && partial) return null
  return { blocks, drop, ...(sources ? { sources } : {}), partial }
}

/**
 * The card with the patch applied.
 *
 * A replaced block keeps its place, so a summary that arrives where a
 * placeholder stood appears there rather than at the bottom; a new block goes
 * after the others. A patch that would leave nothing to draw is ignored, since
 * taking every block away is not how a card is withdrawn.
 */
export function applyPatch(card: CardV2, patch: CardPatch): CardV2 {
  const sources = patch.sources ?? card.sources
  const incoming = new Map(patch.blocks.map((block) => [block.id, block]))
  const dropped = new Set(patch.drop)

  const blocks: Block[] = []
  for (const block of card.blocks) {
    if (dropped.has(block.id)) continue
    const replacement = incoming.get(block.id)
    blocks.push(replacement ?? block)
    incoming.delete(block.id)
  }
  blocks.push(...incoming.values())
  if (!blocks.length) return card

  return {
    ...card,
    sources,
    // A citation to a source the card no longer has is left off rather than
    // pointing at the wrong page.
    blocks: blocks.map((block) => {
      if (!block.cite) return block
      const cite = block.cite.filter((index) => index < sources.length)
      if (cite.length === block.cite.length) return block
      const { cite: _dropped, ...rest } = block
      return (cite.length ? { ...rest, cite } : rest) as Block
    }),
    partial: patch.partial,
  }
}
