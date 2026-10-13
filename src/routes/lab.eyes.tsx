import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { GideonEyes, type EyeEmotion, type EyePhase } from '../components/GideonEyes'
import { ThoughtCloud } from '../components/ThoughtCloud'
import type { Thought } from '../lib/thoughts'

/**
 * The eye lab: every feeling at once, in any phase. Development only.
 *
 * A face is judged by comparison. Whether worry reads as worry depends on what
 * resolve looks like beside it, so they are shown together, alive, and the
 * phase is switched for all of them at the same moment.
 */

const EMOTIONS: EyeEmotion[] = ['neutral', 'curious', 'focused', 'happy', 'concerned', 'surprised']
const PHASES: EyePhase[] = ['idle', 'listening', 'thinking', 'speaking', 'paused']
/** One of each kind of thought, to see the cloud beside every face. */
const THOUGHTS: Record<string, Thought | null> = {
  none: null,
  thinking: { key: 'lab:dots', kind: 'work', icon: 'dots', text: '' },
  searching: { key: 'lab:search', kind: 'work', icon: 'search', text: 'Who won the 2026 World Cup…' },
  memory: { key: 'lab:memory', kind: 'idle', icon: 'memory', text: 'The dog is called Bruno' },
  topic: { key: 'lab:topic', kind: 'idle', icon: 'topic', text: 'the trip to Hunza' },
  timer: { key: 'lab:timer', kind: 'idle', icon: 'timer', text: 'tea · 2 min left' },
}

function EyeLab() {
  const [phase, setPhase] = useState<EyePhase>('idle')
  const [thought, setThought] = useState('none')
  // `?phase=thinking` opens on that phase, for a link or a screenshot. Read
  // after mounting, so the server and the first client render agree.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('phase')
    if (PHASES.includes(asked as EyePhase)) setPhase(asked as EyePhase)
    const thinking = new URLSearchParams(window.location.search).get('thought')
    if (thinking && thinking in THOUGHTS) setThought(thinking)
  }, [])
  if (!import.meta.env.DEV) return null
  return (
    <main style={{ minHeight: '100vh', padding: 32, background: 'var(--space)', color: 'var(--steel)', fontFamily: 'var(--font-mono)' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 28 }}>
        {PHASES.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setPhase(name)}
            aria-pressed={phase === name}
            style={{
              padding: '8px 16px', borderRadius: 999, cursor: 'pointer', font: 'inherit',
              border: '1px solid var(--steel-dark)',
              background: phase === name ? 'var(--ice)' : 'transparent',
              color: phase === name ? 'var(--space)' : 'var(--steel)',
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 40 }}>
        {Object.keys(THOUGHTS).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setThought(name)}
            aria-pressed={thought === name}
            style={{
              padding: '6px 14px', borderRadius: 999, cursor: 'pointer', font: 'inherit', fontSize: 12,
              border: '1px solid var(--steel-dark)',
              background: thought === name ? 'var(--steel)' : 'transparent',
              color: thought === name ? 'var(--space)' : 'var(--steel)',
            }}
          >
            thought: {name}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 28 }}>
        {EMOTIONS.map((emotion) => (
          <section key={emotion} style={{ padding: '30px 24px 18px', borderRadius: 18, background: 'var(--machine)' }}>
            <div className="robot-presence" data-phase={phase} data-emotion={emotion} style={{ width: '100%' }}>
              <GideonEyes phase={phase} emotion={emotion} />
              <ThoughtCloud thought={THOUGHTS[thought]} />
            </div>
            <p style={{ margin: '18px 0 0', textAlign: 'center', letterSpacing: '0.14em', fontSize: 13 }}>{emotion.toUpperCase()}</p>
          </section>
        ))}
      </div>
    </main>
  )
}

export const Route = createFileRoute('/lab/eyes')({ component: EyeLab })
