/**
 * Stage 11 bounded classification contract (edge-safe).
 *
 * A classifier answers typed questions about a state: Noul (probability of
 * yes), Choice (one option from a closed set, with a distribution) and Score
 * (ordered levels). The shapes follow TypeSafe's System One API so Jev can be
 * one implementation, but nothing here depends on a provider.
 *
 * Classification is advisory and conservative-only. It can refuse a proposed
 * memory, hold it for review, or narrow a durable statement to the current
 * task. It never widens scope, never turns a refused speech act into a claim,
 * never names a tenant, grant or deletion target, and a failure is an
 * abstention, not a guessed answer. Explicit remember/correct/forget commands
 * never pass through here.
 */

export const CLASSIFICATION_SCHEMA_VERSION = 1 as const
export const MAX_CLASSIFIER_QUESTIONS = 32
export const MAX_CLASSIFIER_STATE_CHARS = 24_000
export const MAX_CHOICE_OPTIONS = 255
export const MAX_SCORE_LEVELS = 10
export const MAX_INSTRUCTION_CHARS = 2_000
const QUESTION_KEY = /^[a-z][a-z0-9_]{0,63}$/u
const OPTION_KEY = /^[a-z][a-z0-9_]{0,63}$/u
const PROBABILITY_TOLERANCE = 0.02

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true: string; false: string }
}

export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Readonly<Record<string, string | null>>
}

export interface ScoreQuestion {
  type: 'score'
  instructions: string
  criteria: readonly string[]
}

export type ClassifierQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface ClassifierRequest {
  /** Untrusted user material is data inside the state, never an instruction. */
  state: Readonly<Record<string, unknown>>
  questions: Readonly<Record<string, ClassifierQuestion>>
}

export type NoulAnswer = { type: 'noul'; noul: number }
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Readonly<Record<string, number>>; confidence: number }
export type ScoreAnswer = { type: 'score'; score: number; probabilities: Readonly<Record<string, number>>; confidence: number }
export type ClassifierAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export type ClassifierFailureCode =
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'rate_limited'
  | 'overloaded'
  | 'unauthorized'
  | 'invalid_request'
  | 'malformed'
  | 'not_configured'

export interface ClassifierUsage {
  inputTokens: number
  outputTokens: number
  costMicros: number
}

export type ClassifierResult =
  | { ok: true; answers: Readonly<Record<string, ClassifierAnswer>>; model: string; usage: ClassifierUsage; latencyMs: number }
  | { ok: false; failure: { code: ClassifierFailureCode; retryable: boolean }; usage: ClassifierUsage; latencyMs: number }

export interface MemoryClassifier {
  id: string
  version: string
  /** Pinned model identifier requested from the provider. */
  model: string
  placement: 'local' | 'remote'
  /**
   * `typesafe_jev` is the real Jev API. `llm_substitute` is a general model
   * asked the same questions; its probabilities are self-reported, and its
   * results must never be reported as Jev results.
   */
  provider: 'typesafe_jev' | 'llm_substitute' | 'fixture'
  /** Never throws; outages and bad output come back as typed failures. */
  classify(request: ClassifierRequest, signal: AbortSignal): Promise<ClassifierResult>
}

