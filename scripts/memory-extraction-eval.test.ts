import { readFileSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  DEFAULT_PROMOTION_POLICY,
  decideCandidate,
  screenWindow,
  validateExtractorOutput,
  type ExtractionWindow,
  type LearningDecision,
  type MemoryExtractor,
} from '../src/lib/memory/learning'
import { RULE_EXTRACTOR } from '../src/lib/memory/rule-extractor'

/**
 * Stage 10 extraction evaluation over the hand-authored development set.
 * Runs the same screen → extract → validate → reconcile path the worker uses,
 * with the local rule extractor only: no network, no model, no user data.
 * The model extractor is not evaluated here; doing so needs authorized spend.
 */

interface Expected { kind: string; polarity: string; scope: string; status: string }
interface Case { id: string; language: string; category: string; text: string; expected: Expected[] }

const REFUSAL_CATEGORIES = new Set(['quoted', 'hypothetical', 'joke', 'question', 'assistant_suggestion', 'sensitive', 'secret', 'no_claim', 'speech_correction', 'memory_withdrawal'])
const root = resolve(import.meta.dirname, '..')
const dataset = JSON.parse(readFileSync(resolve(root, 'scripts/fixtures/memory-extraction-dev.json'), 'utf8')) as { cases: Case[] }

type Learned = { kind: string; polarity: string; scope: string; status: string }

async function learn(extractor: MemoryExtractor, item: Case): Promise<{ learned: Learned[]; screened: boolean; units: number; costMicros: number }> {
  const window: ExtractionWindow = {
    schemaVersion: 1, scopeId: 'user/eval', eventId: `event/eval/${item.id}`, conversationId: 'conversation/eval',
    sourceRevision: 'revision/source/eval', receivedAt: '2026-09-23T10:00:00.000Z', text: item.text, priorTurns: [],
  }
  if (!screenWindow(window).ok) return { learned: [], screened: true, units: 0, costMicros: 0 }
  const { output, usage } = await extractor.extract(window, new AbortController().signal)
  const validated = validateExtractorOutput(window, output)
  const learned: Learned[] = []
  for (const candidate of validated.candidates) {
    const decision: LearningDecision = decideCandidate(candidate, [], { activeTopicKnown: false, sourceText: item.text })
    if (decision.action === 'add') learned.push({ kind: decision.candidate.kind, polarity: decision.candidate.polarity, scope: decision.candidate.scope, status: decision.status })
  }
  return { learned, screened: false, units: usage.inputUnits + usage.outputUnits, costMicros: usage.costMicros }
}

function key(item: Learned): string {
  return `${item.kind}|${item.polarity}|${item.scope}|${item.status}`
}

it('evaluates conservative extraction on the development set and records the report', async () => {
  const perCase: Record<string, unknown>[] = []
  let produced = 0
  let correct = 0
  let expectedTotal = 0
  let missed = 0
  let wrongScope = 0
  let wrongPolarity = 0
  let wrongStatus = 0
  let falseMemories = 0
  let units = 0
  let costMicros = 0
  const byLanguage: Record<string, { expected: number; correct: number; produced: number }> = {}
  const timings: number[] = []

  for (const item of dataset.cases) {
    const started = performance.now()
    const result = await learn(RULE_EXTRACTOR, item)
    timings.push(performance.now() - started)
    units += result.units
    costMicros += result.costMicros
    const remaining = [...item.expected]
    const extras: Learned[] = []
    let caseCorrect = 0
    for (const learned of result.learned) {
      const exact = remaining.findIndex((expected) => key(expected) === key(learned))
      if (exact >= 0) {
        remaining.splice(exact, 1)
        caseCorrect += 1
        continue
      }
      const sameKind = remaining.findIndex((expected) => expected.kind === learned.kind)
      if (sameKind >= 0) {
        const expected = remaining.splice(sameKind, 1)[0]!
        if (expected.scope !== learned.scope) wrongScope += 1
        if (expected.polarity !== learned.polarity) wrongPolarity += 1
        if (expected.status !== learned.status) wrongStatus += 1
        continue
      }
      extras.push(learned)
    }
    if (REFUSAL_CATEGORIES.has(item.category)) falseMemories += result.learned.length
    produced += result.learned.length
    correct += caseCorrect
    expectedTotal += item.expected.length
    missed += remaining.length
    const language = byLanguage[item.language] ??= { expected: 0, correct: 0, produced: 0 }
    language.expected += item.expected.length
    language.correct += caseCorrect
    language.produced += result.learned.length
    perCase.push({ id: item.id, language: item.language, category: item.category, expected: item.expected.length, produced: result.learned.length, correct: caseCorrect, missed: remaining.length, unexpected: extras.length, screened: result.screened })
  }

  const sorted = [...timings].sort((left, right) => left - right)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'Stage 10 local extraction development evaluation. Hand-authored public cases, not a held-out benchmark or a production quality claim.',
    extractor: { id: RULE_EXTRACTOR.id, version: RULE_EXTRACTOR.version, promptVersion: RULE_EXTRACTOR.promptVersion, model: RULE_EXTRACTOR.model, placement: RULE_EXTRACTOR.placement },
    runtime: { node: process.version, platform: platform(), arch: arch() },
    cases: dataset.cases.length,
    metrics: {
      produced,
      correct,
      expected: expectedTotal,
      precision: produced ? Number((correct / produced).toFixed(3)) : null,
      recall: expectedTotal ? Number((correct / expectedTotal).toFixed(3)) : null,
      missedUsefulItems: missed,
      wrongScope,
      wrongPolarity,
      wrongStatus,
      timeErrors: 'not_measured_rules_emit_unknown_valid_time',
      falseMemoriesFromRefusalCategories: falseMemories,
    },
    byLanguage,
    cost: { providerCalls: 0, units, costMicros, medianCaseMs: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(3)) },
    promotionPolicy: DEFAULT_PROMOTION_POLICY,
    perCase,
    notEvaluated: [
      'model extractor quality (requires authorized paid provider runs)',
      'held-out trajectories (Stage 13)',
      'multi-turn reference resolution beyond three prior committed turns',
    ],
  }
  writeFileSync(resolve(root, 'docs/memory/reports/stage-10-extraction-eval.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[stage-10 eval] precision=${report.metrics.precision} recall=${report.metrics.recall} missed=${missed} falseMemories=${falseMemories} wrongScope=${wrongScope} wrongPolarity=${wrongPolarity} wrongStatus=${wrongStatus}`)

  // Hard gate: nothing may be learned from quotes, hypotheticals, jokes,
  // questions, assistant echoes, sensitive topics, secrets, non-claims or
  // requests to forget.
  expect(falseMemories).toBe(0)
  expect(wrongPolarity).toBe(0)
})
