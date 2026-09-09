import { describe, expect, it } from 'vitest'
import { LatencyLog, TurnTimeline, percentile } from './telemetry'

function turn(id: string, marks: Array<[Parameters<TurnTimeline['mark']>[0], number]>) {
  const timeline = new TurnTimeline(id)
  for (const [name, at] of marks) timeline.mark(name, at)
  return timeline
}

describe('TurnTimeline', () => {
  it('measures the span between two marks', () => {
    const timeline = turn('a', [
      ['speech_end', 1_000],
      ['endpoint', 1_180],
    ])
    expect(timeline.span('speech_end', 'endpoint')).toBe(180)
  })

  it('keeps the first of a repeated mark', () => {
    const timeline = new TurnTimeline('a')
    timeline.mark('first_token', 500)
    timeline.mark('first_token', 900)
    expect(timeline.get('first_token')).toBe(500)
  })

  it('returns null for a span whose marks never both landed', () => {
    const timeline = turn('a', [['speech_end', 1_000]])
    expect(timeline.span('speech_end', 'endpoint')).toBeNull()
  })

  it('reports offsets relative to the turn, not the clock', () => {
    const summary = turn('a', [
      ['speech_end', 10_000],
      ['endpoint', 10_200],
      ['first_sample', 10_800],
    ]).summary()

    expect(summary.marks.speech_end).toBe(0)
    expect(summary.marks.endpoint).toBe(200)
    expect(summary.spans.find((span) => span.key === 'answer')?.ms).toBe(600)
  })

  it('omits stages it has no marks for rather than reporting them as zero', () => {
    const summary = turn('a', [
      ['speech_end', 0],
      ['endpoint', 100],
    ]).summary()
    expect(summary.spans.map((span) => span.key)).toEqual(['hangover'])
  })
})

describe('percentile', () => {
  it('is empty-safe', () => {
    expect(percentile([], 50)).toBe(0)
  })

  it('takes the nearest rank rather than interpolating', () => {
    const values = [10, 20, 30, 40]
    expect(percentile(values, 50)).toBe(20)
    expect(percentile(values, 95)).toBe(40)
    expect(percentile(values, 100)).toBe(40)
  })

  it('does not care what order it is given', () => {
    expect(percentile([30, 10, 40, 20], 50)).toBe(20)
  })
})

describe('LatencyLog', () => {
  function sample(id: string, answerMs: number) {
    return turn(id, [
      ['endpoint', 0],
      ['first_sample', answerMs],
    ]).summary()
  }

  it('aggregates a stage across turns', () => {
    const log = new LatencyLog()
    for (const ms of [400, 500, 600, 900]) log.push(sample(`t${ms}`, ms))

    const answer = log.stats().find((stage) => stage.key === 'answer')
    expect(answer?.count).toBe(4)
    expect(answer?.p50).toBe(500)
    expect(answer?.best).toBe(400)
  })

  it('drops the oldest turns past its limit', () => {
    const log = new LatencyLog(3)
    for (let i = 0; i < 10; i += 1) log.push(sample(`t${i}`, i))
    expect(log.size).toBe(3)
    expect(log.last?.id).toBe('t9')
  })

  it('scores speculation only over turns that attempted it', () => {
    const log = new LatencyLog()

    const plain = sample('plain', 500)
    log.push(plain)

    const hit = sample('hit', 200)
    hit.speculation = 'hit'
    hit.saved = 320
    log.push(hit)

    const miss = sample('miss', 600)
    miss.speculation = 'miss'
    log.push(miss)

    const stats = log.speculationStats()
    expect(stats.attempted).toBe(2)
    expect(stats.hits).toBe(1)
    expect(stats.rate).toBe(0.5)
    expect(stats.savedP50).toBe(320)
  })

  it('reports a zero rate rather than dividing by nothing', () => {
    expect(new LatencyLog().speculationStats().rate).toBe(0)
  })
})
