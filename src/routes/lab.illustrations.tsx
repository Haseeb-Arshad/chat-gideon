import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Stage } from '../components/stage/Stage'
import { GlassFilters } from '../components/LiquidGlass'
import { EmotionField } from '../components/EmotionField'
import { ANCHORS } from '../lib/mood'
import { readCard } from '../lib/cards/read'
import type { CardV2 } from '../lib/cards/schema'
import example from '../lab/illustration-example.json'

/** Development preview of the synthetic request produced by the deliberate live smoke. */
function IllustrationLab() {
  const { live } = Route.useSearch()
  const [card, setCard] = useState<CardV2 | null>(null)
  const [error, setError] = useState(false)
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const controller = new AbortController()
    const source = live ? fetch('/output/illustrations/http-card.json', { signal: controller.signal }).then(response => response.json()) : Promise.resolve(example)
    source.then(value => {
      const drawing = readCard(value)
      if (drawing?.recipe !== 'illustration') throw new Error('Missing illustration')
      setCard(drawing)
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [live])
  if (!import.meta.env.DEV) return <main className="not-found">The lab is only open while developing.</main>
  return <GlassFilters><main style={{ minHeight: '100vh', padding: '24px 12px', position: 'relative' }}>
    <EmotionField mood={ANCHORS.neutral} active={false} />
    <header style={{ maxWidth: 940, margin: '0 auto 20px' }}><h1 style={{ font: '24px system-ui' }}>Interactive drawing preview</h1><p>{live ? 'Synthetic subject · live HTTP turn · unedited provider draft' : 'Synthetic subject · reviewed provider draft · local renderer'}</p>{card ? <button type="button" onClick={() => setHidden(value => !value)}>{hidden ? 'Show drawing' : 'Put drawing away'}</button> : null}</header>
    {error ? <p>Generate the sample with the illustration live smoke test, then reload this page.</p> : card ? <div className="lab-stage" style={{ width: 'min(100%, 940px)', height: 820, margin: '0 auto' }}>
      {!hidden ? <Stage entries={[{ id: 'illustration-preview', query: card.query, hint: 'drawing', card, leaving: false }]} frontId="illustration-preview" tucking={false} spoken="" onFocus={() => undefined} onTuck={() => setHidden(true)} /> : null}
    </div> : <p role="status">Loading sample…</p>}
  </main></GlassFilters>
}

export const Route = createFileRoute('/lab/illustrations')({ validateSearch: (search: Record<string, unknown>) => ({ live: search.live === '1' || search.live === 1 || search.live === true || search.live === 'true' }), component: IllustrationLab, head: () => ({ meta: [{ title: 'Drawing preview · GIDEON' }, { name: 'robots', content: 'noindex' }] }) })
