import { ArrowUpRight } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { ListBlock, StepsBlock, TimelineBlock } from '../../../lib/cards/schema'
import { rise } from '../stagger'

/**
 * The blocks that are a sequence: dated events, a list of things, and steps to
 * follow. Each rises as one piece, and its items follow each other inside it.
 */

const beat = (index: number) => ({ '--row': index }) as CSSProperties

/** Dated events along a line: down the card, or across it on a wide one. */
export function Timeline({ block, start }: { block: TimelineBlock; start: number }) {
  return (
    <ol className="card-timeline card-well" style={rise(start)} data-count={block.events.length}>
      {block.events.map((event, index) => (
        <li className="timeline-event" key={event.id} style={beat(index)}>
          <time>{event.date}</time>
          <i aria-hidden="true" />
          <span className="timeline-label">{event.label}</span>
          {event.detail ? <span className="timeline-detail">{event.detail}</span> : null}
        </li>
      ))}
    </ol>
  )
}

export function List({ block, start, front }: { block: ListBlock; start: number; front: boolean }) {
  const Tag = block.ordered ? 'ol' : 'ul'
  return (
    <Tag className="card-list" style={rise(start)} data-ordered={block.ordered}>
      {block.items.map((item, index) => {
        const body = (
          <>
            {item.thumb ? <img src={item.thumb} alt="" decoding="async" referrerPolicy="no-referrer" /> : null}
            <span className="card-list-text">
              <span className="card-list-title">{item.title}</span>
              {item.meta ? <small>{item.meta}</small> : null}
            </span>
          </>
        )
        return (
          <li key={item.id} style={beat(index)}>
            {item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer noopener" tabIndex={front ? 0 : -1}>
                {body}
                <ArrowUpRight className="card-list-go" size={13} strokeWidth={2.2} aria-hidden="true" />
              </a>
            ) : (
              <div>{body}</div>
            )}
          </li>
        )
      })}
    </Tag>
  )
}

/** Steps to follow, numbered the way a recipe book numbers them. */
export function Steps({ block, start }: { block: StepsBlock; start: number }) {
  return (
    <ol className="card-steps" style={rise(start)}>
      {block.items.map((step, index) => (
        <li key={index} style={beat(index)}>
          <b aria-hidden="true">{index + 1}</b>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}
