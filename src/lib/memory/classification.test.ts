import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CLASSIFIER_THRESHOLDS,
  activityQuestions,
  activityVerdict,
  candidateQuestions,
  candidateVerdict,
  parseClassifierAnswers,
  validateClassifierRequest,
  type ClassifierAnswer,
  type ClassifierRequest,
  type ClassifierResult,
  type MemoryClassifier,
} from './classification'
import { classificationTraceOf, createClassifiedExtractor } from './classified-extractor'
import { decideCandidate, validateExtractorOutput, type ExtractionWindow, type MemoryExtractor } from './learning'
import { RULE_EXTRACTOR } from './rule-extractor'
import { memoryClassifierPlan } from './rollout'

const usage = { inputTokens: 10, outputTokens: 0, costMicros: 1 }

function window(text: string, knownMemories?: ExtractionWindow['knownMemories']): ExtractionWindow {
  return {
    schemaVersion: 1, scopeId: 'user/cls', eventId: 'event/cls/1', conversationId: 'conversation/cls',
    sourceRevision: 'revision/source/cls', receivedAt: '2026-09-23T10:00:00.000Z', text, priorTurns: [],
    ...(knownMemories ? { knownMemories } : {}),
  }
}

function choice(options: readonly string[], pick: string, p = 0.9): ClassifierAnswer {
  const rest = (1 - p) / (options.length - 1)
  const probabilities = Object.fromEntries(options.map((option) => [option, option === pick ? p : rest]))
  return { type: 'choice', choice: pick, probabilities, confidence: p }
}

const ACTS = ['self_statement', 'quoted', 'hypothetical', 'joke', 'question', 'assistant_echo', 'task_instruction']
const DURABILITY = ['durable', 'temporary', 'not_memory']
const RELATIONS = ['same', 'changed', 'exception', 'unrelated']

/** Fixture classifier: answers every candidate the same way, records requests. */
function fixtureClassifier(answer: (key: string, request: ClassifierRequest) => ClassifierAnswer | undefined): MemoryClassifier & { requests: ClassifierRequest[] } {
  const requests: ClassifierRequest[] = []
  return {
    id: 'fixture', version: '1', model: 'fixture-model', placement: 'local', provider: 'fixture', requests,
    async classify(request) {
      requests.push(request)
      const answers: Record<string, ClassifierAnswer> = {}
      for (const key of Object.keys(request.questions)) {
        const value = answer(key, request)
        if (value) answers[key] = value
      }
      return { ok: true, answers, model: 'fixture-model', usage, latencyMs: 1 }
    },
  }
}

function answerAll(act: string, durability: string, claim: number, relation = 'unrelated') {
  return (key: string): ClassifierAnswer | undefined => {
    if (key.endsWith('_act')) return choice(ACTS, act)
    if (key.endsWith('_durability')) return choice(DURABILITY, durability)
    if (key.endsWith('_claim')) return { type: 'noul', noul: claim }
    if (key.endsWith('_relation')) return choice(RELATIONS, relation)
    if (key === 'gate_has_memory') return { type: 'noul', noul: claim }
    return undefined
  }
}

async function run(extractor: MemoryExtractor, input: ExtractionWindow) {
  const { output, usage: spent } = await extractor.extract(input, new AbortController().signal)
  const validated = validateExtractorOutput(input, output)
  const decisions = validated.candidates.map((candidate) => decideCandidate(candidate, [], { activeTopicKnown: false, sourceText: input.text }))
  return { output, validated, decisions, spent, trace: classificationTraceOf(output) }
}

