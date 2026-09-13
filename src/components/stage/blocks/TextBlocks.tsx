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

const DIRECTION_MARK = { up: '▲', down: '▼', flat: '▬' } as const

export function Stat({ block, start }: { block: StatBlock; start: number }) {
  // The first card's figure, exactly, when there is nothing more to it.
  if (!block.change && !block.spark) {
    return (
      <p className="card-figure" style={rise(start)}>
        <strong>{block.value}</strong>
        {block.label ? <span>{block.label}</span> : null}
      </p>
    )
  }
  const { change, spark } = block
  return (
    <div className="card-figure" style={rise(start)}>
      <strong>{block.value}</strong>
      {block.label ? <span>{block.label}</span> : null}
      {change ? (
        <p className="card-change" data-direction={change.direction}>
          <b aria-hidden="true">{DIRECTION_MARK[change.direction]}</b>
          {change.value}
          {change.period ? <small>{change.period}</small> : null}
          {change.formula ? (
            <abbr className="card-derived" title={`Worked out: ${change.formula}`}>
              computed
            </abbr>
          ) : null}
        </p>
      ) : null}
      {spark ? <Sparkline values={spark} /> : null}
    </div>
  )
}

/**
 * The shape of a number's recent past, in one line, with its latest point
 * marked. Drawn to its own scale: it shows the shape, and the number beside it
 * says the size.
 */
function Sparkline({ values }: { values: number[] }) {
  const width = 132
  const height = 32
  const pad = 3
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = high - low || 1
  const x = (index: number) => pad + (index / (values.length - 1)) * (width - pad * 2)
  const y = (value: number) => pad + (1 - (value - low) / span) * (height - pad * 2)
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ')
  const last = values.length - 1
  return (
    <svg className="card-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      <polyline points={points} fill="none" />
      <circle cx={x(last)} cy={y(values[last])} r={3} />
    </svg>
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
