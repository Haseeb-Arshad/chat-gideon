import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createSubstituteClassifier, DEFAULT_SUBSTITUTE_CLASSIFIER_MODEL } from '../backend/memory/src/llm-classifier'
import { createModelExtractor } from '../backend/memory/src/model-extractor'
import { createTypeSafeClassifier } from '../backend/memory/src/typesafe-classifier'
import {
  DEFAULT_CLASSIFIER_THRESHOLDS,
  activityQuestions,
  activityVerdict,
  type ClassifierThresholds,
  type MemoryClassifier,
} from '../src/lib/memory/classification'
import { classificationTraceOf, createClassifiedExtractor, type ClassificationTrace } from '../src/lib/memory/classified-extractor'
import {
  decideCandidate,
  screenWindow,
  validateExtractorOutput,
  type ExistingMemory,
  type ExtractionWindow,
  type MemoryExtractor,
} from '../src/lib/memory/learning'
import { RULE_EXTRACTOR } from '../src/lib/memory/rule-extractor'

/**
 * Stage 11 matched comparison: rules, a conventional structured extractor,
 * extractor + classifier verification, classifier gating + extractor, and
 * rules + classifier verification, over the same examples and the same
 * downstream reader (screen → extract → validate → reconcile).
 *
 * Offline by default: dataset integrity checks and the rules arm only.
 * MEMORY_CLASSIFIER_EVAL_PHASE=dev|heldout with MEMORY_CLASSIFIER_EVAL_LIVE=1
 * makes real OpenRouter calls to the single authorized model, cached on disk,
 * with a hard stop at SPEND_CAP_USD of provider-reported cost. Jev arms run
 * only when TYPESAFE_API_KEY is present; otherwise they are reported blocked.
 */

const root = resolve(import.meta.dirname, '..')
const SPEND_CAP_USD = 0.25
const AUTHORIZED_MODEL = 'openai/gpt-6-luna'
const CACHE_PATH = resolve(root, 'output/memory-classifier-eval/cache.json')
const THRESHOLDS_PATH = resolve(root, 'scripts/fixtures/memory-classifier-thresholds.json')
const phase = process.env.MEMORY_CLASSIFIER_EVAL_PHASE as 'dev' | 'heldout' | undefined
const live = process.env.MEMORY_CLASSIFIER_EVAL_LIVE === '1'

interface Expected { kind: string; polarity: string; scope: string; status: string; contains?: string }
interface Case { id: string; trajectory: string; language: string; category: string; text: string; known?: { kind: string; polarity: string; text: string }[]; expected: Expected[]; forbidden?: string[] }
interface ActivityCase { id: string; trajectory: string; text: string; activity: string | null }
interface Dataset { cases: Case[]; activityCases: ActivityCase[] }

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as T
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')
}

function loadSplit(split: 'dev' | 'heldout'): Dataset {
  if (split === 'heldout') return readJson<Dataset>('scripts/fixtures/memory-classifier-heldout.json')
  const dev = readJson<Dataset>('scripts/fixtures/memory-classifier-dev.json')
  const stage10 = readJson<{ cases: Omit<Case, 'trajectory'>[] }>('scripts/fixtures/memory-extraction-dev.json')
  return { cases: [...stage10.cases.map((item) => ({ ...item, trajectory: `s10-${item.id}` })), ...dev.cases], activityCases: dev.activityCases }
}

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// ---------------------------------------------------------------------------
// Spend control and response cache
// ---------------------------------------------------------------------------

interface CacheEntry { status: number; body: string; latencyMs: number; costUsd: number }
const cache: Record<string, CacheEntry> = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {}
const spend = { usd: 0, calls: 0, cacheHits: 0 }
/** Provider time per case: recorded latency of each call, live or replayed from cache. */
const caseCalls = new AsyncLocalStorage<{ ms: number; calls: number }>()

function saveCache(): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true })
  writeFileSync(CACHE_PATH, JSON.stringify(cache))
}

function openRouterKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const line = readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/u).find((entry) => entry.startsWith('OPENROUTER_API_KEY='))
  return line ? line.slice('OPENROUTER_API_KEY='.length).replace(/^["']|["']$/gu, '').trim() : ''
}

/** Cached fetch: replays identical requests, refuses anything but the authorized model, stops at the cap. */
function cachedFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = String(init?.body ?? '')
    if (url.includes('openrouter.ai')) {
      const model = (JSON.parse(body) as { model?: string }).model
      if (model !== AUTHORIZED_MODEL) throw new Error(`refusing unauthorized model ${model}`)
    }
    const key = createHash('sha256').update(`${url}\n${body}`).digest('hex')
    const hit = cache[key]
    if (hit) {
      spend.cacheHits += 1
      const current = caseCalls.getStore()
      if (current) { current.ms += hit.latencyMs; current.calls += 1 }
      return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json', 'x-cached-latency': String(hit.latencyMs) } })
    }
    if (!live) throw new Error('live provider calls are disabled (set MEMORY_CLASSIFIER_EVAL_LIVE=1)')
    if (spend.usd >= SPEND_CAP_USD) throw new Error(`spend cap reached: $${spend.usd.toFixed(4)}`)
    const started = performance.now()
    const response = await globalThis.fetch(input, init)
    const text = await response.text()
    const latencyMs = Math.round(performance.now() - started)
    const current = caseCalls.getStore()
    if (current) { current.ms += latencyMs; current.calls += 1 }
    let costUsd = 0
    try { costUsd = Number((JSON.parse(text) as { usage?: { cost?: number } }).usage?.cost ?? 0) || 0 } catch { costUsd = 0 }
    spend.usd += costUsd
    spend.calls += 1
    // Only successful responses are cached, so transient errors are retried next run.
    if (response.ok) cache[key] = { status: response.status, body: text, latencyMs, costUsd }
    if (spend.calls % 20 === 0) saveCache()
    return new Response(text, { status: response.status, headers: { 'content-type': 'application/json', 'x-cached-latency': String(latencyMs) } })
  }) as typeof fetch
}

// ---------------------------------------------------------------------------
// One arm over one case, with the shared downstream reader
// ---------------------------------------------------------------------------

interface Produced { kind: string; polarity: string; scope: string; status: string; text: string; reason: string }
interface CaseResult {
  id: string; category: string; language: string
  produced: Produced[]
  screened: boolean
  error: string | null
  wallMs: number
  providerMs: number
  providerCalls: number
  costMicros: number
  trace: ClassificationTrace | null
  proposals: { text: string; claim: number | null; verdict: string | null; truth: 0 | 1 }[]
}

function knownMemories(item: Case): ExistingMemory[] {
  return (item.known ?? []).map((memory, index) => ({
    assertionId: `assertion/known/${item.id}/${index}`, revision: 1, kind: memory.kind as ExistingMemory['kind'], text: memory.text,
    polarity: memory.polarity as ExistingMemory['polarity'], status: 'accepted', basis: 'explicit_user_statement', conditions: [],
  }))
}

function windowFor(item: Case): ExtractionWindow {
  return {
    schemaVersion: 1, scopeId: 'user/eval', eventId: `event/eval/${item.id}`, conversationId: `conversation/eval/${item.trajectory}`,
    sourceRevision: 'revision/source/eval', receivedAt: '2026-09-23T10:00:00.000Z', text: item.text, priorTurns: [],
    ...(item.known?.length ? { knownMemories: item.known.map((memory, index) => ({ handle: `k${index}`, text: memory.text })) } : {}),
  }
}

function matches(expected: Expected, produced: Produced): boolean {
  if (expected.status !== produced.status || expected.scope !== produced.scope) return false
  if (expected.kind === 'preference' && expected.polarity !== 'any' && expected.polarity !== produced.polarity) return false
  if (expected.contains && !produced.text.toLocaleLowerCase('und').includes(expected.contains.toLocaleLowerCase('und'))) return false
  return true
}

