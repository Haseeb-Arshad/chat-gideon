import type { AssertionKind, AssertionPolarity, Condition, SourceBasis, ValidTime } from './contracts'
import { containsSecretLikeMaterial, sensitiveCategories, type SensitiveCategory } from './screening'

/**
 * Stage 10 background learning core: edge-safe contracts, extractor output
 * validation, reconciliation and the conservative promotion policy.
 *
 * An extractor (rules or a model) only proposes. Everything that decides what
 * is written lives here or in the server worker and is deterministic: speech
 * acts that are not the user's own claim are refused, sensitive topics are
 * never learned implicitly, a proposed correction can never overwrite a
 * memory the user stated or corrected, and inferred preferences stay
 * candidates until independent conversations support them.
 */

export const LEARNING_SCHEMA_VERSION = 1 as const
export const MAX_WINDOW_TEXT_CHARS = 4_000
export const MAX_PRIOR_TURNS = 3
export const MAX_CANDIDATES_PER_WINDOW = 8
export const MAX_CANDIDATE_TEXT_CHARS = 400

export type SpeechAct =
  | 'self_statement'
  | 'quoted'
  | 'hypothetical'
  | 'joke'
  | 'question'
  | 'assistant_suggestion'
  | 'temporary_instruction'
  | 'tool_outcome'

export type ProposedOperation = 'add' | 'corroborate' | 'correct' | 'transition' | 'scoped_exception' | 'dispute' | 'no_op'

export type LearnableKind = Exclude<AssertionKind, 'episode_checkpoint'>

/** The committed user turn plus the minimal prior context, never speculative text. */
export interface ExtractionWindow {
  schemaVersion: typeof LEARNING_SCHEMA_VERSION
  scopeId: string
  eventId: string
  conversationId: string
  sourceRevision: string
  receivedAt: string
  text: string
  priorTurns: readonly { eventId: string; text: string }[]
  /**
   * Current memories of the same, already authorized scope that code retrieved
   * as possibly related (Stage 11 relation stage). Opaque handles only; a
   * classifier can describe a relation but never picks a write target.
   */
  knownMemories?: readonly { handle: string; text: string }[]
}

export interface CandidateEvidence {
  /** Exact offsets into `window.text`; the quote must equal that slice. */
  start: number
  end: number
  quote: string
}

export interface ExtractionCandidate {
  kind: LearnableKind
  text: string
  speechAct: SpeechAct
  polarity: AssertionPolarity
  /** `local` means it only applies to the current task/project, never globally. */
  scope: 'general' | 'local'
  conditions: readonly Condition[]
  relation: 'ordinary' | 'temporary_exception' | 'transition'
  validTime: ValidTime
  evidence: CandidateEvidence
  operation: ProposedOperation
  targetAssertionId: string | null
  /**
   * Optional conservative review from a classifier (Stage 11). `reject`
   * refuses the candidate and `abstain` holds it for review; neither can
   * make a candidate more likely to be accepted.
   */
  review?: 'reject' | 'abstain'
}

export interface ExtractorUsage {
  inputUnits: number
  outputUnits: number
  costMicros: number
}

export interface ExtractorIdentity {
  id: string
  version: string
  promptVersion: string
  schemaVersion: typeof LEARNING_SCHEMA_VERSION
  model: string | null
  placement: 'local' | 'remote'
}

export interface MemoryExtractor extends ExtractorIdentity {
  /** Returns untrusted JSON-shaped output; it is validated before use. */
  extract(window: ExtractionWindow, signal: AbortSignal): Promise<{ output: unknown; usage: ExtractorUsage }>
}

const UNKNOWN_TIME: ValidTime = { from: null, until: null, precision: 'unknown', sourceTimeZone: null }

// ---------------------------------------------------------------------------
// Window screening (before any extractor, especially a remote one)
// ---------------------------------------------------------------------------

export type WindowScreen =
  | { ok: true }
  | { ok: false; reason: 'secret_like_material' | 'empty' | 'too_long' | 'memory_withdrawal' }

/**
 * A turn asking to forget, stop remembering or delete something must never
 * teach it: "forget that I like tea" contains "I like tea".
 */
