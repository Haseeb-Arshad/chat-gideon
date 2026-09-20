import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { EmotionField } from '../components/EmotionField'
import { GlassFilters } from '../components/LiquidGlass'
import { Stage } from '../components/stage/Stage'
import { FIXTURES } from '../lab/fixtures'
import { RECIPES } from '../lib/cards/recipes'
import { CARD_SIZES, type CardSize } from '../lib/cards/schema'
import { ANCHORS, type EyeEmotion } from '../lib/mood'

/**
 * The card lab: every recipe, at any size, over any mood, on a stage the size
 * of a real one. Development only.
 *
 * A card cannot be judged over a plain wall: the glass is invisible there, and
 * a colour that reads over one mood can vanish over another. So the room here
 * is the real one, the mood is chosen, and a striped pattern can be put behind
 * the glass to see the refraction the way it was tuned.
 */

const STAGES = {
  // The open stage on a 1440 × 900 window, and on a 1280 × 720 one, the smallest wide stage.
  '1440 × 900': { width: 913, height: 782 },
  '1280 × 720': { width: 811, height: 602 },
  // Follows the window, for checking a phone by resizing the browser.
  'this window': null,
} as const

type StageName = keyof typeof STAGES

function CardLab() {
  const { visualizations } = Route.useSearch()
  const [mood, setMood] = useState<EyeEmotion>('neutral')
  const [size, setSize] = useState<CardSize | 'recipe'>('recipe')
  const [stage, setStage] = useState<StageName>('1280 × 720')
  const [stripes, setStripes] = useState(false)

  if (!import.meta.env.DEV) {
    return <main className="not-found">The lab is only open while developing.</main>
  }

  const dimensions = STAGES[stage]

  return (
    <GlassFilters>
      <main className="lab">
        <EmotionField mood={ANCHORS[mood]} active={false} />

        <header className="lab-bar">
          <strong>Card lab</strong>
          <Choice label="Mood" value={mood} options={Object.keys(ANCHORS) as EyeEmotion[]} onChange={setMood} />
          <Choice label="Size" value={size} options={['recipe', ...CARD_SIZES] as const} onChange={setSize} />
          <Choice label="Stage" value={stage} options={Object.keys(STAGES) as StageName[]} onChange={setStage} />
          <label className="lab-toggle">
            <input type="checkbox" checked={stripes} onChange={(event) => setStripes(event.target.checked)} />
            Stripes behind the glass
          </label>
        </header>

        <div className="lab-cases">
          {!visualizations ? <ManyCards stage={dimensions} stripes={stripes} /> : null}
          {FIXTURES.filter((fixture) => !visualizations || fixture.id.startsWith('lab:visual-')).map((fixture) => {
            const card = size === 'recipe' ? fixture.card : { ...fixture.card, size }
            return (
              <section className="lab-case" key={fixture.id}>
                <h2>
                  {fixture.name} <small>{RECIPES[card.recipe].label} · {card.size}</small>
                </h2>
                <div
                  className="lab-stage"
                  data-stripes={stripes}
                  style={dimensions ? { width: dimensions.width, height: dimensions.height } : undefined}
                >
                  <Stage
                    entries={[{ id: fixture.id, query: card.query, hint: card.recipe === 'gallery' ? 'pictures' : 'web', card, leaving: false }]}
                    frontId={fixture.id}
                    tucking={false}
                    spoken={fixture.spoken ?? ''}
                    onFocus={() => undefined}
                    onTuck={() => undefined}
                  />
                </div>
              </section>
            )
          })}
        </div>
      </main>
    </GlassFilters>
  )
}

/**
 * A conversation's worth of cards on one stage, the way they stand together:
 * the one being talked about large, the rest in a column beside it. Pressing
 * one brings it forward, as it does in a conversation.
 */
function ManyCards({ stage, stripes }: { stage: { width: number; height: number } | null; stripes: boolean }) {
  const [count, setCount] = useState(3)
  const picked = MANY.slice(0, count)
  const [frontId, setFrontId] = useState<string | null>(null)
  const entries = picked.map((fixture) => ({
    id: fixture.id,
    query: fixture.card.query,
    hint: (fixture.card.recipe === 'gallery' ? 'pictures' : 'web') as 'pictures' | 'web',
    card: fixture.card,
    leaving: false,
  }))
  return (
    <section className="lab-case">
      <h2>
        several cards <small>press one beside the front to bring it forward</small>
      </h2>
      <Choice label="Cards" value={String(count)} options={['1', '2', '3', '4', '5']} onChange={(next) => setCount(Number(next))} />
      <div className="lab-stage" data-stripes={stripes} style={stage ? { width: stage.width, height: stage.height } : undefined}>
        <Stage
          entries={entries}
          frontId={picked.some((fixture) => fixture.id === frontId) ? frontId : null}
          tucking={false}
          spoken=""
          onFocus={setFrontId}
          onTuck={() => setFrontId(null)}
        />
      </div>
    </section>
  )
}

/** The cards the several-cards case draws from, oldest first: the last is in front until another is pressed. */
const MANY = ['lab:data-profile', 'lab:map-route', 'lab:front-page', 'lab:gallery', 'lab:weather-map']
  .map((id) => FIXTURES.find((fixture) => fixture.id === id))
  .filter((fixture): fixture is (typeof FIXTURES)[number] => Boolean(fixture))

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly T[]
  onChange: (value: T) => void
}) {
  return (
    <fieldset className="lab-choice">
      <legend>{label}</legend>
      {options.map((option) => (
        <button type="button" key={option} aria-pressed={option === value} onClick={() => onChange(option)}>
          {option}
        </button>
      ))}
    </fieldset>
  )
}

export const Route = createFileRoute('/lab/cards')({
  validateSearch: (search: Record<string, unknown>) => ({ visualizations: search.visualizations === '1' || search.visualizations === 1 || search.visualizations === true || search.visualizations === 'true' }),
  component: CardLab,
  head: () => ({ meta: [{ title: 'Card lab · GIDEON' }, { name: 'robots', content: 'noindex' }] }),
})