/** Whether a proposal, if accepted as a durable general memory, would be correct. */
function proposalTruth(item: Case, text: string): 0 | 1 {
  const lower = text.toLocaleLowerCase('und')
  if (item.forbidden?.some((term) => lower.includes(term.toLocaleLowerCase('und')))) return 0
  return item.expected.some((expected) => expected.status === 'accepted' && expected.scope === 'general' && (!expected.contains || lower.includes(expected.contains.toLocaleLowerCase('und')))) ? 1 : 0
}

async function runCase(extractor: MemoryExtractor, item: Case): Promise<CaseResult> {
  const window = windowFor(item)
  const base: CaseResult = { id: item.id, category: item.category, language: item.language, produced: [], screened: false, error: null, wallMs: 0, providerMs: 0, providerCalls: 0, costMicros: 0, trace: null, proposals: [] }
  if (!screenWindow(window).ok) return { ...base, screened: true }
  const started = performance.now()
  try {
    const calls = { ms: 0, calls: 0 }
    const { output, usage } = await caseCalls.run(calls, () => extractor.extract(window, AbortSignal.timeout(30_000)))
    base.providerMs = calls.ms
    base.providerCalls = calls.calls
    base.wallMs = Math.round(performance.now() - started)
    base.costMicros = usage.costMicros
    base.trace = classificationTraceOf(output)
    const validated = validateExtractorOutput(window, output)
    const existing = knownMemories(item)
    validated.candidates.forEach((candidate, index) => {
      const verdict = base.trace?.verdicts.find((entry) => entry.index === index)
      base.proposals.push({ text: candidate.text, claim: verdict?.claim ?? null, verdict: verdict?.verdict ?? null, truth: proposalTruth(item, candidate.text) })
      const decision = decideCandidate(candidate, existing, { activeTopicKnown: false, sourceText: item.text })
      if (decision.action === 'add') base.produced.push({ kind: decision.candidate.kind, polarity: decision.candidate.polarity, scope: decision.candidate.scope, status: decision.status, text: decision.candidate.text, reason: decision.reason })
    })
  } catch (error) {
    base.wallMs = Math.round(performance.now() - started)
    base.error = error instanceof Error ? error.message.slice(0, 120) : 'error'
  }
  return base
}

async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  }))
  return results
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const REFUSAL = new Set(['quoted', 'hypothetical', 'joke', 'question', 'assistant_suggestion', 'sensitive', 'secret', 'no_claim', 'memory_withdrawal', 'duplicate'])
const CLASSES = ['accepted_general', 'candidate_general', 'candidate_local'] as const

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}

function round(value: number, digits = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0
}