export const NO_USAGE: ClassifierUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, costMicros: 0 })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Rejects a request that would exceed provider limits or smuggle unbounded text. */
export function validateClassifierRequest(request: ClassifierRequest): { ok: true } | { ok: false; reason: string } {
  const keys = Object.keys(request.questions)
  if (!keys.length) return { ok: false, reason: 'no_questions' }
  if (keys.length > MAX_CLASSIFIER_QUESTIONS) return { ok: false, reason: 'too_many_questions' }
  let stateText: string
  try {
    stateText = JSON.stringify(request.state)
  } catch {
    return { ok: false, reason: 'state_not_serializable' }
  }
  if (stateText.length > MAX_CLASSIFIER_STATE_CHARS) return { ok: false, reason: 'state_too_large' }
  for (const key of keys) {
    const question = request.questions[key]!
    if (!QUESTION_KEY.test(key)) return { ok: false, reason: 'invalid_question_key' }
    if (!question.instructions || question.instructions.length > MAX_INSTRUCTION_CHARS) return { ok: false, reason: 'invalid_instructions' }
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria)
      if (options.length < 2 || options.length > MAX_CHOICE_OPTIONS || options.some((option) => !OPTION_KEY.test(option))) return { ok: false, reason: 'invalid_choice_options' }
    } else if (question.type === 'score') {
      if (question.criteria.length < 2 || question.criteria.length > MAX_SCORE_LEVELS) return { ok: false, reason: 'invalid_score_levels' }
    } else if (question.type !== 'noul') {
      return { ok: false, reason: 'invalid_question_type' }
    }
  }
  return { ok: true }
}

function distribution(value: unknown, keys: readonly string[]): Record<string, number> | null {
  if (!isRecord(value)) return null
  const provided = Object.keys(value)
  if (provided.length !== keys.length || provided.some((key) => !keys.includes(key))) return null
  let sum = 0
  const result: Record<string, number> = {}
  for (const key of keys) {
    const item = value[key]
    if (!probability(item)) return null
    result[key] = item
    sum += item
  }
  return Math.abs(sum - 1) <= PROBABILITY_TOLERANCE ? result : null
}

/**
 * Validates untrusted provider answers against the exact questions asked.
 * A missing answer, a wrong type, an option that was not offered or a
 * distribution that does not sum to one makes the whole response malformed:
 * partial trust in a response that broke its contract is not useful.
 */
export function parseClassifierAnswers(request: ClassifierRequest, raw: unknown): Readonly<Record<string, ClassifierAnswer>> | null {
  if (!isRecord(raw)) return null
  const answers: Record<string, ClassifierAnswer> = {}
  for (const [key, question] of Object.entries(request.questions)) {
    const answer = raw[key]
    if (!isRecord(answer) || answer.type !== question.type) return null
    if (question.type === 'noul') {
      if (!probability(answer.noul)) return null
      answers[key] = { type: 'noul', noul: answer.noul }
      continue
    }
    if (!probability(answer.confidence)) return null
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria)
      const probabilities = distribution(answer.probabilities, options)
      if (!probabilities || typeof answer.choice !== 'string' || !options.includes(answer.choice)) return null
      // The reported choice must be the most probable option.
      if (options.some((option) => probabilities[option]! > probabilities[answer.choice as string]! + 1e-9)) return null
      answers[key] = { type: 'choice', choice: answer.choice, probabilities, confidence: answer.confidence }
      continue
    }
    const levels = question.criteria.map((_, index) => String(index))
    const probabilities = distribution(answer.probabilities, levels)
    if (!probabilities || typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels.length - 1) return null
    answers[key] = { type: 'score', score: answer.score, probabilities, confidence: answer.confidence }
  }
  return answers
}

/**
 * Confidence derived from a distribution: one minus normalized entropy. Used
 * for substitute classifiers that only return probabilities, so both
 * providers expose the same field; it is not a probability of correctness.
 */
export function distributionConfidence(probabilities: Readonly<Record<string, number>>): number {
  const values = Object.values(probabilities)
  if (values.length < 2) return 1
  let entropy = 0
  for (const value of values) if (value > 0) entropy -= value * Math.log(value)
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(values.length)))
}

// ---------------------------------------------------------------------------
// Memory questions. Only these task families are allowed: candidacy,
// temporary-versus-durable, relation to already retrieved memories, and
// applicability of the current request. No question asks about identity,
// tenancy, permissions or what to delete.
// ---------------------------------------------------------------------------

export const SPEECH_ACT_OPTIONS = {
  self_statement: 'The user states something about themself, in earnest, as currently true',
  quoted: 'The user reports what someone else said, thinks or likes',
  hypothetical: 'An imagined, conditional or planned-for-discussion situation, not a fact',
  joke: 'Sarcasm, irony or a joke that the user does not mean literally',
  question: 'The user is asking something rather than stating it',
  assistant_echo: 'The user repeats or accepts something the assistant said',
  task_instruction: 'A request about how to do the current task, not a statement about the user',
} as const

