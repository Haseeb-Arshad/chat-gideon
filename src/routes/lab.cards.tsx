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
          {FIXTURES.map((fixture) => {
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
  component: CardLab,
  head: () => ({ meta: [{ title: 'Card lab · GIDEON' }, { name: 'robots', content: 'noindex' }] }),
})