function score(cases: readonly Case[], results: readonly CaseResult[]) {
  const perClass = Object.fromEntries(CLASSES.map((name) => [name, { expected: 0, produced: 0, correct: 0 }]))
  const perCategory: Record<string, { cases: number; falseAccepted: number; missed: number; correct: number }> = {}
  let expectedTotal = 0; let matched = 0; let accepted = 0; let acceptedCorrect = 0; let candidates = 0
  let falseAccepted = 0; let spuriousCandidates = 0; let forbiddenHits = 0; let refusalFalseMemories = 0; let escalations = 0; let errors = 0
  const failures: Record<string, number> = {}
  const perCase: Record<string, unknown>[] = []
  results.forEach((result, index) => {
    const item = cases[index]!
    const category = (perCategory[item.category] ??= { cases: 0, falseAccepted: 0, missed: 0, correct: 0 })
    category.cases += 1
    if (result.error) errors += 1
    if (result.trace?.failure) failures[result.trace.failure] = (failures[result.trace.failure] ?? 0) + 1
    const remaining = [...item.expected]
    for (const expected of item.expected) { const bucket = perClass[`${expected.status}_${expected.scope}`]; if (bucket) bucket.expected += 1 }
    expectedTotal += item.expected.length
    const outcome: string[] = []
    for (const produced of result.produced) {
      const className = `${produced.status}_${produced.scope}`
      if (perClass[className]) perClass[className]!.produced += 1
      if (produced.reason === 'classifier_abstained') escalations += 1
      const forbidden = item.forbidden?.some((term) => produced.text.toLocaleLowerCase('und').includes(term.toLocaleLowerCase('und'))) ?? false
      if (forbidden) forbiddenHits += 1
      const hit = forbidden ? -1 : remaining.findIndex((expected) => matches(expected, produced))
      if (produced.status === 'accepted') accepted += 1
      else candidates += 1
      if (hit >= 0) {
        remaining.splice(hit, 1)
        matched += 1
        category.correct += 1
        if (perClass[className]) perClass[className]!.correct += 1
        if (produced.status === 'accepted') acceptedCorrect += 1
        outcome.push(`ok:${className}`)
      } else if (produced.status === 'accepted') {
        falseAccepted += 1
        category.falseAccepted += 1
        if (REFUSAL.has(item.category)) refusalFalseMemories += 1
        outcome.push(`false_accept:${className}`)
      } else {
        spuriousCandidates += 1
        outcome.push(`spurious_candidate:${className}`)
      }
    }
    category.missed += remaining.length
    perCase.push({ id: item.id, category: item.category, outcome, missed: remaining.map((expected) => `${expected.status}_${expected.scope}`), error: result.error, classifier: result.trace?.status ?? null })
  })
  const proposals = results.flatMap((result) => result.proposals).filter((proposal) => proposal.claim !== null)
  const brier = proposals.length ? proposals.reduce((sum, proposal) => sum + (proposal.claim! - proposal.truth) ** 2, 0) / proposals.length : null
  const bins = Array.from({ length: 5 }, () => ({ count: 0, confidence: 0, truth: 0 }))
  for (const proposal of proposals) {
    const bin = bins[Math.min(4, Math.floor(proposal.claim! * 5))]!
    bin.count += 1; bin.confidence += proposal.claim!; bin.truth += proposal.truth
  }
  const ece = proposals.length ? bins.reduce((sum, bin) => sum + (bin.count ? Math.abs(bin.confidence / bin.count - bin.truth / bin.count) * bin.count : 0), 0) / proposals.length : null
  const ranked = [...proposals].sort((left, right) => right.claim! - left.claim!)
  const riskCoverage = [0.25, 0.5, 0.75, 1].map((coverage) => {
    const covered = ranked.slice(0, Math.max(1, Math.round(coverage * ranked.length)))
    return { coverage, n: covered.length, risk: covered.length ? round(covered.filter((proposal) => proposal.truth === 0).length / covered.length) : null }
  })
  const walls = results.filter((result) => result.providerCalls > 0).map((result) => result.providerMs)
  const callCounts = results.filter((result) => !result.screened).map((result) => result.providerCalls)
  return {
    cases: cases.length,
    expected: expectedTotal,
    produced: accepted + candidates,
    accepted,
    candidates,
    recall: round(expectedTotal ? matched / expectedTotal : 1),
    acceptedPrecision: round(accepted ? acceptedCorrect / accepted : 1),
    falseAccepted,
    falseAcceptanceRatePerCase: round(falseAccepted / cases.length),
    refusalCategoryFalseMemories: refusalFalseMemories,
    forbiddenHits,
    spuriousCandidates,
    missed: expectedTotal - matched,
    escalations,
    escalationRate: round(accepted + candidates ? escalations / (accepted + candidates) : 0),
    errors,
    classifierFailures: failures,
    perClass: Object.fromEntries(Object.entries(perClass).map(([name, value]) => [name, { ...value, precision: round(value.produced ? value.correct / value.produced : 1), recall: round(value.expected ? value.correct / value.expected : 1) }])),
    perCategory,
    calibration: proposals.length ? { proposals: proposals.length, brier: round(brier!), ece: round(ece!), riskCoverage } : null,
    latencyMs: { p50: percentile(walls, 0.5), p95: percentile(walls, 0.95), casesWithCalls: walls.length, providerCallsPerCase: round(callCounts.reduce((sum, value) => sum + value, 0) / Math.max(1, callCounts.length), 2), note: 'serial provider time per case measured from this workstation (Pakistan) to OpenRouter when the response was first fetched; cached replays reuse that measurement. Not deployment-region latency.' },
    costMicros: results.reduce((sum, result) => sum + result.costMicros, 0),
    perCase,
  }
}

