import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTROLLED_READER_SYSTEM,
  contextCoverage,
  deterministicPass,
  judgeMessages,
  judgePass,
  mean,
  pairedBootstrap,
  parseJudge,
  readerMessages,
  scoreText,
  timeline,
  type Trajectory,
} from './lib/memory-eval'

const root = resolve(import.meta.dirname, '..')
const load = (name: string) => JSON.parse(readFileSync(resolve(root, 'scripts/fixtures', name), 'utf8')) as { trajectories: Trajectory[] }

describe('Stage 13 evaluation arithmetic (hand-calculated fixtures)', () => {
  it('scores required groups, forbidden terms and abstention exactly', () => {
    const rubric = { mustInclude: [['November 3', 'Nov 3'], ['Hira']], mustNotInclude: ['graduated'] }
    expect(deterministicPass(scoreText("Hira's birthday is Nov 3.", rubric), rubric)).toBe(true)
    expect(deterministicPass(scoreText('It is on Nov 3.', rubric), rubric)).toBe(false)
    expect(deterministicPass(scoreText("Hira's birthday is Nov 3, and you graduated in 2019.", rubric), rubric)).toBe(false)
    const abstain = { mustInclude: [], mustNotInclude: ['Iron Temple'], expectAbstain: true }
    expect(deterministicPass(scoreText("I don't know which gym you go to.", abstain), abstain)).toBe(true)
    expect(deterministicPass(scoreText('You go to a gym downtown.', abstain), abstain)).toBe(false)
    // Typographic apostrophes and dashes, as models actually write them.
    expect(deterministicPass(scoreText('I don’t know your locker code—you haven’t told me.', abstain), abstain)).toBe(true)
    expect(scoreText('You’re vegetarian', { mustInclude: [["you're"]], mustNotInclude: [] }).groupHits).toEqual([true])
    expect(contextCoverage('- Hira birthday November 3', rubric)).toEqual({ evidenceHit: true, leak: false })
  })

  it('computes a paired cluster bootstrap whose centre is the hand-calculated difference', () => {
    // System A passes 1 of 4 queries, system B passes 3 of 4: difference 0.5.
    const clusters = [{ a: [0, 0], b: [1, 1] }, { a: [1, 0], b: [1, 0] }]
    const result = pairedBootstrap(clusters, { resamples: 2_000, seed: 1 })
    expect(result.difference).toBeCloseTo(0.5)
    expect(result.low).toBeGreaterThanOrEqual(0)
    expect(result.high).toBeLessThanOrEqual(1)
    expect(result.clusters).toBe(2)
    expect(result.queries).toBe(4)
    // Identical systems give an interval of exactly zero.
    expect(pairedBootstrap([{ a: [1, 0], b: [1, 0] }, { a: [0], b: [0] }], { resamples: 500 })).toMatchObject({ difference: 0, low: 0, high: 0 })
    expect(mean([1, 0, 1, 0])).toBe(0.5)
    expect(Number.isNaN(mean([]))).toBe(true)
  })

  it('parses judge verdicts strictly and requires abstention only when expected', () => {
    expect(parseJudge('not json')).toBeNull()
    expect(parseJudge({ satisfies_required: true })).toBeNull()
    const verdict = parseJudge(JSON.stringify({ satisfies_required: true, contains_forbidden: false, false_personal_claim: false, unnecessary_personalization: false, appropriate_abstention: null }))!
    expect(judgePass(verdict, { mustInclude: [], mustNotInclude: [] })).toBe(true)
    expect(judgePass(verdict, { mustInclude: [], mustNotInclude: [], expectAbstain: true })).toBe(false)
  })
})

describe('Stage 13 evaluation hygiene', () => {
  it('orders history before a query and never lets a later session precede it (time leakage)', () => {
    const trajectory: Trajectory = {
      id: 't', language: 'en',
      sessions: [{ at: '2026-09-01T00:00:00Z', turns: [] }, { at: '2026-09-05T00:00:00Z', turns: [] }],
      queries: [{ id: 'q', at: '2026-09-03T00:00:00Z', category: 'cutoff', text: '?', rubric: { mustInclude: [], mustNotInclude: [] }, evidence: [] }],
    }
    expect(timeline(trajectory).map((item) => item.type === 'session' ? `s${item.index}` : 'q')).toEqual(['s0', 'q', 's1'])
    const tie: Trajectory = { ...trajectory, queries: [{ ...trajectory.queries[0]!, at: '2026-09-05T00:00:00Z' }] }
    expect(timeline(tie).map((item) => item.type)).toEqual(['session', 'session', 'query'])
  })

  it('keeps the rubric and gold evidence out of the reader prompt, and the arm out of the judge prompt', () => {
    const rubric = { mustInclude: [['SECRET-REQUIRED']], mustNotInclude: ['SECRET-FORBIDDEN'], judgeNote: 'SECRET-NOTE' }
    const reader = JSON.stringify(readerMessages(CONTROLLED_READER_SYSTEM, '- memory line', 'What do I like?'))
    expect(reader).not.toMatch(/SECRET/u)
    const judge = JSON.stringify(judgeMessages('What do I like?', rubric, ['gold'], 'answer'))
    expect(judge).toContain('SECRET-REQUIRED')
    expect(judge).not.toMatch(/legacy|full runtime|oracle|no memory|arm/iu)
  })

  it('keeps dev and held-out trajectories disjoint and the held-out set covers every language and key category', () => {
    const dev = load('memory-conversation-dev.json').trajectories
    const heldout = load('memory-conversation-heldout.json').trajectories
    const devIds = new Set(dev.map((trajectory) => trajectory.id))
    expect(heldout.some((trajectory) => devIds.has(trajectory.id))).toBe(false)
    const normalise = (text: string) => text.toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const devTexts = new Set(dev.flatMap((trajectory) => [...trajectory.queries.map((query) => normalise(query.text))]))
    for (const trajectory of heldout) for (const query of trajectory.queries) expect(devTexts.has(normalise(query.text)), query.text).toBe(false)
    expect(new Set(heldout.map((trajectory) => trajectory.language))).toEqual(new Set(['en', 'roman_urdu', 'code_switch', 'urdu']))
    const categories = new Set(heldout.flatMap((trajectory) => trajectory.queries.map((query) => query.category)))
    for (const category of ['constraint_adherence', 'temporal', 'correction', 'deletion', 'attribution', 'hypothetical', 'negative_personalization', 'abstention', 'resumption', 'cutoff', 'multilingual', 'scoped_preference']) {
      expect(categories.has(category), category).toBe(true)
    }
  })
})
