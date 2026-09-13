import { ArrowUpRight } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { CardSource } from '../../../lib/cards/schema'

/** Where a card came from: each site's name, which opens its page in a new tab. */
export function Sources({ sources, style }: { sources: CardSource[]; style?: CSSProperties }) {
  if (!sources.length) return null
  return (
    <ul className="card-sources" style={style}>
      {sources.map((source) => (
        <li key={source.url}>
          <a href={source.url} target="_blank" rel="noreferrer noopener" title={source.title}>
            {source.host}
            <ArrowUpRight size={11} strokeWidth={2.2} />
          </a>
        </li>
      ))}
    </ul>
  )
}