export const DURABILITY_OPTIONS = {
  durable: 'Worth remembering across future conversations: a lasting preference, fact, constraint or decision about the user',
  temporary: 'Only applies to the current task, message, day or trip',
  not_memory: 'Nothing about the user that should be remembered',
} as const

export const RELATION_OPTIONS = {
  same: 'Says the same thing as `known_memory`',
  changed: 'Says the situation in `known_memory` has changed or is no longer true',
  exception: 'A narrower exception to `known_memory` that leaves it true in general',
  unrelated: 'About something different from `known_memory`',
} as const

export const ACTIVITY_OPTIONS = {
  work_meeting: 'Scheduling, preparing for or discussing a work meeting',
  writing: 'Drafting or editing an email, message, document or presentation',
  coding: 'Programming or software work',
  travel: 'Planning or discussing trips, flights, hotels or routes',
  food: 'Meals, restaurants, recipes or groceries',
  shopping: 'Choosing or buying a product',
  scheduling: 'Calendar or time planning that is not a work meeting',
  learning: 'Studying or understanding a topic',
  casual_chat: 'Small talk with no concrete task',
  other: 'A concrete task not listed above',
} as const

export type SpeechActLabel = keyof typeof SPEECH_ACT_OPTIONS
export type DurabilityLabel = keyof typeof DURABILITY_OPTIONS
export type RelationLabel = keyof typeof RELATION_OPTIONS
export type ActivityLabel = keyof typeof ACTIVITY_OPTIONS

export const CANDIDATE_QUESTION_VERSION = 'memq-2026-09-23'

/** Independent questions about one proposed clause; none sees another's answer. */
export function candidateQuestions(prefix: string): Record<string, ClassifierQuestion> {
  return {
    [`${prefix}_act`]: {
      type: 'choice',
      instructions: 'What kind of statement is `clause`, read in the context of `user_turn`? Earlier turns are context only.',
      criteria: SPEECH_ACT_OPTIONS,
    },
    [`${prefix}_durability`]: {
      type: 'choice',
      instructions: 'Should an assistant remember what `clause` says about the user for future conversations?',
      criteria: DURABILITY_OPTIONS,
    },
    [`${prefix}_claim`]: {
      type: 'noul',
      instructions: 'Does `clause` sincerely state something that is currently true about the user themself (not about someone else, not imagined, not a joke, not a question)?',
      criteria: { true: 'A sincere first-person claim that is true now', false: 'Anything else' },
    },
  }
}

/** Window-level gate asked before any extractor runs. */
export function windowGateQuestions(): Record<string, ClassifierQuestion> {
  return {
    gate_has_memory: {
      type: 'noul',
      instructions: 'Does `user_turn` contain anything about the user (a preference, fact, constraint, decision or a request about how to answer) that an assistant might need to remember or apply?',
      criteria: { true: 'Contains such a statement or instruction', false: 'Only questions, commands with no personal content, or talk about other people' },
    },
  }
}

/** Dependent stage: asked only after code has bound the scope and retrieved candidates. */
export function relationQuestions(prefix: string): Record<string, ClassifierQuestion> {
  return {
    [`${prefix}_relation`]: {
      type: 'choice',
      instructions: 'How does `clause` relate to `known_memory`? Both are about the same user.',
      criteria: RELATION_OPTIONS,
    },
  }
}

export function activityQuestions(): Record<string, ClassifierQuestion> {
  return {
    activity: {
      type: 'choice',
      instructions: 'What is the user doing in `user_turn`? Pick the closest activity.',
      criteria: ACTIVITY_OPTIONS,
    },
  }
}

// ---------------------------------------------------------------------------
// Thresholds and conservative verdicts
// ---------------------------------------------------------------------------