const MEMORY_WITHDRAWAL = /\b(?:forget|unlearn|stop remembering|don'?t remember|do not remember|don'?t (?:save|store|keep)|do not (?:save|store|keep)|(?:remove|delete|erase|wipe|clear)\b.{0,40}\b(?:memory|memories|remember|that|this|it)|bhool ja(?:o|ana|yein)?|bhula do|yaad (?:mat|na) rakh(?:o|na)|mita do)\b/iu

export function screenWindow(window: ExtractionWindow): WindowScreen {
  if (!window.text.trim()) return { ok: false, reason: 'empty' }
  if (window.text.length > MAX_WINDOW_TEXT_CHARS) return { ok: false, reason: 'too_long' }
  const all = [window.text, ...window.priorTurns.map((turn) => turn.text)]
  if (all.some((text) => containsSecretLikeMaterial(text))) return { ok: false, reason: 'secret_like_material' }
  if (MEMORY_WITHDRAWAL.test(window.text)) return { ok: false, reason: 'memory_withdrawal' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

export type CandidateRejection =
  | 'invalid_shape'
  | 'evidence_mismatch'
  | 'too_many_candidates'
  | 'text_too_long'
  | 'invalid_condition'

export interface ValidatedExtraction {
  candidates: readonly ExtractionCandidate[]
  rejected: readonly { index: number; reason: CandidateRejection }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | null {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : null
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/u.test(value) && Number.isFinite(Date.parse(value))
}

function parseCondition(value: unknown): Condition | null {
  if (!isRecord(value)) return null
  const key = typeof value.key === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(value.key) ? value.key : null
  const operator = oneOf(value.operator, ['equals', 'not_equals', 'contains', 'in'] as const)
  const item = value.value
  const scalar = (candidate: unknown) => (typeof candidate === 'string' && candidate.length <= 160) || typeof candidate === 'boolean' || (typeof candidate === 'number' && Number.isFinite(candidate))
  const ok = scalar(item) || (Array.isArray(item) && item.length <= 12 && item.every(scalar))
  return key && operator && ok ? { key, operator, value: item as Condition['value'] } : null
}

function parseValidTime(value: unknown): ValidTime | null {
  if (value === undefined || value === null) return UNKNOWN_TIME
  if (!isRecord(value)) return null
  const from = value.from === null || value.from === undefined ? null : isInstant(value.from) ? value.from : undefined
  const until = value.until === null || value.until === undefined ? null : isInstant(value.until) ? value.until : undefined
  const precision = oneOf(value.precision ?? 'unknown', ['unknown', 'year', 'month', 'day', 'hour', 'minute', 'second'] as const)
  const zone = value.sourceTimeZone === null || value.sourceTimeZone === undefined ? null : typeof value.sourceTimeZone === 'string' && value.sourceTimeZone.length <= 64 ? value.sourceTimeZone : undefined
  if (from === undefined || until === undefined || !precision || zone === undefined) return null
  if (precision === 'unknown' && (from !== null || until !== null)) return null
  if (precision !== 'unknown' && from === null) return null
  if (from && until && Date.parse(until) < Date.parse(from)) return null
  return { from, until, precision, sourceTimeZone: zone }
}

/**
 * Validates untrusted extractor output against the exact window text. A
 * candidate whose quoted evidence is not literally at its offsets is dropped:
 * the extractor cannot cite words the user did not say.
 */
export function validateExtractorOutput(window: ExtractionWindow, output: unknown): ValidatedExtraction {
  const rejected: { index: number; reason: CandidateRejection }[] = []
  const list = isRecord(output) && Array.isArray(output.candidates) ? output.candidates : null
  if (!list) return { candidates: [], rejected: [{ index: -1, reason: 'invalid_shape' }] }
  const candidates: ExtractionCandidate[] = []
  list.forEach((raw, index) => {
    if (index >= MAX_CANDIDATES_PER_WINDOW) {
      rejected.push({ index, reason: 'too_many_candidates' })
      return
    }
    if (!isRecord(raw)) {
      rejected.push({ index, reason: 'invalid_shape' })
      return
    }
    const kind = oneOf(raw.kind, ['fact', 'preference', 'constraint', 'decision'] as const)
    const speechAct = oneOf(raw.speechAct, ['self_statement', 'quoted', 'hypothetical', 'joke', 'question', 'assistant_suggestion', 'temporary_instruction', 'tool_outcome'] as const)
    const polarity = oneOf(raw.polarity ?? 'positive', ['positive', 'negative', 'unknown'] as const)
    const scope = oneOf(raw.scope ?? 'general', ['general', 'local'] as const)
    const relation = oneOf(raw.relation ?? 'ordinary', ['ordinary', 'temporary_exception', 'transition'] as const)
    const operation = oneOf(raw.operation ?? 'add', ['add', 'corroborate', 'correct', 'transition', 'scoped_exception', 'dispute', 'no_op'] as const)
    const text = typeof raw.text === 'string' ? raw.text.normalize('NFKC').replace(/\s+/gu, ' ').trim() : ''
    const target = raw.targetAssertionId === undefined || raw.targetAssertionId === null ? null : typeof raw.targetAssertionId === 'string' && raw.targetAssertionId.length <= 160 ? raw.targetAssertionId : undefined
    const validTime = parseValidTime(raw.validTime)
    const evidence = isRecord(raw.evidence) ? raw.evidence : null
    const review = raw.review === undefined || raw.review === null ? null : oneOf(raw.review, ['reject', 'abstain'] as const) ?? undefined
    if (review === undefined) {
      rejected.push({ index, reason: 'invalid_shape' })
      return
    }
    if (!kind || !speechAct || !polarity || !scope || !relation || !operation || !text || target === undefined || !validTime || !evidence) {
      rejected.push({ index, reason: 'invalid_shape' })
      return
    }
    if (text.length > MAX_CANDIDATE_TEXT_CHARS) {
      rejected.push({ index, reason: 'text_too_long' })
      return
    }
    const start = evidence.start
    const end = evidence.end
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)
      || (end as number) > window.text.length || window.text.slice(start as number, end as number) !== evidence.quote) {
      rejected.push({ index, reason: 'evidence_mismatch' })
      return
    }
    const rawConditions = Array.isArray(raw.conditions) ? raw.conditions : raw.conditions === undefined ? [] : null
    const conditions = rawConditions?.map(parseCondition) ?? null
    if (!conditions || conditions.length > 12 || conditions.some((item) => !item)) {
      rejected.push({ index, reason: 'invalid_condition' })
      return
    }
    if (relation === 'temporary_exception' && !validTime.until) {
      rejected.push({ index, reason: 'invalid_shape' })
      return
    }
    if (relation === 'transition' && !validTime.from) {
      rejected.push({ index, reason: 'invalid_shape' })
      return
    }
    candidates.push({
      kind, text, speechAct, polarity, scope, relation, operation, validTime,
      conditions: conditions as Condition[],
      evidence: { start: start as number, end: end as number, quote: evidence.quote as string },
      targetAssertionId: target,
      ...(review ? { review } : {}),
    })
  })
  return { candidates, rejected }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** A current memory in the same scope, as the worker read it for reconciliation. */
export interface ExistingMemory {
  assertionId: string
  revision: number
  kind: AssertionKind
  text: string
  polarity: AssertionPolarity
  status: 'candidate' | 'accepted' | 'disputed'
  basis: SourceBasis
  conditions: readonly Condition[]
}

export type LearningReason =
  | 'self_statement'
  | 'inferred_from_instruction'
  | 'duplicate_of_existing'
  | 'contradicts_existing'
  | 'user_authored_target_protected'
  | 'target_not_found'
  | 'not_users_claim'
  | 'hypothetical'
  | 'joke'
  | 'question'
  | 'assistant_suggestion'
  | 'tool_outcome_not_from_extractor'
  | 'sensitive_category'
  | 'local_scope_without_topic'
  | 'no_op_proposed'
  | 'change_requires_review'
  | 'classifier_rejected'
  | 'classifier_abstained'

export type LearningDecision =
  | { action: 'add'; status: 'accepted' | 'candidate'; basis: 'explicit_user_statement' | 'inference'; reason: LearningReason; candidate: ExtractionCandidate }
  | { action: 'corroborate'; target: ExistingMemory; reason: LearningReason; candidate: ExtractionCandidate }
  | { action: 'dispute'; target: ExistingMemory; reason: LearningReason; candidate: ExtractionCandidate }
  | { action: 'reject'; reason: LearningReason; sensitive?: readonly SensitiveCategory[]; candidate: ExtractionCandidate }

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'i', 'im', 'in', 'is', 'it',
  'its', 'me', 'my', 'of', 'on', 'or', 'so', 'that', 'the', 'their', 'they', 'this', 'to', 'was', 'with', 'user',
  'users', 'said', 'says', 'stated', 'am', 'really', 'very', 'much', 'mujhe', 'hai', 'hain', 'ho', 'hoon', 'ka', 'ki', 'ke', 'ko',
  'main', 'mera', 'meri', 'mere', 'bohat', 'bahut',
])