/** Error-cost objective used for threshold selection on dev only. */
function objective(metrics: ReturnType<typeof score>): number {
  return 5 * metrics.falseAccepted + 5 * metrics.forbiddenHits + metrics.missed + 0.25 * metrics.spuriousCandidates + 0.1 * metrics.escalations
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

interface Arms { [name: string]: MemoryExtractor | { blocked: string } }

function buildArms(thresholds: ClassifierThresholds): { arms: Arms; substitute: MemoryClassifier | null; jev: MemoryClassifier | null } {
  const arms: Arms = { rules: RULE_EXTRACTOR }
  if (!phase) return { arms, substitute: null, jev: null }
  const fetcher = cachedFetch()
  const apiKey = openRouterKey()
  const model = createModelExtractor({ apiKey, model: AUTHORIZED_MODEL, fetch: fetcher })
  const substitute = createSubstituteClassifier({ apiKey, model: AUTHORIZED_MODEL, fetch: fetcher })
  arms.model = model
  arms.model_verify_substitute = createClassifiedExtractor({ base: model, classifier: substitute, mode: 'verify', thresholds, classifierTimeoutMs: 30_000 })
  arms.gate_substitute_model = createClassifiedExtractor({ base: model, classifier: substitute, mode: 'gate', thresholds, classifierTimeoutMs: 30_000 })
  arms.rules_verify_substitute = createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier: substitute, mode: 'verify', thresholds, classifierTimeoutMs: 30_000 })
  const typesafeKey = process.env.TYPESAFE_API_KEY?.trim()
  let jev: MemoryClassifier | null = null
  if (typesafeKey) {
    jev = createTypeSafeClassifier({ apiKey: typesafeKey, fetch: fetcher })
    arms.model_verify_jev = createClassifiedExtractor({ base: model, classifier: jev, mode: 'verify', thresholds })
    arms.gate_jev_model = createClassifiedExtractor({ base: model, classifier: jev, mode: 'gate', thresholds })
    arms.rules_verify_jev = createClassifiedExtractor({ base: RULE_EXTRACTOR, classifier: jev, mode: 'verify', thresholds })
  } else {
    const blocked = { blocked: 'TYPESAFE_API_KEY is not configured; no Jev call was made' }
    arms.model_verify_jev = blocked
    arms.gate_jev_model = blocked
    arms.rules_verify_jev = blocked
  }
  return { arms, substitute, jev }
}

async function evaluateArms(dataset: Dataset, thresholds: ClassifierThresholds) {
  const { arms, substitute } = buildArms(thresholds)
  const report: Record<string, unknown> = {}
  for (const [name, arm] of Object.entries(arms)) {
    if ('blocked' in arm) {
      report[name] = { status: 'BLOCKED', reason: arm.blocked }
      continue
    }
    const results = await pool(dataset.cases, 4, (item) => runCase(arm, item))
    report[name] = { status: 'MEASURED', extractor: { id: arm.id, model: arm.model, placement: arm.placement }, ...score(dataset.cases, results) }
  }
  let activity: Record<string, unknown> | null = null
  if (substitute) {
    const outcomes = await pool(dataset.activityCases, 4, async (item) => {
      const result = await substitute.classify({ state: { user_turn: item.text }, questions: activityQuestions() }, AbortSignal.timeout(30_000))
      const answer = result.ok && result.answers.activity?.type === 'choice' ? result.answers.activity : null
      return { item, result, label: activityVerdict(result, thresholds), raw: answer?.choice ?? null, confidence: answer?.confidence ?? null }
    })
    activity = { ...activityScore(outcomes), baselineRules: { coverage: 0, note: 'the app sends activity.kind = null; no rule interpreter exists' } }
  }
  return { report, activity }
}

