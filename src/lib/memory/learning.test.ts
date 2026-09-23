import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROMOTION_POLICY,
  decideCandidate,
  diffShadowExtraction,
  evaluatePromotion,
  screenWindow,
  validateExtractorOutput,
  type ExistingMemory,
  type ExtractionCandidate,
  type ExtractionWindow,
} from './learning'
import { extractWithRules, splitClauses } from './rule-extractor'
import { containsSecretLikeMaterial, sensitiveCategories } from './screening'

function window(text: string, extra: Partial<ExtractionWindow> = {}): ExtractionWindow {
  return {
    schemaVersion: 1, scopeId: 'user/learning', eventId: 'event/learning/1', conversationId: 'conversation/1',
    sourceRevision: 'revision/source/1', receivedAt: '2026-09-23T10:00:00.000Z', text, priorTurns: [], ...extra,
  }
}

function decide(text: string, existing: ExistingMemory[] = []) {
  const extracted = extractWithRules(window(text))
  const validated = validateExtractorOutput(window(text), extracted)
  expect(validated.rejected).toEqual([])
  return validated.candidates.map((candidate) => decideCandidate(candidate, existing, { activeTopicKnown: false }))
}

function memory(overrides: Partial<ExistingMemory>): ExistingMemory {
  return {
    assertionId: 'assertion/existing', revision: 1, kind: 'preference', text: 'The user likes tea.', polarity: 'positive',
    status: 'accepted', basis: 'explicit_user_statement', conditions: [], ...overrides,
  }
}

describe('Stage 10 rule extractor and speech acts', () => {
  it('learns a plain first-person preference and cites the exact clause', () => {
    const [decision] = decide('I really like green tea in the morning.')
    expect(decision).toMatchObject({ action: 'add', status: 'accepted', basis: 'explicit_user_statement' })
    if (decision?.action === 'add') expect(decision.candidate.evidence.quote).toBe('I really like green tea in the morning')
  })

  it('C11: a colleague quote is never attributed to the user', () => {
    const decisions = decide('My colleague said "I hate working remotely".')
    expect(decisions.every((decision) => decision.action === 'reject' && decision.reason === 'not_users_claim')).toBe(true)
    expect(decide('My manager hates working remotely.').every((decision) => decision.action === 'reject')).toBe(true)
  })

  it('C12: a hypothetical move is not a residence', () => {
    expect(decide('Imagine I live in Tokyo next year.')).toEqual([expect.objectContaining({ action: 'reject', reason: 'hypothetical' })])
    expect(decide('Farz karo main Tokyo mein rehta hoon.')).toEqual([expect.objectContaining({ action: 'reject', reason: 'hypothetical' })])
  })

  it('refuses jokes, questions and repeating the assistant', () => {
    expect(decide('I love Mondays, just kidding.')[0]).toMatchObject({ action: 'reject', reason: 'joke' })
    expect(decide('Do you think I like jazz?')[0]).toMatchObject({ action: 'reject', reason: 'question' })
    expect(decide('As you said, I prefer aisle seats.')[0]).toMatchObject({ action: 'reject', reason: 'assistant_suggestion' })
  })

  it('C28: keeps a project-local formal exception local and the general casual default general (Roman Urdu)', () => {
    const text = 'Is project ke liye formal tone, baqi casual hi theek hai'
    expect(splitClauses(text).map((clause) => clause.text)).toEqual(['Is project ke liye formal tone', 'baqi casual hi theek hai'])
    const decisions = decide(text)
    expect(decisions).toHaveLength(2)
    expect(decisions[0]).toMatchObject({ action: 'add', status: 'candidate', basis: 'inference', candidate: { scope: 'local', conditions: [{ key: 'scope', value: 'current_task' }] } })
    expect(decisions[1]).toMatchObject({ action: 'add', status: 'accepted', candidate: { scope: 'general', conditions: [] } })
  })

  it('C08: keeps the stated rejection reason verbatim, never a brand-wide dislike', () => {
    const [decision] = decide('I rejected Laptop A because the fan was too noisy, price was fine.')
    expect(decision).toMatchObject({ action: 'add', candidate: { kind: 'decision' } })
    if (decision?.action === 'add') {
      expect(decision.candidate.text).toContain('fan was too noisy')
      expect(decision.candidate.text).not.toMatch(/brand|budget/iu)
    }
  })

  it('reads English and Roman Urdu negation as negative polarity', () => {
    expect(decide("I don't like spicy food.")[0]).toMatchObject({ action: 'add', candidate: { polarity: 'negative' } })
    expect(decide('Mujhe biryani pasand nahi hai.')[0]).toMatchObject({ action: 'add', candidate: { polarity: 'negative' } })
    expect(decide('Mujhe chai bohat pasand hai.')[0]).toMatchObject({ action: 'add', candidate: { polarity: 'positive' } })
  })

  it('never learns special-category topics implicitly', () => {
    expect(decide('I am a diabetic and I love sweets.').some((decision) => decision.action === 'reject' && decision.reason === 'sensitive_category')).toBe(true)
    expect(sensitiveCategories('I vote for PTI')).toContain('politics')
  })

  it('C03: after a spoken self-repair only the repaired words count, and a task marker alone is not an instruction', () => {
    expect(decide('I use Java, sorry, I mean Jev for this project.')).toEqual([])
    const [repaired] = decide('I like Java, sorry, I mean I like Jev.')
    expect(repaired).toMatchObject({ action: 'add', candidate: { evidence: { quote: 'I like Jev' } } })
    if (repaired?.action === 'add') expect(repaired.candidate.text).not.toContain('Java')
  })

  it('holds a stated change for review instead of adding a second current fact', () => {
    expect(decide('I moved to Karachi last month.')[0]).toMatchObject({ action: 'add', status: 'candidate', reason: 'change_requires_review' })
  })

  it('screens secrets before any extractor runs, including prior turns', () => {
    expect(screenWindow(window('My password is hunter22'))).toEqual({ ok: false, reason: 'secret_like_material' })
    expect(screenWindow(window('I like tea', { priorTurns: [{ eventId: 'e0', text: 'card 4111 1111 1111 1111' }] }))).toEqual({ ok: false, reason: 'secret_like_material' })
    expect(containsSecretLikeMaterial('api_key=sk-abcdefghijklmnopqrstuvwx')).toBe(true)
    expect(screenWindow(window('I like tea'))).toEqual({ ok: true })
  })

  it('never learns from a turn that asks to forget or not remember something', () => {
    for (const text of ['Forget that I like tea.', "Please don't remember that I live in Lahore.", 'Delete that memory about my job, I work at a bank.', 'Yeh bhool jao ke mujhe chai pasand hai.', 'Yaad mat rakho ke main Lahore mein rehta hoon.']) {
      expect(screenWindow(window(text))).toEqual({ ok: false, reason: 'memory_withdrawal' })
    }
    expect(screenWindow(window('Remember that I like tea.'))).toEqual({ ok: true })
    expect(screenWindow(window("I can't forget how good that trip was, I love Hunza."))).toEqual({ ok: false, reason: 'memory_withdrawal' })
  })
})

