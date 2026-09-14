import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { mastheadDate, whenPublished } from '../../../lib/cards/dateline'
import type { StoriesBlock, StoryItem } from '../../../lib/cards/schema'
import { rise, useFirst } from '../stagger'

/**
 * The news, as a front page: a masthead over a double rule, the lead story
 * with its picture, and a column of the stories after it.
 *
 * Every headline and deck is the publisher's own, and each story's dateline
 * names the outlet it links to, so the page credits its sources story by story
 * and needs no row of them underneath. The whole of a story opens it, not just
 * its headline, the way a finger lands on a newspaper.
 */

const beat = (index: number) => ({ '--row': index }) as CSSProperties

interface StoryProps {
  story: StoryItem
  /** When the card was first drawn, so a dateline does not tick over while it is being read. */
  now: number
  front: boolean
  said: boolean
  style?: CSSProperties
}

function Dateline({ story, now }: { story: StoryItem; now: number }) {
  const when = whenPublished(story.published, { now })
  return (
    <p className="story-dateline">
      <span>{story.host}</span>
      {when ? (
        // Said against the reader's clock, which the server that first rendered the page does not share.
        <time dateTime={story.published} suppressHydrationWarning>
          {when}
        </time>
      ) : null}
      {story.outlets > 1 ? <span>{story.outlets} outlets</span> : null}
    </p>
  )
}

function Headline({ story, front }: { story: StoryItem; front: boolean }) {
  return (
    <h3 className="story-headline">
      <a href={story.url} target="_blank" rel="noreferrer noopener" tabIndex={front ? 0 : -1}>
        {story.headline}
      </a>
    </h3>
  )
}

function LeadStory({ story, now, front, said, style }: StoryProps) {
  // By address, so a lead that changes gets a fresh chance to show its picture.
  const [failed, setFailed] = useState<string | null>(null)
  const picture = story.image && story.image !== failed ? story.image : null
  return (
    <article className="front-lead" style={style} data-picture={picture ? 'yes' : 'none'} data-said={said ? 'true' : undefined}>
      {picture ? (
        <figure className="front-picture">
          {/* The headline says what the picture is of; nothing is known that would describe it better. */}
          <img src={picture} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(picture)} />
        </figure>
      ) : null}
      <Dateline story={story} now={now} />
      <Headline story={story} front={front} />
      {story.deck ? <p className="story-deck">{story.deck}</p> : null}
    </article>
  )
}

function Story({ story, now, front, said, style, offPage = false }: StoryProps & { offPage?: boolean }) {
  return (
    <article
      className="front-story"
      style={style}
      data-story={story.id}
      data-said={said && !offPage ? 'true' : undefined}
      data-off-page={offPage ? 'true' : undefined}
      // Out of sight is out of reach: no focus lands on it, and no reader reads it out.
      aria-hidden={offPage || undefined}
    >
      <Dateline story={story} now={now} />
      <Headline story={story} front={front && !offPage} />
      {story.deck ? <p className="story-deck">{story.deck}</p> : null}
    </article>
  )
}

/**
 * The stories in the column that did not fit on the page.
 *
 * The stylesheet decides what fits: on a feature the column is as tall as the
 * stage, and a story that would run past its foot wraps into a second column,
 * out of sight, rather than being cut in half. This only reads where each
 * story landed, so a story no one can see cannot be tabbed to, read out by a
 * screen reader, or lit up as it is spoken.
 *
 * It is read after every render, before the paint, and again whenever the
 * column or a story in it changes size. The first is not left to the
 * observer: a page that is not visible runs no rendering steps, so the
 * observer never reports, and a story judged out of sight at one size would
 * stay unreachable at another.
 */
function useOffPage(items: StoryItem[]) {
  const column = useRef<HTMLDivElement | null>(null)
  const [offPage, setOffPage] = useState<ReadonlySet<string>>(() => new Set())

  const settle = useRef(() => {
    const node = column.current
    if (!node) return
    const width = node.clientWidth
    const off = new Set<string>()
    // Nothing laid out measures zero, and nothing is known to be out of sight.
    if (width > 0) {
      for (const child of node.children) {
        if (child instanceof HTMLElement && child.dataset.story && child.offsetLeft >= width) off.add(child.dataset.story)
      }
    }
    setOffPage((current) => (current.size === off.size && [...off].every((id) => current.has(id)) ? current : off))
  }).current

  useLayoutEffect(settle)
  useLayoutEffect(() => {
    const node = column.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(settle)
    observer.observe(node)
    for (const child of node.children) observer.observe(child)
    return () => observer.disconnect()
  }, [items, settle])
  return [column, offPage] as const
}

interface FrontPageProps {
  title: string
  block: StoriesBlock
  front: boolean
  /** The stories being briefed aloud. */
  said: Set<string>
}

export function FrontPage({ title, block, front, said }: FrontPageProps) {
  const now = useFirst(Date.now())
  const [lead, ...more] = block.items
  const [column, offPage] = useOffPage(block.items)
  return (
    <div className="card-front">
      <header className="front-masthead" style={rise(0)}>
        <h2 className="front-title">{title}</h2>
        <p className="front-date" suppressHydrationWarning>
          {mastheadDate(block.since, { now })}
        </p>
      </header>
      <div className="front-grid" data-more={more.length}>
        {lead ? <LeadStory story={lead} now={now} front={front} said={said.has(lead.id)} style={rise(1)} /> : null}
        {more.length ? (
          <div className="front-more" ref={column}>
            {more.map((story, index) => (
              <Story
                key={story.id}
                story={story}
                now={now}
                front={front}
                said={said.has(story.id)}
                offPage={offPage.has(story.id)}
                style={rise(2 + index)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Stories on a card that is not a front page: one under another, as a list is. */
export function StoryList({ block, start, front, said }: { block: StoriesBlock; start: number; front: boolean; said: Set<string> }) {
  const now = useFirst(Date.now())
  return (
    <div className="card-stories" style={rise(start)}>
      {block.items.map((story, index) => (
        <Story key={story.id} story={story} now={now} front={front} said={said.has(story.id)} style={beat(index)} />
      ))}
    </div>
  )
}
