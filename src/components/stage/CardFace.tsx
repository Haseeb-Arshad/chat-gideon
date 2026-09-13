import { blockOf, type Block, type CardV2, type MediaBlock } from '../../lib/cards/schema'
import { Chips, Note, Quote } from './blocks/Asides'
import { Gallery } from './blocks/Gallery'
import { Media, type MediaShape } from './blocks/Media'
import { List, Steps, Timeline } from './blocks/Sequences'
import { Sources } from './blocks/Sources'
import { Table } from './blocks/Table'
import { Facts, Headline, Prose, Stat } from './blocks/TextBlocks'
import { rise, risePlan } from './stagger'

/**
 * A card's face: its blocks, laid out by its recipe.
 *
 * Two layouts exist so far. The classic one is the card as it has always
 * looked, a picture down the side (or across the top) beside a column of
 * words, and every recipe without a layout of its own uses it, block by block
 * in the order the card lists them. The gallery lays its pictures out in a
 * grid under its heading.
 */

export interface CardFaceProps {
  card: CardV2
  /** The lead picture, or null once it has failed to load. */
  media: MediaBlock | null
  /** What GIDEON has said aloud so far, so facts can light up as they are spoken. */
  spoken: string
  /** Only the card in front can be opened or pressed. */
  front: boolean
  onShape: (shape: MediaShape) => void
  onMediaError: () => void
  /** Asks a follow-up question as if it had been typed. */
  onAsk?: (text: string) => void
}

export function CardFace(props: CardFaceProps) {
  return props.card.recipe === 'gallery' ? <GalleryLayout {...props} /> : <ClassicLayout {...props} />
}

interface BodyBlockProps {
  block: Block
  start: number
  spoken: string
  front: boolean
  onAsk?: (text: string) => void
}

function BodyBlock({ block, start, spoken, front, onAsk }: BodyBlockProps) {
  switch (block.type) {
    case 'headline':
      return <Headline block={block} start={start} />
    case 'stat':
      return <Stat block={block} start={start} />
    case 'prose':
      return <Prose block={block} start={start} />
    case 'facts':
      return <Facts block={block} start={start} spoken={spoken} />
    case 'table':
      return <Table block={block} start={start} />
    case 'timeline':
      return <Timeline block={block} start={start} />
    case 'note':
      return <Note block={block} start={start} />
    case 'list':
      return <List block={block} start={start} front={front} />
    case 'steps':
      return <Steps block={block} start={start} />
    case 'chips':
      return <Chips block={block} start={start} front={front} onAsk={onAsk} />
    case 'quote':
      return <Quote block={block} start={start} />
    case 'media':
    case 'gallery':
      // A picture has its own place, and a gallery its own layout.
      return null
  }
}

function ClassicLayout({ card, media, spoken, front, onShape, onMediaError, onAsk }: CardFaceProps) {
  const body = card.blocks.filter((block) => block.slot !== 'media' && block.type !== 'media')
  const { starts, after } = risePlan(body)

  return (
    <>
      {media ? (
        <Media image={media.image} sources={card.sources} front={front} onShape={onShape} onError={onMediaError} />
      ) : null}
      <div className="card-body">
        {body.map((block, index) => (
          <BodyBlock key={block.id} block={block} start={starts[index]} spoken={spoken} front={front} onAsk={onAsk} />
        ))}
        <Sources sources={card.sources} style={rise(after)} />
      </div>
    </>
  )
}

function GalleryLayout({ card, front }: CardFaceProps) {
  const headline = blockOf(card, 'headline')
  const gallery = blockOf(card, 'gallery')
  const head = headline ? risePlan([headline]).after : 0

  return (
    <div className="card-gallery">
      {headline ? (
        <header className="gallery-head">
          <Headline block={headline} start={0} />
        </header>
      ) : null}
      <Gallery pictures={gallery?.pictures ?? []} front={front} first={head}>
        {(shown) => <Sources sources={card.sources} style={rise(head + shown)} />}
      </Gallery>
    </div>
  )
}