describe('Stage 11 classification contract', () => {
  it('bounds requests: question count, keys, options, levels and state size', () => {
    const questions = candidateQuestions('c0')
    expect(validateClassifierRequest({ state: { user_turn: 'hi' }, questions })).toEqual({ ok: true })
    expect(validateClassifierRequest({ state: {}, questions: {} })).toEqual({ ok: false, reason: 'no_questions' })
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`q${index}`, { type: 'noul', instructions: 'x' }]))
    expect(validateClassifierRequest({ state: {}, questions: many as ClassifierRequest['questions'] })).toEqual({ ok: false, reason: 'too_many_questions' })
    expect(validateClassifierRequest({ state: {}, questions: { 'Bad Key': { type: 'noul', instructions: 'x' } } })).toEqual({ ok: false, reason: 'invalid_question_key' })
    expect(validateClassifierRequest({ state: {}, questions: { q: { type: 'choice', instructions: 'x', criteria: { only: null } } } })).toEqual({ ok: false, reason: 'invalid_choice_options' })
    expect(validateClassifierRequest({ state: {}, questions: { q: { type: 'score', instructions: 'x', criteria: ['a'] } } })).toEqual({ ok: false, reason: 'invalid_score_levels' })
    expect(validateClassifierRequest({ state: { text: 'x'.repeat(30_000) }, questions })).toEqual({ ok: false, reason: 'state_too_large' })
  })

  it('rejects malformed answers as a whole: missing, wrong type, unknown option, bad sums, non-argmax choice', () => {
    const request: ClassifierRequest = { state: {}, questions: { ...candidateQuestions('c0') } }
    const good = { c0_act: choice(ACTS, 'self_statement'), c0_durability: choice(DURABILITY, 'durable'), c0_claim: { type: 'noul', noul: 0.9 } }
    expect(parseClassifierAnswers(request, good)).not.toBeNull()
    expect(parseClassifierAnswers(request, { ...good, c0_claim: undefined })).toBeNull()
    expect(parseClassifierAnswers(request, { ...good, c0_claim: { type: 'choice', noul: 0.9 } })).toBeNull()
    expect(parseClassifierAnswers(request, { ...good, c0_claim: { type: 'noul', noul: 1.3 } })).toBeNull()
    expect(parseClassifierAnswers(request, { ...good, c0_act: { ...choice(ACTS, 'self_statement'), choice: 'admin' } })).toBeNull()
    expect(parseClassifierAnswers(request, { ...good, c0_durability: { type: 'choice', choice: 'durable', probabilities: { durable: 0.9, temporary: 0.9, not_memory: 0 }, confidence: 0.5 } })).toBeNull()
    expect(parseClassifierAnswers(request, { ...good, c0_durability: { type: 'choice', choice: 'durable', probabilities: { durable: 0.1, temporary: 0.8, not_memory: 0.1 }, confidence: 0.7 } })).toBeNull()
    expect(parseClassifierAnswers(request, 'not json')).toBeNull()
  })

  it('verdicts are conservative: refusal beats a high claim, contradictions and low confidence abstain', () => {
    const t = DEFAULT_CLASSIFIER_THRESHOLDS
    const answers = (act: string, durability: string, claim: number, confidence = 0.9) => ({
      c0_act: choice(ACTS, act, confidence), c0_durability: choice(DURABILITY, durability, confidence), c0_claim: { type: 'noul' as const, noul: claim },
    })
    expect(candidateVerdict(answers('self_statement', 'durable', 0.95), 'c0', t)).toEqual({ verdict: 'keep', claim: 0.95 })
    // Contradictory: says it is a quote but also a sincere claim.
    expect(candidateVerdict(answers('quoted', 'durable', 0.99), 'c0', t)).toMatchObject({ verdict: 'reject', reason: 'classifier_refused_act' })
    expect(candidateVerdict(answers('self_statement', 'not_memory', 0.99), 'c0', t)).toMatchObject({ verdict: 'reject', reason: 'classifier_not_memory' })
    expect(candidateVerdict(answers('self_statement', 'durable', 0.1), 'c0', t)).toMatchObject({ verdict: 'reject', reason: 'classifier_not_claim' })
    expect(candidateVerdict(answers('task_instruction', 'temporary', 0.1), 'c0', t)).toMatchObject({ verdict: 'narrow' })
    expect(candidateVerdict(answers('self_statement', 'temporary', 0.9), 'c0', t)).toMatchObject({ verdict: 'narrow' })
    expect(candidateVerdict(answers('self_statement', 'durable', 0.6), 'c0', t)).toMatchObject({ verdict: 'abstain', reason: 'classifier_uncertain' })
    // Low-confidence choices are unknown, so a high claim alone cannot keep.
    expect(candidateVerdict(answers('self_statement', 'durable', 0.95, 0.4), 'c0', t)).toMatchObject({ verdict: 'abstain' })
    expect(candidateVerdict({}, 'c0', t)).toMatchObject({ verdict: 'abstain', reason: 'classifier_unavailable' })
  })

  it('activity labels need confidence and are never guessed on failure', () => {
    const t = DEFAULT_CLASSIFIER_THRESHOLDS
    const options = Object.keys(activityQuestions().activity!.type === 'choice' ? (activityQuestions().activity as { criteria: object }).criteria : {})
    const ok = (pick: string, p: number): ClassifierResult => ({ ok: true, answers: { activity: choice(options, pick, p) }, model: 'm', usage, latencyMs: 1 })
    expect(activityVerdict(ok('work_meeting', 0.8), t)).toBe('work_meeting')
    expect(activityVerdict(ok('work_meeting', 0.4), t)).toBeNull()
    expect(activityVerdict(ok('other', 0.9), t)).toBeNull()
    expect(activityVerdict({ ok: false, failure: { code: 'timeout', retryable: true }, usage, latencyMs: 5 }, t)).toBeNull()
  })

  it('the validator accepts only conservative review values and the reconciler honors them', () => {
    const input = window('I love jazz.')
    const base = { kind: 'preference', text: 'User said: I love jazz', speechAct: 'self_statement', polarity: 'positive', scope: 'general', conditions: [], relation: 'ordinary', operation: 'add', evidence: { start: 0, end: 11, quote: 'I love jazz' } }
    expect(validateExtractorOutput(input, { candidates: [{ ...base, review: 'accept' }] }).rejected).toEqual([{ index: 0, reason: 'invalid_shape' }])
    const [abstained, refused] = validateExtractorOutput(input, { candidates: [{ ...base, review: 'abstain' }, { ...base, review: 'reject' }] }).candidates
    expect(decideCandidate(abstained!, [], { activeTopicKnown: false })).toMatchObject({ action: 'add', status: 'candidate', reason: 'classifier_abstained' })
    expect(decideCandidate(refused!, [], { activeTopicKnown: false })).toMatchObject({ action: 'reject', reason: 'classifier_rejected' })
    // An abstained restatement does not corroborate (corroboration feeds promotion).
    const existing = [{ assertionId: 'assertion/a', revision: 1, kind: 'preference' as const, text: 'User said: I love jazz', polarity: 'positive' as const, status: 'accepted' as const, basis: 'explicit_user_statement' as const, conditions: [] }]
    expect(decideCandidate(abstained!, existing, { activeTopicKnown: false })).toMatchObject({ action: 'add', status: 'candidate' })
  })
})

