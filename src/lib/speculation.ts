/**
 * Starting the answer before the question has finished.
 *
 * Every voice agent treats the endpoint as a starting gun: you stop talking, a
 * detector waits out its hangover, the transcript is finalised, and only then
 * does any work begin. That ordering costs the hangover plus the whole model
 * round trip, in series, every single turn — and the hangover exists purely to
 * be sure you were finished, which is a different question from what you said.
 *
 * So GIDEON treats the endpoint as a confirmation instead. Once the interim
 * transcript has held still long enough to look finished, the turn is sent on
 * that text under a speculative id. When the real endpoint lands a few hundred
 * milliseconds later, the reply is already streaming: if the final transcript
 * matches what was guessed, it is promoted and the user hears an answer
 * essentially the moment they stop talking. If it does not, it is thrown away
 * and a real turn starts, having cost some tokens and no wall-clock at all.
 *
 * This is speculative execution, and it carries the same obligation: a
 * misprediction must be *unobservable*, never merely unlikely. Nothing
 * speculative is ever shown, spoken, or written to history, and the commit test
 * below is deliberately strict — a wrong answer delivered quickly is worse in
 * every way than a right one delivered late.
 */

/** Filler a person tacks onto a finished sentence without changing it. */
const TRAILING_FILLER = new Set([
  'please',
  'thanks',
  'thank',
  'you',
  'ok',
  'okay',
  'right',
  'yeah',
  'yep',
  'sure',
  'then',
  'now',
  'actually',
  'basically',
  'really',
  'just',
  'um',
  'uh',
  'er',
  'like',
  'so',
  'well',
])

/**
 * Trailing words that look like filler but change the request when they arrive.
 * "Summarise it" and "summarise it now, quickly" want different answers.
 */
const NOT_FILLER = new Set(['not', 'no', 'never', 'instead', 'wait', 'stop'])

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function words(text: string): string[] {
  const value = normalise(text)
  return value ? value.split(' ') : []
}

export type CommitReason =
  /** The final transcript is exactly what was guessed. */
  | 'exact'
  /** It added only words that cannot change the answer. */
  | 'filler'
  /** It said something else. */
  | 'diverged'
  /** It is a prefix of the guess: the guess heard words that were not said. */
  | 'truncated'
  /** Nothing was speculated. */
  | 'absent'

export interface CommitDecision {
  commit: boolean
  reason: CommitReason
}

/**
 * Whether a reply generated for `speculated` may be used to answer `final`.
 *
 * Conservative by construction. Extra trailing filler is the only divergence
 * accepted, because it is the only one that provably cannot change the answer;
 * anything else — a changed word, a truncation, a real addition — is a miss.
 */
export function decideCommit(speculated: string, final: string): CommitDecision {
  if (!speculated.trim()) return { commit: false, reason: 'absent' }

  const guess = words(speculated)
  const actual = words(final)
  if (!guess.length || !actual.length) return { commit: false, reason: 'diverged' }

  if (guess.length === actual.length && guess.every((word, i) => word === actual[i])) {
    return { commit: true, reason: 'exact' }
  }

  // The guess ran ahead of what was actually said: it answered a question that
  // includes words the user never finished saying.
  if (actual.length < guess.length) {
    return { commit: false, reason: 'truncated' }
  }

  // Everything guessed has to survive verbatim; only the tail may be new.
  for (let i = 0; i < guess.length; i += 1) {
    if (guess[i] !== actual[i]) return { commit: false, reason: 'diverged' }
  }

  const tail = actual.slice(guess.length)
  const harmless = tail.every((word) => TRAILING_FILLER.has(word) && !NOT_FILLER.has(word))
  // A long tail is a second sentence even if every word of it is bland.
  if (harmless && tail.length <= 3) return { commit: true, reason: 'filler' }

  return { commit: false, reason: 'diverged' }
}