export interface ClassifierThresholds {
  /** Keep a durable claim only when the claim probability reaches this. */
  keepClaimMin: number
  /** Refuse a candidate when the claim probability is at or below this. */
  rejectClaimMax: number
  /** Choice answers below this confidence are treated as unknown. */
  minChoiceConfidence: number
  /** Skip extraction when the window gate probability is at or below this. */
  gateSkipMax: number
  /** Accept an activity label at or above this confidence; otherwise unknown. */
  activityMinConfidence: number
}

/** Conservative placeholders; the evaluated, frozen values live with the eval fixtures. */
export const DEFAULT_CLASSIFIER_THRESHOLDS: ClassifierThresholds = Object.freeze({
  keepClaimMin: 0.8,
  rejectClaimMax: 0.2,
  minChoiceConfidence: 0.5,
  gateSkipMax: 0.1,
  activityMinConfidence: 0.6,
})

export type CandidateVerdict =
  | { verdict: 'keep'; claim: number }
  | { verdict: 'reject'; claim: number; reason: 'classifier_not_claim' | 'classifier_not_memory' | 'classifier_refused_act' }
  | { verdict: 'narrow'; claim: number; reason: 'classifier_temporary' }
  | { verdict: 'abstain'; claim: number | null; reason: 'classifier_uncertain' | 'classifier_unavailable' | 'classifier_changed' }

const REFUSED_LABELS: ReadonlySet<SpeechActLabel> = new Set(['quoted', 'hypothetical', 'joke', 'question', 'assistant_echo'])

function confidentChoice(answer: ClassifierAnswer | undefined, min: number): string | null {
  return answer?.type === 'choice' && answer.confidence >= min ? answer.choice : null
}

/**
 * Turns one candidate's answers into a conservative verdict. The order
 * matters: refusal signals win over keep signals, and anything unclear is
 * an abstention (pending review), never a keep.
 */
export function candidateVerdict(answers: Readonly<Record<string, ClassifierAnswer>>, prefix: string, thresholds: ClassifierThresholds): CandidateVerdict {
  const claimAnswer = answers[`${prefix}_claim`]
  const claim = claimAnswer?.type === 'noul' ? claimAnswer.noul : null
  if (claim === null) return { verdict: 'abstain', claim: null, reason: 'classifier_unavailable' }
  const act = confidentChoice(answers[`${prefix}_act`], thresholds.minChoiceConfidence) as SpeechActLabel | null
  const durability = confidentChoice(answers[`${prefix}_durability`], thresholds.minChoiceConfidence) as DurabilityLabel | null
  if (act && REFUSED_LABELS.has(act)) return { verdict: 'reject', claim, reason: 'classifier_refused_act' }
  if (durability === 'not_memory') return { verdict: 'reject', claim, reason: 'classifier_not_memory' }
  if (claim <= thresholds.rejectClaimMax && act !== 'task_instruction') return { verdict: 'reject', claim, reason: 'classifier_not_claim' }
  if (durability === 'temporary' || act === 'task_instruction') return { verdict: 'narrow', claim, reason: 'classifier_temporary' }
  const relation = confidentChoice(answers[`${prefix}_relation`], thresholds.minChoiceConfidence)
  if (relation === 'changed' || relation === 'exception') return { verdict: 'abstain', claim, reason: 'classifier_changed' }
  if (claim >= thresholds.keepClaimMin && durability === 'durable') return { verdict: 'keep', claim }
  return { verdict: 'abstain', claim, reason: 'classifier_uncertain' }
}

/** An activity label for applicability routing, or unknown. Never guessed on failure. */
export function activityVerdict(result: ClassifierResult, thresholds: ClassifierThresholds): ActivityLabel | null {
  if (!result.ok) return null
  const answer = result.answers.activity
  if (answer?.type !== 'choice' || answer.confidence < thresholds.activityMinConfidence) return null
  return answer.choice === 'other' || answer.choice === 'casual_chat' ? null : answer.choice as ActivityLabel
}