describe('Stage 11 classified extraction workflow', () => {
  it('verify: keeps a confirmed durable claim and sends only data, never ids, to the classifier', async () => {
    const classifier = fixtureClassifier(answerAll('self_statement', 'durable', 0.95))
    const extractor = createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier, mode: 'verify' })
    const result = await run(extractor, window('I really like green tea in the morning.'))
    expect(result.decisions).toMatchObject([{ action: 'add', status: 'accepted' }])
    expect(result.trace).toMatchObject({ mode: 'verify', status: 'ok', calls: 1, verdicts: [{ verdict: 'keep' }] })
    expect(classifier.requests[0]!.state).toEqual({ user_turn: 'I really like green tea in the morning.', earlier_user_turns: [], c0_clause: 'I really like green tea in the morning' })
    expect(JSON.stringify(classifier.requests)).not.toMatch(/user\/cls|event\/cls|scope|grant|tenant/u)
    expect(result.spent.costMicros).toBe(1)
    expect(extractor).toMatchObject({ id: 'gideon-rules+fixture+verify', placement: 'local', model: 'local+fixture-model' })
  })

  it('verify: refuses, narrows or holds instead of trusting the extractor', async () => {
    const refuse = await run(createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier: fixtureClassifier(answerAll('joke', 'not_memory', 0.05)), mode: 'verify' }), window('I love Mondays.'))
    expect(refuse.decisions).toMatchObject([{ action: 'reject', reason: 'classifier_rejected' }])
    const narrow = await run(createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier: fixtureClassifier(answerAll('self_statement', 'temporary', 0.9)), mode: 'verify' }), window('I prefer window seats.'))
    expect(narrow.decisions).toMatchObject([{ action: 'add', status: 'candidate', basis: 'inference', candidate: { scope: 'local', speechAct: 'temporary_instruction' } }])
    const hold = await run(createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier: fixtureClassifier(answerAll('self_statement', 'durable', 0.55)), mode: 'verify' }), window('I prefer window seats.'))
    expect(hold.decisions).toMatchObject([{ action: 'add', status: 'candidate', reason: 'classifier_abstained' }])
  })

  it('verify: never asks about proposals the reconciler refuses, and cannot rescue them', async () => {
    const classifier = fixtureClassifier(answerAll('self_statement', 'durable', 0.99))
    const result = await run(createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier, mode: 'verify' }), window('My colleague said "I hate working remotely".'))
    expect(classifier.requests).toHaveLength(0)
    expect(result.decisions.every((decision) => decision.action === 'reject')).toBe(true)
  })

  it('relation stage runs second, over code-retrieved known memories, and a change is held for review', async () => {
    const classifier = fixtureClassifier(answerAll('self_statement', 'durable', 0.95, 'changed'))
    const input = window('I live in Karachi now.', [{ handle: 'k0', text: 'User said: I live in Lahore' }, { handle: 'k1', text: 'User said: I love jazz' }])
    const result = await run(createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier, mode: 'verify' }), input)
    expect(classifier.requests).toHaveLength(2)
    // The first request never includes known memories; they are not needed to classify the clause itself.
    expect(JSON.stringify(classifier.requests[0])).not.toContain('Lahore')
    const second = classifier.requests[1]!
    expect(Object.keys(second.questions)).toEqual(['r0k0_relation'])
    expect(second.state).toEqual({ r0k0_clause: 'I live in Karachi now', r0k0_known_memory: 'I live in Lahore' })
    expect(result.decisions).toMatchObject([{ action: 'add', status: 'candidate', reason: 'classifier_abstained' }])
  })

  it('C30: a failed, slow, cancelled or malformed classifier abstains; it never fabricates confidence', async () => {
    const failing: MemoryClassifier = { id: 'down', version: '1', model: 'down', placement: 'remote', provider: 'fixture', classify: async () => ({ ok: false, failure: { code: 'unavailable', retryable: true }, usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 }, latencyMs: 3 }) }
    const throwing: MemoryClassifier = { ...failing, classify: async () => { throw new Error('boom') } }
    const hanging: MemoryClassifier = { ...failing, classify: (_request, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'timeout', retryable: true }, usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 }, latencyMs: 50 }))) }
    const malformed: MemoryClassifier = { ...failing, classify: async () => ({ ok: false, failure: { code: 'malformed', retryable: false }, usage, latencyMs: 2 }) }
    for (const classifier of [failing, throwing, hanging, malformed]) {
      const started = Date.now()
      const result = await run(createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier, mode: 'verify', classifierTimeoutMs: 50 }), window('I prefer aisle seats.'))
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(result.trace).toMatchObject({ status: 'failed', verdicts: [{ verdict: 'abstain', claim: null, reason: 'classifier_unavailable' }] })
      expect(result.decisions).toMatchObject([{ action: 'add', status: 'candidate', reason: 'classifier_abstained' }])
    }
    // Cancellation of the job itself propagates to the classifier.
    const controller = new AbortController()
    controller.abort()
    const seen = vi.fn<(signal: AbortSignal) => void>()
    const observing: MemoryClassifier = { ...failing, classify: async (_request, signal) => { seen(signal); return { ok: false, failure: { code: 'cancelled', retryable: false }, usage, latencyMs: 0 } } }
    const extractor = createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier: observing, mode: 'verify' })
    await extractor.extract(window('I prefer aisle seats.'), controller.signal)
    expect(seen.mock.calls[0]![0].aborted).toBe(true)
  })

  it('gate: skips the extractor when confidently empty, extracts otherwise, and holds proposals if the gate fails', async () => {
    const base: MemoryExtractor & { calls: number } = { ...RULE_EXTRACTOR, calls: 0, async extract(input, signal) { base.calls += 1; return RULE_EXTRACTOR.extract(input, signal) } }
    const skip = await run(createClassifiedExtractor({ base, classifier: fixtureClassifier(answerAll('question', 'not_memory', 0.02)), mode: 'gate' }), window('What is the weather tomorrow?'))
    expect(base.calls).toBe(0)
    expect(skip.trace).toMatchObject({ gate: { probability: 0.02, skippedExtraction: true } })
    const pass = await run(createClassifiedExtractor({ base, classifier: fixtureClassifier(answerAll('self_statement', 'durable', 0.9)), mode: 'gate' }), window('I prefer aisle seats.'))
    expect(base.calls).toBe(1)
    expect(pass.decisions).toMatchObject([{ action: 'add', status: 'accepted' }])
    const down: MemoryClassifier = { id: 'down', version: '1', model: 'down', placement: 'remote', provider: 'fixture', classify: async () => ({ ok: false, failure: { code: 'rate_limited', retryable: true }, usage, latencyMs: 1 }) }
    const failed = await run(createClassifiedExtractor({ base, classifier: down, mode: 'gate' }), window('I prefer aisle seats.'))
    expect(base.calls).toBe(2)
    expect(failed.decisions).toMatchObject([{ action: 'add', status: 'candidate', reason: 'classifier_abstained' }])
  })

  it('flags: off by default, needs a mode plus the spend switch, rejects unknown values, gated in production', () => {
    expect(memoryClassifierPlan({})).toBeNull()
    expect(memoryClassifierPlan({ GIDEON_MEMORY_CLASSIFIER_MODE: 'shadow' })).toBeNull()
    expect(memoryClassifierPlan({ GIDEON_MEMORY_CLASSIFIER_MODE: 'shadow', GIDEON_MEMORY_CLASSIFIER_REMOTE_ALLOWED: '1' })).toEqual({ mode: 'shadow', provider: 'jev', workflow: 'verify' })
    expect(memoryClassifierPlan({ GIDEON_MEMORY_CLASSIFIER_MODE: 'enforce', GIDEON_MEMORY_CLASSIFIER_REMOTE_ALLOWED: '1', GIDEON_MEMORY_CLASSIFIER_PROVIDER: 'substitute', GIDEON_MEMORY_CLASSIFIER_WORKFLOW: 'gate' })).toEqual({ mode: 'enforce', provider: 'substitute', workflow: 'gate' })
    expect(memoryClassifierPlan({ GIDEON_MEMORY_CLASSIFIER_MODE: 'on', GIDEON_MEMORY_CLASSIFIER_REMOTE_ALLOWED: '1' })).toBeNull()
    expect(memoryClassifierPlan({ GIDEON_MEMORY_CLASSIFIER_MODE: 'shadow', GIDEON_MEMORY_CLASSIFIER_REMOTE_ALLOWED: '1', GIDEON_MEMORY_CLASSIFIER_PROVIDER: 'other' })).toBeNull()
    expect(memoryClassifierPlan({ GIDEON_MEMORY_CLASSIFIER_MODE: 'shadow', GIDEON_MEMORY_CLASSIFIER_REMOTE_ALLOWED: '1', NODE_ENV: 'production' })).toBeNull()
  })
})

