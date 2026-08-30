import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowDown, ArrowUpRight, CornerDownRight } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'

export const Route = createFileRoute('/')({
  component: LandingPage,
  head: () => ({
    meta: [
      { title: 'GIDEON — Find the signal' },
      {
        name: 'description',
        content: 'A voice-forward AI presence that listens for what matters and helps you move with clarity.',
      },
    ],
  }),
})

const stars: Array<{
  x: number
  y: number
  size: number
  delay: number
  duration: number
  awake?: boolean
}> = [
  { x: 8, y: 18, size: 2, delay: -2.1, duration: 9.8 },
  { x: 16, y: 66, size: 1, delay: -5.4, duration: 12.4 },
  { x: 23, y: 34, size: 3, delay: -7.2, duration: 15.1, awake: true },
  { x: 30, y: 78, size: 1, delay: -1.8, duration: 10.2 },
  { x: 39, y: 13, size: 1, delay: -8.3, duration: 13.7 },
  { x: 44, y: 52, size: 2, delay: -4.1, duration: 11.6, awake: true },
  { x: 52, y: 26, size: 1, delay: -6.8, duration: 14.2 },
  { x: 59, y: 72, size: 2, delay: -9.1, duration: 12.8, awake: true },
  { x: 66, y: 42, size: 1, delay: -3.5, duration: 10.8 },
  { x: 74, y: 17, size: 2, delay: -10.2, duration: 15.8 },
  { x: 81, y: 59, size: 3, delay: -7.7, duration: 13.1, awake: true },
  { x: 89, y: 31, size: 1, delay: -2.9, duration: 9.4 },
  { x: 94, y: 79, size: 2, delay: -5.8, duration: 14.9 },
  { x: 11, y: 89, size: 1, delay: -9.6, duration: 12.2 },
  { x: 34, y: 93, size: 2, delay: -3.2, duration: 15.4 },
  { x: 70, y: 90, size: 1, delay: -6.2, duration: 11.2 },
] as const

const cityTowers = [32, 52, 41, 74, 58, 92, 46, 68, 38, 82, 55, 101, 62, 43, 78, 48, 66, 36]

type StarStyle = CSSProperties & {
  '--star-x': string
  '--star-y': string
  '--star-size': string
  '--star-delay': string
  '--star-duration': string
}

function SignalField() {
  return (
    <div className="signal-field" aria-hidden="true">
      <div className="signal-coordinate signal-coordinate-top">N 33.6844°</div>
      <div className="signal-coordinate signal-coordinate-side">LISTENING / 01</div>
      <div className="signal-path">
        <span className="signal-tail" />
        <span className="signal-beacon">
          <i />
        </span>
      </div>

      {stars.map((star, index) => (
        <span
          className={`landing-star${star.awake ? ' is-awake' : ''}`}
          key={`${star.x}-${star.y}`}
          style={{
            '--star-x': `${star.x}%`,
            '--star-y': `${star.y}%`,
            '--star-size': `${star.size}px`,
            '--star-delay': `${star.delay}s`,
            '--star-duration': `${star.duration}s`,
          } as StarStyle}
        >
          {star.awake ? <i style={{ animationDelay: `${index * -0.7}s` }} /> : null}
        </span>
      ))}

      <svg className="signal-constellation" viewBox="0 0 900 620" preserveAspectRatio="none">
        <path d="M210 210 C320 280 360 330 410 330 S520 410 610 365 S720 315 760 370" />
        <path d="M410 330 C470 250 565 245 665 260" />
      </svg>

      <div className="signal-caption">
        <span>One clear thread</span>
        <i />
      </div>
    </div>
  )
}

function CityHorizon() {
  return (
    <div className="city-scene" aria-hidden="true">
      <div className="city-orbit city-orbit-one" />
      <div className="city-orbit city-orbit-two" />
      <div className="city-signal">
        <span />
      </div>
      <div className="city-haze" />
      <div className="city-horizon">
        {cityTowers.map((height, index) => (
          <span
            className="city-tower"
            key={`${height}-${index}`}
            style={{ '--tower-height': `${height}px`, '--tower-delay': `${index * 85}ms` } as CSSProperties}
          >
            {(index + 1) % 3 === 0 ? <i /> : null}
          </span>
        ))}
      </div>
    </div>
  )
}

