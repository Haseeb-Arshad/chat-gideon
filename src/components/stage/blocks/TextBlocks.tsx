import type { FactsBlock, HeadlineBlock, ProseBlock, StatBlock } from '../../../lib/cards/schema'
import { factSpoken } from '../../../lib/cards/spoken'
import { rise } from '../stagger'

/**
 * The blocks made of words: a headline, the one number an answer is, a short
 * paragraph, and the facts worth reading at a glance. Each is told where in
 * the card's rising order its first piece comes.
 */

export function Headline({ block, start }: { block: HeadlineBlock; start: number }) {
  let order = start
  return (
    <>
      {block.kicker ? (
        <p className="card-kicker" style={rise(order++)}>
          {block.kicker}
        </p>
      ) : null}
      <h2 className="card-title" style={rise(order++)}>
        {block.title}
      </h2>
      {block.subtitle ? (
        <p className="card-subtitle" style={rise(order++)}>
          {block.subtitle}
        </p>
      ) : null}
    </>
  )
}

export function Stat({ block, start }: { block: StatBlock; start: number }) {
  return (
    <p className="card-figure" style={rise(start)}>
      <strong>{block.value}</strong>
      {block.label ? <span>{block.label}</span> : null}
    </p>
  )
}

export function Prose({ block, start }: { block: ProseBlock; start: number }) {
  return (
    <>
      {block.paragraphs.map((paragraph, index) => (
        <p className="card-summary" key={index} style={rise(start + index)}>
          {paragraph}
        </p>
      ))}
    </>
  )
}

/** Facts brighten as GIDEON says them. */
export function Facts({ block, start, spoken }: { block: FactsBlock; start: number; spoken: string }) {
  return (
    <dl className="card-facts">
      {block.items.map((fact, index) => (
        <div
          className="card-fact"
          key={fact.label}
          data-said={factSpoken(fact, spoken)}
          style={rise(start + index)}
        >
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}
