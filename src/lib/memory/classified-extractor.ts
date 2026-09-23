import {
  CANDIDATE_QUESTION_VERSION,
  DEFAULT_CLASSIFIER_THRESHOLDS,
  NO_USAGE,
  candidateQuestions,
  candidateVerdict,
  relationQuestions,
  validateClassifierRequest,
  windowGateQuestions,
  type CandidateVerdict,
  type ClassifierQuestion,
  type ClassifierResult,
  type ClassifierThresholds,
  type ClassifierUsage,
  type MemoryClassifier,
} from './classification'
import {
  LEARNING_SCHEMA_VERSION,
  contentKey,
  validateExtractorOutput,
  type ExtractionCandidate,
  type ExtractionWindow,
  type ExtractorUsage,
  type MemoryExtractor,
} from './learning'

/**
 * Stage 11 workflow: an extractor plus a classifier, as one MemoryExtractor.
 *
 * `verify`: the extractor proposes, then every proposal is classified in one
 * request (independent questions over shared state). A dependent second
 * request asks how a kept proposal relates to memories the server already
 * retrieved for this scope. `gate`: one question about the whole turn first;
 * the extractor runs only when the turn might hold something memorable.
 *
 * Both are conservative: the classifier can refuse, hold for review or
 * narrow to the current task, never widen. A classifier failure (timeout,
 * cancellation, outage, malformed answer) makes every proposal an
 * abstention, i.e. pending review, and in gate mode still runs extraction.
 * The output keeps the extractor's exact evidence, so the shared validator
 * and reconciler still decide what is written.
 */

export type ClassifiedMode = 'verify' | 'gate'

export interface ClassifiedExtractorOptions {
  base: MemoryExtractor
  classifier: MemoryClassifier
  mode: ClassifiedMode
  thresholds?: ClassifierThresholds
  /** Separate deadline for classification, inside the job's own deadline. */
  classifierTimeoutMs?: number
}

export interface ClassificationTrace {
  mode: ClassifiedMode
  classifier: { id: string; model: string; provider: MemoryClassifier['provider'] }
  status: 'ok' | 'failed' | 'skipped_no_candidates'
  failure: string | null
  gate: { probability: number | null; skippedExtraction: boolean } | null
  verdicts: readonly (CandidateVerdict & { index: number })[]
  calls: number
  latencyMs: number
  usage: ClassifierUsage
}

const MAX_KNOWN_FOR_RELATION = 3
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 8_000

