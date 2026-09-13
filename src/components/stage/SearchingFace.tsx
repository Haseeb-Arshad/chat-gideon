import { rise } from './stagger'

export type SearchHint = 'web' | 'pictures'

/** The pane shown while a search runs: the question, and something breathing where the answer will be. */
export function SearchingFace({ query, hint }: { query: string; hint: SearchHint }) {
  return (
    <div className="card-searching" data-hint={hint}>
      <p className="card-kicker">
        <span className="search-pulse" aria-hidden="true" />
        {hint === 'pictures' ? 'Finding pictures' : 'Searching the web'}
      </p>
      <h2 className="card-query">{query || (hint === 'pictures' ? 'Pictures' : 'Looking that up')}</h2>
      {hint === 'pictures' ? (
        <div className="search-tiles" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <i key={index} style={rise(index)} />
          ))}
        </div>
      ) : (
        <div className="search-lines" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  )
}
