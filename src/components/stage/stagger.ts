import type { CSSProperties } from 'react'
import type { Block } from '../../lib/cards/schema'

/**
 * Every piece of a card rises in turn, so it reads top to bottom as it arrives
 * rather than landing as one block.
 *
 * The place of each piece in that line is worked out by the layout before any
 * block renders, not counted as they render: a block is a component, and a
 * component renders after the parent has already built the elements around
 * it, so a counter shared between them would hand the sources at the bottom
 * their place before the headline at the top had asked for one.
 */
export function rise(index: number): CSSProperties {
  return { '--i': index } as CSSProperties
}

/**
 * How many pieces of a block rise one after another. A picture arrives on its
 * own. A table, a timeline or a list rises as one piece, and its rows follow
 * each other inside it on a shorter beat, so a long table does not hold back
 * everything under it.
 */
export function risesIn(block: Block): number {
  switch (block.type) {
    case 'headline':
      return 1 + (block.kicker ? 1 : 0) + (block.subtitle ? 1 : 0)
    case 'prose':
      return block.paragraphs.length
    case 'facts':
      return block.items.length
    case 'gallery':
      return block.pictures.length
    case 'media':
      return 0
    case 'stat':
    case 'table':
    case 'timeline':
    case 'note':
    case 'list':
    case 'steps':
    case 'chips':
    case 'quote':
      return 1
  }
}

/** Where each block's first piece rises, and where whatever follows the blocks does. */
export function risePlan(blocks: Block[], start = 0): { starts: number[]; after: number } {
  let order = start
  const starts = blocks.map((block) => {
    const first = order
    order += risesIn(block)
    return first
  })
  return { starts, after: order }
}