function addUsage(left: ClassifierUsage, right: ClassifierUsage): ClassifierUsage {
  return { inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens, costMicros: left.costMicros + right.costMicros }
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** Lexically closest known memories; code chooses what the classifier sees. */
function relatedKnown(window: ExtractionWindow, candidate: ExtractionCandidate): { handle: string; text: string }[] {
  const key = contentKey(candidate.text)
  return (window.knownMemories ?? [])
    .map((memory) => ({ memory, score: jaccard(key, contentKey(memory.text)) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_KNOWN_FOR_RELATION)
    .map((item) => item.memory)
}

async function ask(classifier: MemoryClassifier, state: Record<string, unknown>, questions: Record<string, ClassifierQuestion>, signal: AbortSignal, timeoutMs: number): Promise<ClassifierResult> {
  const request = { state, questions }
  if (!validateClassifierRequest(request).ok) return { ok: false, failure: { code: 'invalid_request', retryable: false }, usage: NO_USAGE, latencyMs: 0 }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  try {
    return await classifier.classify(request, deadline)
  } catch {
    // The contract says classify never throws; a broken implementation is an outage.
    return { ok: false, failure: { code: 'unavailable', retryable: true }, usage: NO_USAGE, latencyMs: 0 }
  }
}

function turnState(window: ExtractionWindow): Record<string, unknown> {
  return { user_turn: window.text, earlier_user_turns: window.priorTurns.map((turn) => turn.text) }
}

function withReview(candidate: ExtractionCandidate, verdict: CandidateVerdict): ExtractionCandidate {
  if (verdict.verdict === 'keep') return candidate
  if (verdict.verdict === 'reject') return { ...candidate, review: 'reject' }
  if (verdict.verdict === 'abstain') return { ...candidate, review: 'abstain' }
  // Narrow: a durable-looking statement becomes a local, per-task candidate.
  if (candidate.speechAct !== 'self_statement') return candidate
  return {
    ...candidate,
    speechAct: 'temporary_instruction',
    scope: 'local',
    conditions: candidate.conditions.length ? candidate.conditions : [{ key: 'scope', operator: 'equals', value: 'current_task' }],
  }
}

const REFUSED = new Set(['quoted', 'hypothetical', 'joke', 'question', 'assistant_suggestion', 'tool_outcome'])

/**
 * Classifies validated proposals. Proposals the reconciler refuses anyway
 * are not sent, so the classifier cannot be asked to rescue them.
 */
async function verifyCandidates(
  options: ClassifiedExtractorOptions,
  window: ExtractionWindow,
  candidates: readonly ExtractionCandidate[],
  signal: AbortSignal,
): Promise<{ reviewed: ExtractionCandidate[]; trace: Omit<ClassificationTrace, 'mode' | 'classifier' | 'gate'> }> {
  const thresholds = options.thresholds ?? DEFAULT_CLASSIFIER_THRESHOLDS
  const timeoutMs = options.classifierTimeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS
  const open = candidates.map((candidate, index) => ({ candidate, index })).filter((item) => !REFUSED.has(item.candidate.speechAct) && item.candidate.operation !== 'no_op')
  if (!open.length) return { reviewed: [...candidates], trace: { status: 'skipped_no_candidates', failure: null, verdicts: [], calls: 0, latencyMs: 0, usage: NO_USAGE } }

  const questions: Record<string, ClassifierQuestion> = {}
  const state: Record<string, unknown> = turnState(window)
  for (const { candidate, index } of open) {
    Object.assign(questions, candidateQuestions(`c${index}`))
    state[`c${index}_clause`] = candidate.evidence.quote
  }
  // Each question refers to its own clause; rename the generic reference.
  for (const [key, question] of Object.entries(questions)) {
    const prefix = key.split('_')[0]!
    questions[key] = { ...question, instructions: question.instructions.replaceAll('`clause`', `\`${prefix}_clause\``) } as ClassifierQuestion
  }
  let usage = NO_USAGE
  let latencyMs = 0
  let calls = 1
  const first = await ask(options.classifier, state, questions, signal, timeoutMs)
  usage = addUsage(usage, first.usage)
  latencyMs += first.latencyMs
  if (!first.ok) {
    const verdicts = open.map(({ index }) => ({ index, verdict: 'abstain' as const, claim: null, reason: 'classifier_unavailable' as const }))
    const abstained = new Set(open.map((item) => item.index))
    return {
      reviewed: candidates.map((candidate, index) => abstained.has(index) ? { ...candidate, review: 'abstain' as const } : candidate),
      trace: { status: 'failed', failure: first.failure.code, verdicts, calls, latencyMs, usage },
    }
  }

  // Dependent stage: only after scope-bound retrieval, and only for proposals
  // that would otherwise be kept, ask how they relate to what is known.
  const answers = { ...first.answers }
  const relationState: Record<string, unknown> = {}
  const relation: Record<string, ClassifierQuestion> = {}
  for (const { candidate, index } of open) {
    const initial = candidateVerdict(answers, `c${index}`, thresholds)
    if (initial.verdict !== 'keep') continue
    const known = relatedKnown(window, candidate)
    known.forEach((memory, position) => {
      const prefix = `r${index}k${position}`
      relationState[`${prefix}_clause`] = candidate.evidence.quote
      relationState[`${prefix}_known_memory`] = memory.text.replace(/^User said:\s*/u, '')
      for (const [key, question] of Object.entries(relationQuestions(prefix))) {
        relation[key] = { ...question, instructions: question.instructions.replaceAll('`clause`', `\`${prefix}_clause\``).replaceAll('`known_memory`', `\`${prefix}_known_memory\``) } as ClassifierQuestion
      }
    })
  }
  const relationFlags = new Map<number, 'changed'>()
  if (Object.keys(relation).length) {
    calls += 1
    const second = await ask(options.classifier, relationState, relation, signal, timeoutMs)
    usage = addUsage(usage, second.usage)
    latencyMs += second.latencyMs
    if (second.ok) {
      for (const [key, answer] of Object.entries(second.answers)) {
        const index = Number(/^r(\d+)k/u.exec(key)?.[1])
        if (answer.type === 'choice' && answer.confidence >= thresholds.minChoiceConfidence && (answer.choice === 'changed' || answer.choice === 'exception')) relationFlags.set(index, 'changed')
      }
    } else {
      // Relation unknown: do not keep as a clean new memory.
      for (const { index } of open) if (candidateVerdict(answers, `c${index}`, thresholds).verdict === 'keep' && relatedKnown(window, candidates[index]!).length) relationFlags.set(index, 'changed')
    }
  }

  const verdicts: (CandidateVerdict & { index: number })[] = []
  const reviewed = candidates.map((candidate, index) => {
    if (!open.some((item) => item.index === index)) return candidate
    let verdict = candidateVerdict(answers, `c${index}`, thresholds)
    if (verdict.verdict === 'keep' && relationFlags.has(index)) verdict = { verdict: 'abstain', claim: verdict.claim, reason: 'classifier_changed' }
    verdicts.push({ ...verdict, index })
    return withReview(candidate, verdict)
  })
  return { reviewed, trace: { status: 'ok', failure: null, verdicts, calls, latencyMs, usage } }
}

/** The trace rides along in the output; the shared validator ignores it. */
function serialize(candidates: readonly ExtractionCandidate[], classification: ClassificationTrace): unknown {
  return { candidates: candidates.map((candidate) => ({ ...candidate })), classification }
}

/** Reads the trace a classified extractor attached to its output, if any. */
export function classificationTraceOf(output: unknown): ClassificationTrace | null {
  const trace = output && typeof output === 'object' ? (output as { classification?: unknown }).classification : null
  return trace && typeof trace === 'object' && typeof (trace as { status?: unknown }).status === 'string' ? trace as ClassificationTrace : null
}

export function createClassifiedExtractor(options: ClassifiedExtractorOptions): MemoryExtractor {
  const { base, classifier, mode } = options
  const thresholds = options.thresholds ?? DEFAULT_CLASSIFIER_THRESHOLDS
  const identity = {
    id: `${base.id}+${classifier.id}+${mode}`.slice(0, 80),
    version: `${base.version}+${classifier.version}`.slice(0, 80),
    promptVersion: `${base.promptVersion}+${CANDIDATE_QUESTION_VERSION}`.slice(0, 80),
    schemaVersion: LEARNING_SCHEMA_VERSION,
    model: `${base.model ?? 'local'}+${classifier.model}`.slice(0, 160),
    placement: base.placement === 'remote' || classifier.placement === 'remote' ? 'remote' as const : 'local' as const,
  }
  const classifierInfo = { id: classifier.id, model: classifier.model, provider: classifier.provider }

  return {
    ...identity,
    async extract(window: ExtractionWindow, signal: AbortSignal) {
      let gate: ClassificationTrace['gate'] = null
      let gateUsage = NO_USAGE
      let gateLatency = 0
      let gateFailure: string | null = null
      if (mode === 'gate') {
        const result = await ask(classifier, turnState(window), windowGateQuestions(), signal, options.classifierTimeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS)
        gateUsage = result.usage
        gateLatency = result.latencyMs
        const probability = result.ok && result.answers.gate_has_memory?.type === 'noul' ? result.answers.gate_has_memory.noul : null
        if (!result.ok) gateFailure = result.failure.code
        const skip = probability !== null && probability <= thresholds.gateSkipMax
        gate = { probability, skippedExtraction: skip }
        if (skip) {
          const trace: ClassificationTrace = { mode, classifier: classifierInfo, status: 'ok', failure: null, gate, verdicts: [], calls: 1, latencyMs: gateLatency, usage: gateUsage }
          return { output: serialize([], trace), usage: { inputUnits: gateUsage.inputTokens, outputUnits: gateUsage.outputTokens, costMicros: gateUsage.costMicros } }
        }
      }
      const extracted = await base.extract(window, signal)
      const usage: ExtractorUsage = { ...extracted.usage }
      usage.inputUnits += gateUsage.inputTokens
      usage.outputUnits += gateUsage.outputTokens
      usage.costMicros += gateUsage.costMicros
      const validated = validateExtractorOutput(window, extracted.output)
      if (mode === 'gate') {
        // Gate mode only decides whether to extract. If the gate itself
        // failed, proposals are held for review rather than trusted blindly.
        const candidates = gateFailure ? validated.candidates.map((candidate) => REFUSED.has(candidate.speechAct) ? candidate : { ...candidate, review: 'abstain' as const }) : [...validated.candidates]
        const trace: ClassificationTrace = { mode, classifier: classifierInfo, status: gateFailure ? 'failed' : 'ok', failure: gateFailure, gate, verdicts: [], calls: 1, latencyMs: gateLatency, usage: gateUsage }
        return { output: serialize(candidates, trace), usage }
      }
      const { reviewed, trace } = await verifyCandidates(options, window, validated.candidates, signal)
      const full: ClassificationTrace = { mode, classifier: classifierInfo, gate, ...trace }
      usage.inputUnits += trace.usage.inputTokens
      usage.outputUnits += trace.usage.outputTokens
      usage.costMicros += trace.usage.costMicros
      return { output: serialize(reviewed, full), usage }
    },
  }
}