describe('Stage 10 extractor output validation', () => {
  const base = { kind: 'preference', text: 'User said: I like tea', speechAct: 'self_statement', polarity: 'positive', scope: 'general', conditions: [], relation: 'ordinary', operation: 'add', targetAssertionId: null }

  it('drops a candidate whose quote is not literally at its offsets', () => {
    const result = validateExtractorOutput(window('I like tea'), { candidates: [{ ...base, evidence: { start: 0, end: 10, quote: 'I love tea' } }] })
    expect(result.candidates).toEqual([])
    expect(result.rejected).toEqual([{ index: 0, reason: 'evidence_mismatch' }])
  })

  it('rejects unknown enums, bad conditions, oversized output and timeless exceptions', () => {
    const w = window('I like tea')
    const evidence = { start: 0, end: 10, quote: 'I like tea' }
    expect(validateExtractorOutput(w, { candidates: [{ ...base, evidence, kind: 'belief' }] }).rejected[0]?.reason).toBe('invalid_shape')
    expect(validateExtractorOutput(w, { candidates: [{ ...base, evidence, conditions: [{ key: '1bad', operator: 'equals', value: 'x' }] }] }).rejected[0]?.reason).toBe('invalid_condition')
    expect(validateExtractorOutput(w, { candidates: [{ ...base, evidence, relation: 'temporary_exception' }] }).rejected[0]?.reason).toBe('invalid_shape')
    expect(validateExtractorOutput(w, { candidates: Array.from({ length: 9 }, () => ({ ...base, evidence })) }).rejected).toEqual([{ index: 8, reason: 'too_many_candidates' }])
    expect(validateExtractorOutput(w, 'not json').rejected[0]?.reason).toBe('invalid_shape')
  })
})