const NEGATION = new Set(['not', 'no', 'never', 'dont', 'doesnt', 'didnt', 'cant', 'cannot', 'wont', 'isnt', 'arent', 'nahi', 'nahin', 'na', 'hate', 'dislike', 'avoid'])

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(?:ch|sh|x|z)es$/u.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

function tokens(text: string): string[] {
  return text.normalize('NFKC').toLocaleLowerCase('und').replace(/['’]/gu, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** Sentiment verbs carry polarity, not subject matter: "like tea" and "hate tea" are about tea. */
const SENTIMENT = new Set(['like', 'love', 'enjoy', 'prefer', 'favourite', 'favorite', 'pasand', 'achha', 'acha', 'lagta', 'lagti', 'lagtay'])

/** Content words without negation, sentiment or filler; polarity is compared separately. */
export function contentKey(text: string): Set<string> {
  return new Set(tokens(text).filter((word) => !STOP.has(word) && !NEGATION.has(word)).map(stem).filter((word) => !SENTIMENT.has(word)))
}

export function negated(text: string): boolean {
  return tokens(text).some((word) => NEGATION.has(word))
}

function effectivePolarity(text: string, polarity: AssertionPolarity): AssertionPolarity {
  if (polarity !== 'positive') return polarity
  return negated(text) ? 'negative' : 'positive'
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}

function sameConditions(left: readonly Condition[], right: readonly Condition[]): boolean {
  const key = (items: readonly Condition[]) => items.map((item) => `${item.key}|${item.operator}|${JSON.stringify(item.value)}`).sort().join('\n')
  return key(left) === key(right)
}

export const NEAR_DUPLICATE_THRESHOLD = 0.75

/** The sentence (bounded by . ! ? ؟ ۔ or a newline) that contains a span. */
export function sentenceAround(text: string, start: number, end: number): string {
  const boundary = /[.!?؟۔\n]/u
  let from = Math.max(0, Math.min(start, text.length))
  let to = Math.max(from, Math.min(end, text.length))
  while (from > 0 && !boundary.test(text[from - 1]!)) from -= 1
  while (to < text.length && !boundary.test(text[to]!)) to += 1
  return text.slice(from, to)
}

const REFUSED_ACTS: Partial<Record<SpeechAct, LearningReason>> = {
  quoted: 'not_users_claim',
  hypothetical: 'hypothetical',
  joke: 'joke',
  question: 'question',
  assistant_suggestion: 'assistant_suggestion',
  // Tool outcomes are recorded from verified receipts, not re-derived from text.
  tool_outcome: 'tool_outcome_not_from_extractor',
}

const USER_AUTHORED: ReadonlySet<SourceBasis> = new Set(['explicit_user_statement', 'user_correction'])

/**
 * Decide what one validated candidate may do. The extractor's proposed
 * operation and target are hints: code rechecks ownership (the existing list
 * is already scope-bound), and learned text never supersedes a memory the user
 * stated or corrected (C32). Disagreement becomes a dispute, not a rewrite.
 */
export function decideCandidate(
  candidate: ExtractionCandidate,
  existing: readonly ExistingMemory[],
  options: { activeTopicKnown: boolean; sourceText?: string },
): LearningDecision {
  const refused = REFUSED_ACTS[candidate.speechAct]
  if (refused) return { action: 'reject', reason: refused, candidate }
  if (candidate.operation === 'no_op') return { action: 'reject', reason: 'no_op_proposed', candidate }
  if (candidate.review === 'reject') return { action: 'reject', reason: 'classifier_rejected', candidate }
  // The whole sentence around the evidence counts: an extractor that quotes
  // only "I love sweets" from "I am a diabetic and I love sweets" must not
  // launder the health context out of the check.
  const sentence = options.sourceText ? sentenceAround(options.sourceText, candidate.evidence.start, candidate.evidence.end) : ''
  const sensitive = sensitiveCategories(`${candidate.text} ${candidate.evidence.quote} ${sentence}`)
  if (sensitive.length) return { action: 'reject', reason: 'sensitive_category', sensitive, candidate }
  if (candidate.scope === 'local' && !candidate.conditions.length && !options.activeTopicKnown) {
    // A local instruction with nothing to scope it to must not become global.
    return { action: 'reject', reason: 'local_scope_without_topic', candidate }
  }

  const polarity = effectivePolarity(candidate.evidence.quote, candidate.polarity)
  const key = contentKey(candidate.text)
  let best: { memory: ExistingMemory; score: number } | null = null
  for (const memory of existing) {
    if (!sameConditions(memory.conditions, candidate.conditions)) continue
    const score = jaccard(key, contentKey(memory.text))
    if (score >= NEAR_DUPLICATE_THRESHOLD && (!best || score > best.score)) best = { memory, score }
  }

  if (!candidate.targetAssertionId && (candidate.operation === 'correct' || candidate.operation === 'transition')) {
    // A stated change without an exact old memory is kept for review; the
    // explicit correct path is what retires the old value.
    return { action: 'add', status: 'candidate', basis: 'explicit_user_statement', reason: 'change_requires_review', candidate: { ...candidate, polarity } }
  }

  if (candidate.targetAssertionId && ['correct', 'transition', 'dispute'].includes(candidate.operation)) {
    const target = existing.find((memory) => memory.assertionId === candidate.targetAssertionId)
    if (!target) return { action: 'reject', reason: 'target_not_found', candidate }
    // Learning may flag disagreement but never rewrites user-authored memory.
    return { action: 'dispute', target, reason: USER_AUTHORED.has(target.basis) ? 'user_authored_target_protected' : 'contradicts_existing', candidate }
  }

  if (candidate.review === 'abstain' && candidate.speechAct !== 'temporary_instruction') {
    // The classifier could not confirm a durable claim: hold it for review.
    // An unconfirmed clause does not corroborate existing memory either,
    // because corroboration counts toward promotion.
    return { action: 'add', status: 'candidate', basis: 'explicit_user_statement', reason: 'classifier_abstained', candidate: { ...candidate, polarity } }
  }

  if (best) {
    const existingPolarity = effectivePolarity(best.memory.text, best.memory.polarity)
    if (existingPolarity !== polarity && existingPolarity !== 'unknown' && polarity !== 'unknown') {
      return { action: 'dispute', target: best.memory, reason: 'contradicts_existing', candidate: { ...candidate, polarity } }
    }
    return { action: 'corroborate', target: best.memory, reason: 'duplicate_of_existing', candidate: { ...candidate, polarity } }
  }

  if (candidate.speechAct === 'temporary_instruction') {
    // A per-task instruction is only evidence of a possible preference.
    return { action: 'add', status: 'candidate', basis: 'inference', reason: 'inferred_from_instruction', candidate: { ...candidate, polarity } }
  }
  return { action: 'add', status: 'accepted', basis: 'explicit_user_statement', reason: 'self_statement', candidate: { ...candidate, polarity } }
}

// ---------------------------------------------------------------------------
// Promotion of inferred preferences
// ---------------------------------------------------------------------------

export interface PromotionPolicy {
  /** Distinct conversations with supporting user statements. */
  minIndependentConversations: number
  /** Distinct calendar days (UTC) across that support. */
  minDistinctDays: number
  /** Contradicting observations tolerated; the default is none. */
  maxCounterevidence: number
  /** Unpromoted candidates older than this are retired. */
  candidateTtlDays: number
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = Object.freeze({
  minIndependentConversations: 3,
  minDistinctDays: 2,
  maxCounterevidence: 0,
  candidateTtlDays: 90,
})

export interface CandidateSupport {
  sourceKind: string
  conversationId: string
  receivedAt: string
  relation: 'supports' | 'contradicts' | 'derived_from'
}

export type PromotionVerdict =
  | { promote: true; independentConversations: number; distinctDays: number }
  | { promote: false; reason: 'insufficient_independent_support' | 'insufficient_time_spread' | 'counterevidence' | 'sensitive_category'; independentConversations: number; distinctDays: number }

/**
 * Only committed user statements count, and only once per conversation: a
 * repeated turn, a duplicated delivery or a generated summary is not new
 * evidence (C13, C21, C31). Counterevidence blocks promotion outright.
 */
export function evaluatePromotion(text: string, support: readonly CandidateSupport[], policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY): PromotionVerdict {
  const user = support.filter((item) => item.sourceKind === 'user_statement' || item.sourceKind === 'user_correction')
  const conversations = new Set(user.filter((item) => item.relation === 'supports').map((item) => item.conversationId))
  const days = new Set(user.filter((item) => item.relation === 'supports').map((item) => item.receivedAt.slice(0, 10)))
  const counter = user.filter((item) => item.relation === 'contradicts').length
  const measured = { independentConversations: conversations.size, distinctDays: days.size }
  if (sensitiveCategories(text).length) return { promote: false, reason: 'sensitive_category', ...measured }
  if (counter > policy.maxCounterevidence) return { promote: false, reason: 'counterevidence', ...measured }
  if (conversations.size < policy.minIndependentConversations) return { promote: false, reason: 'insufficient_independent_support', ...measured }
  if (days.size < policy.minDistinctDays) return { promote: false, reason: 'insufficient_time_spread', ...measured }
  return { promote: true, ...measured }
}

// ---------------------------------------------------------------------------
// Shadow re-extraction diff
// ---------------------------------------------------------------------------

export interface LearnedMemoryView {
  assertionId: string
  text: string
  polarity: AssertionPolarity
  basis: SourceBasis
  producer: string
  eventId: string
}

export interface ShadowDiff {
  extractor: { from: string; to: string }
  unchanged: number
  added: readonly { eventId: string; text: string }[]
  missing: readonly { assertionId: string; eventId: string; text: string }[]
  polarityChanged: readonly { assertionId: string; eventId: string; from: AssertionPolarity; to: AssertionPolarity }[]
  /** User-authored memories the new extractor disagrees with; never rewritten. */
  preservedUserEdits: readonly { assertionId: string; eventId: string }[]
}

/**
 * Compares a new extractor's proposals with what earlier learning produced
 * for the same events. Pure: it never writes, so an upgrade cannot silently
 * replace accepted memory or resurrect deleted content (deleted items are not
 * in `current` and are skipped by the caller before extraction).
 */
export function diffShadowExtraction(
  current: readonly LearnedMemoryView[],
  proposals: readonly { eventId: string; candidate: ExtractionCandidate }[],
  extractor: { from: string; to: string },
): ShadowDiff {
  const added: { eventId: string; text: string }[] = []
  const polarityChanged: ShadowDiff['polarityChanged'][number][] = []
  const preservedUserEdits: ShadowDiff['preservedUserEdits'][number][] = []
  const matched = new Set<string>()
  let unchanged = 0
  for (const { eventId, candidate } of proposals) {
    if (REFUSED_ACTS[candidate.speechAct] || candidate.operation === 'no_op') continue
    const key = contentKey(candidate.text)
    const polarity = effectivePolarity(candidate.evidence.quote, candidate.polarity)
    const same = current.find((memory) => memory.eventId === eventId && jaccard(key, contentKey(memory.text)) >= NEAR_DUPLICATE_THRESHOLD)
    if (!same) {
      added.push({ eventId, text: candidate.text })
      continue
    }
    matched.add(same.assertionId)
    const existingPolarity = effectivePolarity(same.text, same.polarity)
    if (existingPolarity === polarity) unchanged += 1
    else if (USER_AUTHORED.has(same.basis) && same.producer !== extractor.from) preservedUserEdits.push({ assertionId: same.assertionId, eventId })
    else polarityChanged.push({ assertionId: same.assertionId, eventId, from: existingPolarity, to: polarity })
  }
  const missing = current
    .filter((memory) => !matched.has(memory.assertionId) && memory.producer === extractor.from)
    .map((memory) => ({ assertionId: memory.assertionId, eventId: memory.eventId, text: memory.text }))
  return { extractor, unchanged, added, missing, polarityChanged, preservedUserEdits }
}
