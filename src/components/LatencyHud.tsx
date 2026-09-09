import { useEffect, useState } from 'react'
import type { LatencyLog, TurnSummary } from '../lib/telemetry'

/**
 * The glass box.
 *
 * Every other part of GIDEON is trying to hide its own machinery; this one
 * exists to show it. It draws the last turn as a waterfall and the session as
 * percentiles, so a claim about latency can be checked against the run that is
 * happening rather than taken on trust — including the speculative turns, whose
 * hit rate is the only honest way to judge whether guessing early was worth it.
 *
 * It reads from the log on a timer rather than through React state. Marks are
 * written on the hot path of a turn, and routing each one through a `setState`
 * would put a render between the microphone and the model.
 */

const REFRESH_MS = 400

/** Colour per stage, so the same span is the same colour in both panels. */
const STAGE_TINT: Record<string, string> = {
  hangover: '#8ea2c4',
  dispatch: '#5f7fb8',
  think: '#7a6ce0',
  synthesis: '#c86fa8',
  answer: '#3fc9a0',
}

function ms(value: number) {
  return `${Math.round(value)} ms`
}

function Waterfall({ turn }: { turn: TurnSummary }) {
  // The bars are scaled to the turn's own longest span rather than to a fixed
  // ceiling, so a fast turn is still legible instead of a row of slivers.
  const longest = Math.max(1, ...turn.spans.map((span) => span.ms))

  return (
    <ol className="hud-waterfall">
      {turn.spans.map((span) => (
        <li key={span.key}>
          <span className="hud-stage">{span.label}</span>
          <span className="hud-track">
            <span
              className="hud-bar"
              style={{
                width: `${Math.max(2, (span.ms / longest) * 100)}%`,
                background: STAGE_TINT[span.key] ?? '#8ea2c4',
              }}
            />
          </span>
          <span className="hud-ms">{ms(span.ms)}</span>
        </li>
      ))}
    </ol>
  )
}

export function LatencyHud({ log, onClose }: { log: LatencyLog; onClose: () => void }) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const last = log.last
  const stats = log.stats()
  const speculation = log.speculationStats()

  const copyExport = () => {
    void navigator.clipboard?.writeText(JSON.stringify(log.export(), null, 2))
  }

  return (
    <aside className="latency-hud" aria-label="Latency instrumentation">
      <header>
        <h2>Turn latency</h2>
        <div className="hud-actions">
          <button type="button" onClick={copyExport} disabled={!log.size}>
            Copy JSON
          </button>
          <button type="button" onClick={onClose} aria-label="Hide latency panel">
            Hide
          </button>
        </div>
      </header>

      {last ? (
        <>
          <div className="hud-section">
            <div className="hud-section-head">
              <span>Last turn</span>
              {last.speculation !== 'none' ? (
                <span className={`hud-tag hud-tag-${last.speculation}`}>
                  {last.speculation === 'hit'
                    ? `speculation hit, saved ${ms(last.saved)}`
                    : 'speculation missed'}
                </span>
              ) : null}
              {last.interrupted ? <span className="hud-tag hud-tag-cut">interrupted</span> : null}
            </div>
            <Waterfall turn={last} />
          </div>

          {stats.length ? (
            <div className="hud-section">
              <div className="hud-section-head">
                <span>
                  Session · {log.size} turn{log.size === 1 ? '' : 's'}
                </span>
              </div>
              <table className="hud-table">
                <thead>
                  <tr>
                    <th>stage</th>
                    <th>p50</th>
                    <th>p95</th>
                    <th>best</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((stage) => (
                    <tr key={stage.key}>
                      <td>
                        <i style={{ background: STAGE_TINT[stage.key] ?? '#8ea2c4' }} />
                        {stage.label}
                      </td>
                      <td>{stage.p50}</td>
                      <td>{stage.p95}</td>
                      <td>{stage.best}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {speculation.attempted ? (
            <p className="hud-note">
              Guessed early on {speculation.attempted} turn
              {speculation.attempted === 1 ? '' : 's'}, kept {speculation.hits} (
              {Math.round(speculation.rate * 100)}%)
              {speculation.savedP50 ? `, median ${ms(speculation.savedP50)} saved` : ''}.
            </p>
          ) : null}
        </>
      ) : (
        <p className="hud-empty">Say something and the first turn will be measured here.</p>
      )}
    </aside>
  )
}
