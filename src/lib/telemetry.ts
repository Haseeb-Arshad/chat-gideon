/**
 * Where every millisecond of a turn went.
 *
 * A voice agent lives or dies on latency, and latency claims are cheap. The
 * point of this module is that GIDEON cannot make one it has not measured: the
 * numbers in the README come out of here, and so does the waterfall the HUD
 * draws over the face. When a change makes a turn feel slower, this says which
 * stage moved.
 *
 * Marks are wall-clock and monotonic (`performance.now`), recorded at the exact
 * moment the event is observed rather than reconstructed afterwards.
 */

export type Mark =
  /** The detector heard speech begin. */
  | 'speech_start'
  /** The detector heard the last speech frame, before the hangover. */
  | 'speech_end'
  /** The utterance was declared finished and the text committed. */
  | 'endpoint'
  /** The turn left the browser. */
  | 'turn_sent'
  /** The first token of the reply arrived. */
  | 'first_token'
  /** The first speech chunk was requested. */
  | 'speech_requested'
  /** Its audio came back. */
  | 'speech_received'
  /** The first sample actually reached the speakers. */
  | 'first_sample'
  /** The reply finished streaming. */
  | 'reply_done'
  /** Everything queued had finished sounding. */
  | 'turn_done'

export interface Stage {
  key: string
  label: string
  from: Mark
  to: Mark
}

/**
 * The stages worth naming.
 *
 * `hangover` and `answer` are the two that a person actually feels: the silence
 * after they stop talking, and the wait before they hear anything back.
 */
export const STAGES: Stage[] = [
  { key: 'hangover', label: 'endpoint decided', from: 'speech_end', to: 'endpoint' },
  { key: 'dispatch', label: 'turn sent', from: 'endpoint', to: 'turn_sent' },
  { key: 'think', label: 'first token', from: 'turn_sent', to: 'first_token' },
  { key: 'synthesis', label: 'voice returned', from: 'speech_requested', to: 'speech_received' },
  { key: 'answer', label: 'first sound heard', from: 'endpoint', to: 'first_sample' },
]

export interface SpanResult {
  key: string
  label: string
  ms: number
  /** Milliseconds from the turn's first mark, so a waterfall can be drawn. */
  offset: number
}

export type Speculation = 'none' | 'hit' | 'miss'

export interface TurnSummary {
  id: string
  at: number
  speculation: Speculation
  /** Milliseconds the speculative start saved, when it was a hit. */
  saved: number
  interrupted: boolean
  spans: SpanResult[]
  marks: Partial<Record<Mark, number>>
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** One turn's marks. Cheap enough to keep on every turn, not just when watched. */
export class TurnTimeline {
  readonly id: string
  readonly startedAt = Date.now()
  private readonly marks = new Map<Mark, number>()
  private origin: number | null = null

  speculation: Speculation = 'none'
  saved = 0
  interrupted = false

  constructor(id: string) {
    this.id = id
  }

  /**
   * Records a mark, keeping the first of any repeat.
   *
   * Every mark here is a first occurrence by definition — the first token, the
   * first sample — and a stream that yields two deltas in the same millisecond
   * should not move the number the second one recorded.
   */
  mark(name: Mark, at = now()): number {
    if (!this.marks.has(name)) {
      this.marks.set(name, at)
      if (this.origin === null) this.origin = at
    }
    return this.marks.get(name)!
  }

  has(name: Mark): boolean {
    return this.marks.has(name)
  }

  get(name: Mark): number | undefined {
    return this.marks.get(name)
  }

  /** Milliseconds between two marks, or null when either is missing. */
  span(from: Mark, to: Mark): number | null {
    const a = this.marks.get(from)
    const b = this.marks.get(to)
    if (a === undefined || b === undefined) return null
    return Math.max(0, b - a)
  }

  summary(): TurnSummary {
    const origin = this.origin ?? 0
    const spans: SpanResult[] = []

    for (const stage of STAGES) {
      const ms = this.span(stage.from, stage.to)
      if (ms === null) continue
      spans.push({
        key: stage.key,
        label: stage.label,
        ms,
        offset: (this.marks.get(stage.from) ?? origin) - origin,
      })
    }

    const marks: Partial<Record<Mark, number>> = {}
    for (const [name, at] of this.marks) marks[name] = at - origin

    return {
      id: this.id,
      at: this.startedAt,
      speculation: this.speculation,
      saved: this.saved,
      interrupted: this.interrupted,
      spans,
      marks,
    }
  }
}

/**
 * Nearest-rank percentile.
 *
 * Deliberately not interpolated: with the twenty-odd turns a session actually
 * produces, an interpolated p95 invents a number between two real observations
 * and reads as more precise than the sample supports.
 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export interface StageStats {
  key: string
  label: string
  count: number
  p50: number
  p95: number
  best: number
}

/** A bounded history of finished turns, plus the statistics over it. */
export class LatencyLog {
  private readonly turns: TurnSummary[] = []

  constructor(private readonly limit = 60) {}

  push(summary: TurnSummary) {
    this.turns.push(summary)
    if (this.turns.length > this.limit) this.turns.shift()
  }

  get size() {
    return this.turns.length
  }

  get last(): TurnSummary | null {
    return this.turns.at(-1) ?? null
  }

  recent(count: number): TurnSummary[] {
    return this.turns.slice(-count)
  }

  stats(): StageStats[] {
    return STAGES.map((stage) => {
      const values = this.turns
        .map((turn) => turn.spans.find((span) => span.key === stage.key)?.ms)
        .filter((value): value is number => typeof value === 'number')

      return {
        key: stage.key,
        label: stage.label,
        count: values.length,
        p50: Math.round(percentile(values, 50)),
        p95: Math.round(percentile(values, 95)),
        best: values.length ? Math.round(Math.min(...values)) : 0,
      }
    }).filter((stage) => stage.count > 0)
  }

  /** Hit rate and the time it bought, over turns where speculation ran at all. */
  speculationStats() {
    const attempted = this.turns.filter((turn) => turn.speculation !== 'none')
    const hits = attempted.filter((turn) => turn.speculation === 'hit')
    const saved = hits.map((turn) => turn.saved)
    return {
      attempted: attempted.length,
      hits: hits.length,
      rate: attempted.length ? hits.length / attempted.length : 0,
      savedP50: Math.round(percentile(saved, 50)),
    }
  }

  /** The whole log, for pasting a real number into a README. */
  export() {
    return {
      exportedAt: new Date().toISOString(),
      turns: this.turns.length,
      stages: this.stats(),
      speculation: this.speculationStats(),
      raw: this.turns,
    }
  }

  clear() {
    this.turns.length = 0
  }
}