function LandingPage() {
  const pageRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const page = pageRef.current
    if (!page) return

    let frame = 0
    const update = () => {
      frame = 0
      const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
      page.style.setProperty('--landing-scroll', (window.scrollY / maxScroll).toFixed(4))
    }
    const queueUpdate = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    update()
    window.addEventListener('scroll', queueUpdate, { passive: true })
    window.addEventListener('resize', queueUpdate)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', queueUpdate)
      window.removeEventListener('resize', queueUpdate)
    }
  }, [])

  return (
    <main className="landing-shell" ref={pageRef}>
      <div className="landing-atmosphere" aria-hidden="true">
        <span className="landing-glow landing-glow-left" />
        <span className="landing-glow landing-glow-right" />
        <span className="ambient-grain landing-grain" />
      </div>

      <header className="landing-header">
        <Link className="landing-brand" to="/" aria-label="GIDEON home">
          <span className="brand-seed" />
          <span>GIDEON</span>
        </Link>
        <nav className="landing-nav" aria-label="Primary navigation">
          <a href="#approach">Approach</a>
          <Link className="nav-agent-link" to="/agent">
            Meet GIDEON
            <ArrowUpRight size={14} />
          </Link>
        </nav>
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="hero-copy">
          <p className="landing-eyebrow">
            <span />
            A voice that stays with the thread
          </p>
          <h1 id="landing-title">
            Find what matters
            <span>inside the noise.</span>
          </h1>
          <p className="hero-summary">
            Talk through what is moving. GIDEON listens for the signal, keeps the context close,
            and helps you know what to follow—and what to say next.
          </p>
          <div className="hero-actions">
            <Link className="primary-landing-cta" to="/agent">
              Meet GIDEON
              <ArrowUpRight size={17} />
            </Link>
            <a className="quiet-scroll-link" href="#approach">
              See how it moves
              <ArrowDown size={15} />
            </a>
          </div>
        </div>

        <SignalField />

        <div className="hero-index" aria-hidden="true">
          <span>01</span>
          <i />
          <span>03</span>
        </div>
      </section>

      <section className="approach-section" id="approach" aria-labelledby="approach-title">
        <div className="approach-heading">
          <p className="section-kicker">A clearer way forward</p>
          <h2 id="approach-title">Not another feed.<br />A presence that <em>notices.</em></h2>
        </div>

        <div className="approach-lines">
          <article>
            <span className="approach-mark"><CornerDownRight size={18} /></span>
            <div>
              <p>Follow the thread</p>
              <small>GIDEON holds onto the part worth returning to.</small>
            </div>
          </article>
          <article>
            <span className="approach-mark"><CornerDownRight size={18} /></span>
            <div>
              <p>Name what matters</p>
              <small>Loose thoughts become language you can actually use.</small>
            </div>
          </article>
          <article>
            <span className="approach-mark"><CornerDownRight size={18} /></span>
            <div>
              <p>Move with intent</p>
              <small>Leave the conversation with a next move that feels like yours.</small>
            </div>
          </article>
        </div>
      </section>

      <section className="gather-section" aria-labelledby="gather-title">
        <CityHorizon />
        <div className="gather-copy">
          <p className="section-kicker">When the fragments gather</p>
          <h2 id="gather-title">Scattered thoughts become<br /><em>a direction.</em></h2>
          <p>
            GIDEON does not rush to fill the silence. It listens, connects the lights,
            and moves when there is something worth carrying forward.
          </p>
          <Link className="gather-link" to="/agent">
            Start a conversation
            <ArrowUpRight size={17} />
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <Link className="landing-brand" to="/" aria-label="GIDEON home">
          <span className="brand-seed" />
          <span>GIDEON</span>
        </Link>
        <p>A quieter kind of intelligence.</p>
        <Link to="/agent">Enter the agent <ArrowUpRight size={13} /></Link>
      </footer>
    </main>
  )
}