describe('Stage 10 reconciliation', () => {
  it('C21: a restatement corroborates the existing memory instead of duplicating it', () => {
    const [decision] = decide('I like tea.', [memory({ text: 'The user likes tea.' })])
    expect(decision).toMatchObject({ action: 'corroborate', target: { assertionId: 'assertion/existing' } })
  })

  it('opposite polarity becomes a dispute, never an overwrite', () => {
    const [decision] = decide("I don't like tea anymore really.", [memory({ text: 'The user likes tea.' })])
    expect(decision).toMatchObject({ action: 'add', reason: 'change_requires_review' })
    const [plain] = decide('I hate tea.', [memory({ text: 'The user likes tea.' })])
    expect(plain).toMatchObject({ action: 'dispute', reason: 'contradicts_existing' })
  })

  it('C32: a proposed correction of a user-authored memory is downgraded to a dispute', () => {
    const candidate: ExtractionCandidate = {
      kind: 'fact', text: 'User said: I use Java', speechAct: 'self_statement', polarity: 'positive', scope: 'general', conditions: [],
      relation: 'ordinary', validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null },
      evidence: { start: 0, end: 10, quote: 'I use Java' }, operation: 'correct', targetAssertionId: 'assertion/jev',
    }
    const protectedTarget = memory({ assertionId: 'assertion/jev', basis: 'user_correction', text: 'The user uses Jev.', kind: 'fact' })
    expect(decideCandidate(candidate, [protectedTarget], { activeTopicKnown: false })).toMatchObject({ action: 'dispute', reason: 'user_authored_target_protected' })
    expect(decideCandidate({ ...candidate, targetAssertionId: 'assertion/elsewhere' }, [protectedTarget], { activeTopicKnown: false })).toMatchObject({ action: 'reject', reason: 'target_not_found' })
  })

  it('a local instruction with nothing to scope it to is refused rather than globalised', () => {
    const candidate: ExtractionCandidate = {
      kind: 'preference', text: 'User said: keep it short', speechAct: 'self_statement', polarity: 'positive', scope: 'local', conditions: [],
      relation: 'ordinary', validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null },
      evidence: { start: 0, end: 13, quote: 'keep it short' }, operation: 'add', targetAssertionId: null,
    }
    expect(decideCandidate(candidate, [], { activeTopicKnown: false })).toMatchObject({ action: 'reject', reason: 'local_scope_without_topic' })
  })
})

describe('Stage 10 promotion policy', () => {
  const support = (conversationId: string, day: string, relation: 'supports' | 'contradicts' = 'supports', sourceKind = 'user_statement') => ({ conversationId, receivedAt: `2026-09-${day}T10:00:00.000Z`, relation, sourceKind })

  it('C13: repeated turns in one conversation are one piece of evidence', () => {
    const verdict = evaluatePromotion('keep it short', [support('c1', '20'), support('c1', '20'), support('c1', '21')])
    expect(verdict).toMatchObject({ promote: false, reason: 'insufficient_independent_support', independentConversations: 1 })
  })

  it('C31: generated summaries and assistant copies do not count as user evidence', () => {
    const verdict = evaluatePromotion('keep it short', [support('c1', '20'), support('c2', '21', 'supports', 'assistant_generated'), support('c3', '22', 'supports', 'imported_legacy')])
    expect(verdict).toMatchObject({ promote: false, independentConversations: 1 })
  })

  it('promotes only with independent conversations over several days and no counterevidence', () => {
    expect(evaluatePromotion('keep it short', [support('c1', '20'), support('c2', '20'), support('c3', '20')])).toMatchObject({ promote: false, reason: 'insufficient_time_spread' })
    expect(evaluatePromotion('keep it short', [support('c1', '20'), support('c2', '21'), support('c3', '22')])).toMatchObject({ promote: true, independentConversations: 3 })
    expect(evaluatePromotion('keep it short', [support('c1', '20'), support('c2', '21'), support('c3', '22'), support('c4', '23', 'contradicts')])).toMatchObject({ promote: false, reason: 'counterevidence' })
    expect(evaluatePromotion('my therapist says keep it short', [support('c1', '20'), support('c2', '21'), support('c3', '22')])).toMatchObject({ promote: false, reason: 'sensitive_category' })
    expect(DEFAULT_PROMOTION_POLICY.minIndependentConversations).toBe(3)
  })
})

describe('Stage 10 shadow re-extraction diff', () => {
  it('C32: reports differences without rewriting, and protects user-authored memory', () => {
    const [candidate] = extractWithRules(window("I don't like tea.")).candidates
    const [added] = extractWithRules(window('I love jazz.', { eventId: 'event/2' })).candidates
    const diff = diffShadowExtraction(
      [
        { assertionId: 'assertion/tea', text: 'User said: I like tea', polarity: 'positive', basis: 'user_correction', producer: 'explicit-command', eventId: 'event/learning/1' },
        { assertionId: 'assertion/old', text: 'User said: I enjoy chess', polarity: 'positive', basis: 'explicit_user_statement', producer: 'gideon-rules', eventId: 'event/3' },
      ],
      [{ eventId: 'event/learning/1', candidate: candidate! }, { eventId: 'event/2', candidate: added! }],
      { from: 'gideon-rules', to: 'gideon-rules-next' },
    )
    expect(diff.preservedUserEdits).toEqual([{ assertionId: 'assertion/tea', eventId: 'event/learning/1' }])
    expect(diff.added).toEqual([{ eventId: 'event/2', text: 'User said: I love jazz' }])
    expect(diff.missing).toEqual([{ assertionId: 'assertion/old', eventId: 'event/3', text: 'User said: I enjoy chess' }])
    expect(diff.polarityChanged).toEqual([])
  })
})