export interface SpeculationPolicy {
  /** How long the interim transcript must hold still before guessing. */
  stableMs: number
  /** Below this, there is not enough to answer. */
  minWords: number
  /** Above this, the user is mid-thought and a guess is likely wasted. */
  maxWords: number
  /** Never run more than this many speculative turns for one utterance. */
  maxAttempts: number
}

export const DEFAULT_POLICY: SpeculationPolicy = {
  stableMs: 300,
  minWords: 3,
  maxWords: 60,
  maxAttempts: 2,
}

/**
 * Text that is obviously mid-sentence.
 *
 * Guessing on a dangling conjunction wastes a call almost every time: the next
 * word is coming and it is not filler.
 */
const DANGLING =
  /\b(and|but|or|so|because|if|when|while|the|a|an|my|your|to|for|with|about|that|is|are|was|were|do|does|can|could|would|should|i|we|it)$/

export function looksUnfinished(text: string): boolean {
  const value = normalise(text)
  if (!value) return true
  return DANGLING.test(value)
}

export interface SpeculationInput {
  /** The interim transcript as it currently reads. */
  text: string
  /** How long it has read exactly that way. */
  stableMs: number
  /** Whether a speculative turn is already running for this text. */
  inFlight: boolean
  attempts: number
}

/** Whether to spend a speculative turn on this interim transcript. */
export function shouldSpeculate(
  input: SpeculationInput,
  policy: SpeculationPolicy = DEFAULT_POLICY,
): boolean {
  if (input.inFlight) return false
  if (input.attempts >= policy.maxAttempts) return false
  if (input.stableMs < policy.stableMs) return false

  const count = words(input.text).length
  if (count < policy.minWords || count > policy.maxWords) return false

  return !looksUnfinished(input.text)
}

export interface SpeculativeRun<T> {
  text: string
  startedAt: number
  handle: T
}

/**
 * Bookkeeping for the speculative turns of one utterance.
 *
 * The async work lives with the caller — this only tracks what was guessed,
 * how often, and which run (if any) the final transcript is allowed to keep.
 * Keeping it pure is what makes the commit rule testable, and the commit rule
 * is the part that must never be wrong.
 */
export class SpeculationTracker<T> {
  private runs: SpeculativeRun<T>[] = []
  attempts = 0

  constructor(private readonly policy: SpeculationPolicy = DEFAULT_POLICY) {}

  get inFlight(): boolean {
    return this.runs.length > 0
  }

  get latest(): SpeculativeRun<T> | null {
    return this.runs.at(-1) ?? null
  }

  consider(text: string, stableMs: number): boolean {
    return shouldSpeculate(
      { text, stableMs, inFlight: this.inFlight, attempts: this.attempts },
      this.policy,
    )
  }

  start(text: string, handle: T, at: number): SpeculativeRun<T> {
    const run: SpeculativeRun<T> = { text, startedAt: at, handle }
    this.runs.push(run)
    this.attempts += 1
    return run
  }

  /**
   * Resolve the utterance: the run that may be kept, and every run that must be
   * cancelled. Returning both in one call is what stops a caller from promoting
   * one run and forgetting to abandon its siblings.
   */
  resolve(final: string): {
    keep: SpeculativeRun<T> | null
    discard: SpeculativeRun<T>[]
    reason: CommitReason
  } {
    // Newest first: a later guess saw more of the sentence than an earlier one.
    for (let i = this.runs.length - 1; i >= 0; i -= 1) {
      const run = this.runs[i]
      const decision = decideCommit(run.text, final)
      if (decision.commit) {
        const discard = this.runs.filter((other) => other !== run)
        this.runs = []
        return { keep: run, discard, reason: decision.reason }
      }
    }

    const discard = this.runs
    const reason = discard.length ? decideCommit(discard.at(-1)!.text, final).reason : 'absent'
    this.runs = []
    return { keep: null, discard, reason }
  }

  /** Abandon everything without resolving, for a cancelled or muted turn. */
  clear(): SpeculativeRun<T>[] {
    const runs = this.runs
    this.runs = []
    this.attempts = 0
    return runs
  }
}