function activityScore(outcomes: { item: ActivityCase; label: string | null; raw: string | null; confidence: number | null; result: { ok: boolean } }[]) {
  const labeled = outcomes.filter((outcome) => outcome.item.activity !== null)
  const covered = outcomes.filter((outcome) => outcome.label !== null)
  const correct = covered.filter((outcome) => outcome.label === outcome.item.activity)
  const wrongOnUnknown = covered.filter((outcome) => outcome.item.activity === null)
  return {
    cases: outcomes.length,
    coverage: round(covered.length / outcomes.length),
    selectiveAccuracy: round(covered.length ? correct.length / covered.length : 1),
    recallOfLabeled: round(labeled.length ? correct.length / labeled.length : 1),
    labelledUnknownAsTask: wrongOnUnknown.length,
    rawArgmaxAccuracy: round(labeled.filter((outcome) => outcome.raw === outcome.item.activity).length / Math.max(1, labeled.length)),
    failures: outcomes.filter((outcome) => !outcome.result.ok).length,
  }
}

async function selectThresholds(dataset: Dataset) {
  const grid: ClassifierThresholds[] = []
  for (const keepClaimMin of [0.6, 0.7, 0.8, 0.9]) for (const rejectClaimMax of [0.1, 0.2, 0.3]) for (const minChoiceConfidence of [0.2, 0.35, 0.5]) {
    grid.push({ ...DEFAULT_CLASSIFIER_THRESHOLDS, keepClaimMin, rejectClaimMax, minChoiceConfidence })
  }
  const fetcher = cachedFetch()
  const apiKey = openRouterKey()
  const model = createModelExtractor({ apiKey, model: AUTHORIZED_MODEL, fetch: fetcher })
  const substitute = createSubstituteClassifier({ apiKey, model: AUTHORIZED_MODEL, fetch: fetcher })
  const evaluated: { thresholds: ClassifierThresholds; objective: number }[] = []
  for (const thresholds of grid) {
    let total = 0
    for (const base of [model, RULE_EXTRACTOR]) {
      const extractor = createClassifiedExtractor({ base, classifier: substitute, mode: 'verify', thresholds, classifierTimeoutMs: 30_000 })
      total += objective(score(dataset.cases, await pool(dataset.cases, 4, (item) => runCase(extractor, item))))
    }
    evaluated.push({ thresholds, objective: round(total) })
  }
  evaluated.sort((left, right) => left.objective - right.objective || right.thresholds.keepClaimMin - left.thresholds.keepClaimMin)
  const best = evaluated[0]!.thresholds
  // Gate threshold: the largest skip bound that never skips a dev case with expected items.
  const gateProbabilities: { expected: number; probability: number | null }[] = []
  const gate = createClassifiedExtractor({ base: model, classifier: substitute, mode: 'gate', thresholds: { ...best, gateSkipMax: 0 }, classifierTimeoutMs: 30_000 })
  for (const result of await pool(dataset.cases, 4, (item) => runCase(gate, item).then((outcome) => ({ outcome, item })))) {
    gateProbabilities.push({ expected: result.item.expected.length, probability: result.outcome.trace?.gate?.probability ?? null })
  }
  const positives = gateProbabilities.filter((entry) => entry.expected > 0 && entry.probability !== null).map((entry) => entry.probability!)
  const gateSkipMax = round(Math.max(0, Math.min(0.3, (positives.length ? Math.min(...positives) : 0.3) - 0.05)), 2)
  return { chosen: { ...best, gateSkipMax }, grid: evaluated.slice(0, 10), gateEvidence: { minPositiveGateProbability: positives.length ? round(Math.min(...positives)) : null } }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it('keeps dev and held-out splits disjoint by trajectory and text', () => {
  const dev = loadSplit('dev')
  const heldout = loadSplit('heldout')
  const trajectories = new Set([...dev.cases, ...dev.activityCases].map((item) => item.trajectory))
  for (const item of [...heldout.cases, ...heldout.activityCases]) expect(trajectories.has(item.trajectory), item.id).toBe(false)
  const texts = new Set([...dev.cases, ...dev.activityCases].map((item) => normalize(item.text)))
  for (const item of [...heldout.cases, ...heldout.activityCases]) expect(texts.has(normalize(item.text)), item.id).toBe(false)
  const ids = [...dev.cases, ...heldout.cases].map((item) => item.id)
  expect(new Set(ids).size).toBe(ids.length)
  const required = ['speech_correction', 'change', 'temporary', 'negation', 'entity_ambiguity', 'quoted', 'joke', 'asr_noise', 'hypothetical']
  for (const category of required) expect(heldout.cases.some((item) => item.category === category), category).toBe(true)
  expect(new Set(heldout.cases.map((item) => item.language))).toEqual(new Set(['en', 'roman_urdu', 'urdu', 'code_switch']))
})

it('scores the offline rules arm with no provider calls', async () => {
  const dev = loadSplit('dev')
  const metrics = score(dev.cases, await pool(dev.cases, 4, (item) => runCase(RULE_EXTRACTOR, item)))
  // A measurement, not a quality gate: the new dev cases include sarcasm the rules cannot see.
  const falseAccepts = metrics.perCase.filter((entry) => (entry.outcome as string[]).some((outcome) => outcome.startsWith('false_accept')))
  console.log(`[stage 11 eval] rules dev: recall=${metrics.recall} acceptedPrecision=${metrics.acceptedPrecision} falseAccepted=${metrics.falseAccepted} (${falseAccepts.map((entry) => entry.id).join(', ')})`)
  expect(metrics.cases).toBe(dev.cases.length)
  expect(spend.calls).toBe(0)
})

it.skipIf(!phase)('runs the matched comparison for the selected phase within the spend cap', async () => {
  const runtime = { node: process.version, platform: platform(), arch: arch() }
  const hashes = { dev: fileHash('scripts/fixtures/memory-classifier-dev.json'), stage10Dev: fileHash('scripts/fixtures/memory-extraction-dev.json'), heldout: fileHash('scripts/fixtures/memory-classifier-heldout.json') }
  try {
    if (phase === 'dev') {
      const dataset = loadSplit('dev')
      const selection = await selectThresholds(dataset)
      const frozen = { schemaVersion: 1, frozenAt: new Date().toISOString(), selectedOn: 'dev', objective: '5*falseAccepted + 5*forbiddenHits + missed + 0.25*spuriousCandidates + 0.1*escalations (verify arms, model + rules bases)', classifier: { provider: 'llm_substitute', model: AUTHORIZED_MODEL }, thresholds: selection.chosen, hashes }
      writeFileSync(THRESHOLDS_PATH, `${JSON.stringify(frozen, null, 2)}\n`)
      const { report, activity } = await evaluateArms(dataset, selection.chosen)
      const out = { schemaVersion: 1, generatedAt: new Date().toISOString(), phase, scope: 'Development split used for threshold selection. Not a held-out result.', runtime, spend: { ...spend, usd: round(spend.usd, 6), capUsd: SPEND_CAP_USD }, thresholds: selection, arms: report, activity }
      writeFileSync(resolve(root, 'docs/memory/reports/stage-11-dev.json'), `${JSON.stringify(out, null, 2)}\n`)
    } else {
      const frozen = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8')) as { thresholds: ClassifierThresholds; hashes: typeof hashes; frozenAt: string }
      // Held-out data must be unchanged since thresholds were frozen.
      expect(frozen.hashes.heldout).toBe(hashes.heldout)
      const dataset = loadSplit('heldout')
      const { report, activity } = await evaluateArms(dataset, frozen.thresholds)
      const out = { schemaVersion: 1, generatedAt: new Date().toISOString(), phase, scope: 'Held-out split, evaluated once with thresholds frozen on dev. Same author as dev; not an independent benchmark.', runtime, spend: { ...spend, usd: round(spend.usd, 6), capUsd: SPEND_CAP_USD }, thresholds: frozen, arms: report, activity }
      writeFileSync(resolve(root, 'docs/memory/reports/stage-11-heldout.json'), `${JSON.stringify(out, null, 2)}\n`)
    }
  } finally {
    saveCache()
    console.log(`[stage 11 eval] phase=${phase} live=${live} providerCalls=${spend.calls} cacheHits=${spend.cacheHits} spendUsd=${spend.usd.toFixed(6)} model=${DEFAULT_SUBSTITUTE_CLASSIFIER_MODEL}`)
  }
  expect(spend.usd).toBeLessThan(SPEND_CAP_USD + 0.02)
}, 30 * 60_000)
