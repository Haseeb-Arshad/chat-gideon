import { describe, expect, it } from 'vitest'
import { createServerMemorySession } from '../../server/memory-session'
import { EphemeralMemoryStore } from '../tools/memory'
import type { ExactVersionRef } from './contracts'
import {
  buildRetrievalQueryPlan,
  composeContextPack,
  createRetrievalRequest,
  exactVectorSearch,
  rankLexicalDocuments,
  runBoundedDeepRecall,
  selectApplicableConstraints,
  type RetrievalCoverage,
  type RetrievalDocument,
  type RetrievalRequest,
  type RankedRetrievalCandidate,
} from './retrieval'

const session = createServerMemorySession({
  owner: 'user/retrieval-core-test',
  store: new EphemeralMemoryStore(),
  channel: 'test',
  authority: 'worker_auth_session',
})

function ref(assertionId: string, revision = 1): ExactVersionRef {
  return { assertionId: assertionId as ExactVersionRef['assertionId'], revision }
}

function baseInput(now = new Date()): Record<string, unknown> {
  return {
    query: 'What should I choose for this task?',
    resolved: { topicId: null, topicLabel: null, entities: [], assertionIds: [], artifactIds: [], unknownReferents: [] },
    activity: { kind: null, topicId: null, topicLabel: null, projectId: null, format: null, attributes: {} },
    requestedTime: { mode: 'current', instant: null, timeZone: 'Asia/Karachi' },
    consistency: 'authoritative',
    budget: { tier: 'standard', reserveAnswerTokens: 96, reserveToolTokens: 64 },
    deadlineAt: new Date(now.getTime() + 10_000).toISOString(),
  }
}

function makeRequest(patch: Record<string, unknown> = {}, now = new Date()): RetrievalRequest {
  const input = { ...baseInput(now), ...patch }
  const parsed = createRetrievalRequest(session, input, { now: now.toISOString() })
  if (!parsed.ok) throw new Error(parsed.failure.message)
  return parsed.request
}

function makeDocument(overrides: Partial<RetrievalDocument> = {}): RetrievalDocument {
  const reference = overrides.reference ?? ref('assertion/test/1')
  return {
    id: `assertion:${reference.assertionId}:${reference.revision}`,
    scopeId: session.scope.id,
    reference,
    sourceKind: 'assertion',
    kind: 'fact',
    text: 'The user prefers quiet rooms for work meetings.',
    status: 'accepted',
    polarity: 'positive',
    subjectId: session.subject.kind === 'known' ? session.subject.subjectId : null,
    topicId: null,
    topicLabel: null,
    projectId: null,
    artifactIds: [],
    slotId: null,
    conflictGroupId: null,
    conditions: [],
    exceptions: [],
    validFrom: null,
    validUntil: null,
    temporalRelation: 'ordinary',
    historical: false,
    interpretedAt: '2026-09-20T12:00:00.000Z',
    receivedAt: '2026-09-20T12:00:00.000Z',
    basis: 'explicit_user_statement',
    evidence: [{ eventId: 'event/test/1', relation: 'supports', sourceRef: 'source/test/1' }],
    sourceEventId: null,
    requiresCurrentVerification: false,
    ...overrides,
  }
}

function candidate(document: RetrievalDocument, score = 1): RankedRetrievalCandidate {
  return { document, fusedScore: score, branches: ['lexical'], reasons: ['test'] }
}

function coverage(request: RetrievalRequest, outcome: RetrievalCoverage['outcome'] = 'complete'): RetrievalCoverage {
  const branch = (status: 'complete' | 'not_configured' = 'complete') => ({ status, candidates: 0, reason: null })
  return {
    outcome,
    branches: { exact: branch(), warm: branch('not_configured'), lexical: branch(), semantic: branch('not_configured'), evidence: branch() },
    candidateCount: 0,
    filteredCandidateCount: 0,
    expansionEdges: 0,
    evidenceFetches: 0,
    noResultMeansAbsence: false,
    authority: { ...request.authenticatedContext, deletionEpoch: 1 },
    freshness: { state: 'authoritative', observedAt: request.createdAt, watermark: null },
  }
}

describe('Stage 08 retrieval request and query planning', () => {
  it('rejects client-supplied tenant/grant authority and unauthenticated sessions', () => {
    const parsed = createRetrievalRequest(session, { ...baseInput(), principalId: 'user/other' })
    expect(parsed).toMatchObject({ ok: false, failure: { code: 'validation' } })
    const ephemeral = createServerMemorySession({ owner: 'ephemeral/request', store: new EphemeralMemoryStore(), channel: 'test', authority: 'ephemeral_request' })
    expect(createRetrievalRequest(ephemeral, baseInput())).toMatchObject({ ok: false, failure: { code: 'unauthorized' } })
  })

  it('keeps unresolved referents unknown and rejects an invented exact identifier', () => {
    const valid = makeRequest({
      query: 'What about that project?',
      resolved: { topicId: null, topicLabel: null, entities: [], assertionIds: [], artifactIds: [], unknownReferents: ['the similarly named project'] },
    })
    expect(valid.resolved.assertionIds).toEqual([])
    expect(valid.resolved.unknownReferents).toEqual(['the similarly named project'])
    const invalid = createRetrievalRequest(session, {
      ...baseInput(),
      resolved: { topicId: null, topicLabel: null, entities: [{ label: 'guessed project' }], assertionIds: [], artifactIds: [], unknownReferents: [] },
    })
    expect(invalid).toMatchObject({ ok: false, failure: { code: 'validation' } })
  })

  it('builds terms from resolved request plus the smallest relevant committed span (Roman Urdu/code switching)', () => {
    const request = makeRequest({
      query: 'Is project ke liye formal tone nahi; baqi casual hi theek hai',
      resolved: { topicId: 'topic/trip-a', topicLabel: 'Northern trip', entities: [{ id: 'entity/lahore', label: 'Lahore' }], assertionIds: [], artifactIds: [], unknownReferents: ['another trip'] },
      activity: { kind: 'project-planning', topicId: 'topic/trip-a', topicLabel: 'Northern trip', projectId: 'project/a', format: 'memo', attributes: { occupation: 'founder' } },
      recentSpan: [
        { role: 'user', text: 'Same project ke liye no loud venues.', topicId: 'topic/trip-a', sequence: 4, committed: true, relevance: 'resolved_referent' },
        { role: 'assistant', text: 'Unrelated family detail.', topicId: 'topic/other', sequence: 5, committed: true, relevance: 'active_topic' },
        { role: 'user', text: 'Keep it accessible.', topicId: 'topic/trip-a', sequence: 6, committed: true, relevance: 'active_topic' },
      ],
    })
    const plan = buildRetrievalQueryPlan(request)
    expect(plan.terms).toContain('nahi')
    expect(plan.terms).toContain('formal')
    expect(plan.terms).toContain('lahore')
    expect(plan.terms).toContain('accessible')
    expect(plan.terms).not.toContain('family')
    expect(plan.terms).not.toContain('founder')
    expect(plan.terms).not.toContain('another')
    expect(plan.includedRecentSequences).toEqual([4, 6])
    expect(plan.omittedUnknownReferents).toBe(1)
  })

  it('removes common English filler but retains English and Roman Urdu negation', () => {
    const request = makeRequest({ query: 'This is not formal, nahi; keep it casual.' })
    const terms = buildRetrievalQueryPlan(request).terms
    expect(terms).toContain('not')
    expect(terms).toContain('nahi')
    expect(terms).toContain('formal')
    expect(terms).not.toContain('this')
    expect(terms).not.toContain('is')
    expect(terms).not.toContain('it')
  })
})

describe('Stage 08 lexical, vector, and constraint ranking', () => {
  it('scores Roman Urdu/code-switch terms without stripping negation or merging opposite-polarity items', () => {
    const request = makeRequest({ query: 'Is project ke liye formal tone nahi, baqi casual hi theek hai' })
    const formal = makeDocument({ id: 'formal', text: 'Is project ke liye formal tone nahi', polarity: 'negative' })
    const casual = makeDocument({ id: 'casual', text: 'Baqi casual hi theek hai', polarity: 'positive', reference: ref('assertion/test/2') })
    const ranked = rankLexicalDocuments(request, [formal, casual])
    expect(ranked.map((item) => item.id)).toContain('formal')
    expect(ranked.map((item) => item.id)).toContain('casual')
    expect(ranked.find((item) => item.id === 'formal')?.polarity).toBe('negative')
    expect(ranked.find((item) => item.id === 'casual')?.polarity).toBe('positive')
  })

  it('retains the explicit rejection reason without converting it into a global brand preference (C08)', () => {
    const request = makeRequest({ query: 'Suggest another laptop; avoid noisy fans.' })
    const rejection = makeDocument({
      id: 'laptop-rejection', kind: 'decision',
      text: 'Rejected Laptop A because its fan was too noisy; price was acceptable.',
      reference: ref('assertion/laptop-rejection'),
    })
    const ranked = rankLexicalDocuments(request, [rejection])
    expect(ranked.map((item) => item.text)).toEqual(['Rejected Laptop A because its fan was too noisy; price was acceptable.'])
    expect(ranked[0]?.text).not.toContain('prefers a particular brand')
  })

  it('surfaces quiet-meeting constraints independently of lexical overlap and keeps unknown conditions conditional (C09)', () => {
    const request = makeRequest({ activity: { kind: 'work_meeting', topicId: null, topicLabel: null, projectId: null, format: null, attributes: {} }, query: 'Find a place near the office.' })
    const quiet = makeDocument({
      id: 'quiet', kind: 'constraint', text: 'Quiet venues are required for work meetings.',
      conditions: [{ key: 'activity', operator: 'equals', value: 'work_meeting' }],
    })
    const conditional = makeDocument({
      id: 'unknown-location', kind: 'constraint', text: 'Must be close to the user’s office.', reference: ref('assertion/test/2'),
      conditions: [{ key: 'project', operator: 'equals', value: 'project/unknown' }],
    })
    const selected = selectApplicableConstraints(request, [quiet, conditional])
    expect(selected.find((item) => item.document.id === 'quiet')).toMatchObject({ applicability: 'applicable', isHardConstraint: true })
    expect(selected.find((item) => item.document.id === 'unknown-location')).toMatchObject({ applicability: 'conditional', isHardConstraint: true })
  })

  it('expires a dated temporary exception while retaining the still-valid stable preference (C07)', () => {
    const now = new Date()
    const request = makeRequest({
      query: 'Suggest a time for our meeting next week.',
      activity: { kind: 'meeting', topicId: null, topicLabel: null, projectId: null, format: null, attributes: {} },
    }, now)
    const stable = makeDocument({
      id: 'morning-default', kind: 'preference', text: 'Morning meetings work best.', reference: ref('assertion/morning'),
      conditions: [{ key: 'activity', operator: 'equals', value: 'meeting' }],
    })
    const exception = makeDocument({
      id: 'evening-exception', kind: 'preference', text: 'Evening meetings are acceptable for the dated exception.', reference: ref('assertion/evening'),
      temporalRelation: 'temporary_exception',
      validFrom: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      validUntil: new Date(now.getTime() - 86_400_000).toISOString(),
      conditions: [{ key: 'activity', operator: 'equals', value: 'meeting' }],
    })
    const selected = selectApplicableConstraints(request, [stable, exception])
    expect(selected.find((item) => item.document.id === 'morning-default')).toMatchObject({ applicability: 'applicable', isHardConstraint: false })
    expect(selected.find((item) => item.document.id === 'evening-exception')).toMatchObject({ applicability: 'expired', isHardConstraint: false })
  })

  it('preserves a project-local formal exception without promoting it over the general casual default (C28)', () => {
    const now = new Date()
    const casual = makeDocument({ id: 'general-casual', kind: 'preference', text: 'Keep general replies casual.', reference: ref('assertion/general-casual') })
    const formalProject = makeDocument({
      id: 'project-formal', kind: 'preference', text: 'Use a formal tone for this project.', reference: ref('assertion/project-formal'),
      conditions: [{ key: 'project', operator: 'equals', value: 'project/product-a' }],
    })
    const generalRequest = makeRequest({ query: 'Write a casual general response.' }, now)
    const generalSelected = selectApplicableConstraints(generalRequest, [casual, formalProject])
    expect(generalSelected.find((item) => item.document.id === 'general-casual')?.applicability).toBe('applicable')
    expect(generalSelected.find((item) => item.document.id === 'project-formal')?.applicability).toBe('conditional')

    const projectRequest = makeRequest({
      query: 'Write the formal project update.',
      activity: { kind: 'writing', topicId: null, topicLabel: null, projectId: 'project/product-a', format: 'update', attributes: {} },
    }, now)
    const projectSelected = selectApplicableConstraints(projectRequest, [casual, formalProject])
    expect(projectSelected.find((item) => item.document.id === 'project-formal')?.applicability).toBe('applicable')
    expect(projectSelected.find((item) => item.document.id === 'general-casual')).toBeUndefined()
  })

  it('uses current explicit task instructions over an old preference without rewriting the default (C36)', () => {
    const request = makeRequest({
      query: 'Show premium options within this budget.',
      taskOverrides: [{ id: 'task/premium', kind: 'budget', text: 'Show premium options within the budget the user supplied.', supersedesAssertionIds: ['assertion/low-cost'], conditions: [], authority: 'current_user_explicit' }],
      activity: { kind: 'shopping', topicId: null, topicLabel: null, projectId: null, format: 'comparison', attributes: { occupation: 'founder' } },
    })
    const oldPreference = makeDocument({ id: 'low-cost', kind: 'preference', text: 'Usually prefer low-cost options.', reference: ref('assertion/low-cost') })
    const selected = selectApplicableConstraints(request, [oldPreference])
    expect(selected).toMatchObject([{ applicability: 'overridden_for_task', isHardConstraint: false }])
    const pack = composeContextPack({ request, coverage: coverage(request), candidates: [candidate(oldPreference)], constraints: selected }, { id: 'words', countTokens: (text) => text.split(/\s+/u).filter(Boolean).length })
    expect(pack.text).toContain('Current explicit task instructions')
    expect(pack.text).toContain('Prior general preferences retained outside this task')
    expect(pack.text).toContain('not applicable to current task')
    expect(pack.sections.applicableConstraints).toEqual([])
    expect(pack.sections.overriddenDefaults).toHaveLength(1)
    expect(pack.text).not.toContain('founder')
  })

  it('exact vector search filters tenant, revision, model version, and dimension before scoring', () => {
    const request = makeRequest()
    const accepted = makeDocument({ id: 'right', reference: ref('assertion/test/right', 2) })
    const orthogonal = makeDocument({ id: 'orthogonal', reference: ref('assertion/test/orthogonal') })
    const opposite = makeDocument({ id: 'opposite', reference: ref('assertion/test/opposite') })
    const wrongTenant = makeDocument({ id: 'tenant-b', scopeId: 'user/another' as RetrievalDocument['scopeId'], reference: ref('assertion/test/b') })
    const oldRevision = makeDocument({ id: 'old-revision', reference: ref('assertion/test/right') })
    const embedding = (doc: RetrievalDocument, vector: number[], modelVersion = 'v1', dimension = vector.length) => ({
      scopeId: doc.scopeId, reference: doc.reference!, sourceKind: doc.sourceKind, sourceRef: doc.id, sourceEventId: null,
      modelId: 'local/test', modelVersion, dimension, contentHash: 'a'.repeat(64), vector,
    })
    const result = exactVectorSearch(request, { modelId: 'local/test', modelVersion: 'v1', dimension: 2, vector: [1, 0] }, [
      embedding(accepted, [1, 0]), embedding(wrongTenant, [1, 0]), embedding(oldRevision, [1, 0]), embedding(makeDocument({ id: 'bad-model' }), [1, 0], 'v0'),
      embedding(orthogonal, [0, 1]), embedding(opposite, [-1, 0]), { ...embedding(accepted, [1, 0]), sourceKind: 'episode' },
    ], [accepted, orthogonal, opposite, wrongTenant, oldRevision], 10)
    expect(result.documents.map((item) => item.id)).toEqual(['right'])
    expect(result.filteredCandidateCount).toBe(6)
  })
})

describe('Stage 08 context packs, budgets, and deep recall', () => {
  it('does not add unrelated personal profile material to a factual answer (C10)', () => {
    const request = makeRequest({ query: 'What is the boiling point of water at sea level?' })
    const profile = [
      makeDocument({ id: 'jazz', kind: 'preference', text: 'The user enjoys jazz concerts.', reference: ref('assertion/jazz') }),
      makeDocument({ id: 'quiet-cafes', kind: 'preference', text: 'The user likes quiet cafes.', reference: ref('assertion/quiet-cafes') }),
    ]
    const ranked = rankLexicalDocuments(request, profile)
    expect(ranked).toEqual([])
    const pack = composeContextPack({ request, coverage: coverage(request), candidates: ranked.map((document) => candidate(document)) }, { id: 'words', countTokens: (text) => text.split(/\s+/u).filter(Boolean).length })
    expect(pack.text).not.toContain('jazz')
    expect(pack.text).not.toContain('quiet cafes')
  })

  it('marks volatile remembered prices as historical and requires current-source verification (C35)', () => {
    const request = makeRequest({ query: 'Is this current price still correct?' })
    const price = makeDocument({ text: 'The current price was 240 dollars.', requiresCurrentVerification: true })
    const pack = composeContextPack({ request, coverage: coverage(request), candidates: [candidate(price)] }, { id: 'words', countTokens: (text) => text.split(/\s+/u).filter(Boolean).length })
    expect(pack.text).toContain('verify with a current authorized source')
    expect(pack.text).toContain('historical')
  })

  it('keeps a conflict bundle whole and does not choose by popularity', () => {
    const request = makeRequest()
    const left = makeDocument({ id: 'left', conflictGroupId: 'slot:conflict', status: 'accepted', text: 'The meeting starts at 9.', reference: ref('assertion/test/left') })
    const right = makeDocument({ id: 'right', conflictGroupId: 'slot:conflict', status: 'disputed', text: 'The meeting starts at 10.', reference: ref('assertion/test/right') })
    const pack = composeContextPack({ request, coverage: coverage(request), candidates: [candidate(left, 1), candidate(right, 0.01)] }, { id: 'words', countTokens: (text) => text.split(/\s+/u).filter(Boolean).length })
    expect(pack.sections.conflicts).toHaveLength(1)
    expect(pack.sections.conflicts[0].map((item) => item.document.id)).toEqual(['left', 'right'])
    expect(pack.text).toContain('do not silently choose')
  })

  it('never silently drops a hard constraint when the context budget is exhausted', () => {
    const request = makeRequest({ budget: { tier: 'compact', promptTokenLimit: 384, reserveAnswerTokens: 350, reserveToolTokens: 30 } })
    const hard = makeDocument({ id: 'hard', kind: 'constraint', text: 'Never use an inaccessible venue.', reference: ref('assertion/hard') })
    const selected = [{ document: hard, applicability: 'applicable' as const, reason: 'activity_matches', isHardConstraint: true }]
    const pack = composeContextPack({ request, coverage: coverage(request), candidates: [], constraints: selected }, { id: 'chars', countTokens: (text) => text.length })
    expect(pack.status).toBe('budget_exhausted')
    expect(pack.sections.omittedConstraintRefs).toContain('assertion/hard@1')
    expect(pack.tokenUsage.renderedMemoryTokens).toBeLessThanOrEqual(pack.tokenUsage.memoryTokenLimit)
    expect(pack.text === '' || /budget exhausted|not evidence of absence/i.test(pack.text)).toBe(true)
  })

  it('uses a supplied tokenizer against fully rendered text and reserves answer/tool overhead', () => {
    const request = makeRequest({ budget: { tier: 'standard', promptTokenLimit: 300, reserveAnswerTokens: 70, reserveToolTokens: 30 } })
    let lastRendered = ''
    const tokenizer = { id: 'test-exact', countTokens: (text: string) => { lastRendered = text; return text.split(/\s+/u).filter(Boolean).length } }
    const pack = composeContextPack({ request, coverage: coverage(request), candidates: [candidate(makeDocument())] }, tokenizer)
    expect(pack.tokenUsage.counter).toBe('test-exact')
    expect(pack.tokenUsage.memoryTokenLimit).toBe(200)
    expect(pack.tokenUsage.renderedMemoryTokens).toBe(tokenizer.countTokens(pack.text))
    expect(lastRendered).toBe(pack.text)
    expect(pack.tokenUsage.renderedMemoryTokens).toBeLessThanOrEqual(200)
  })

  it('keeps a higher-ranked fact when a lower-ranked item and its partial notice do not fit', () => {
    const request = makeRequest({ budget: { tier: 'standard', reserveAnswerTokens: 96, reserveToolTokens: 64 } })
    const primary = makeDocument({ id: 'primary', text: `Primary verified detail ${'important '.repeat(4)}`, reference: ref('assertion/primary') })
    const lower = makeDocument({ id: 'lower', text: `Lower-ranked background ${'secondary '.repeat(4)}`, reference: ref('assertion/lower') })
    const pack = composeContextPack({ request, coverage: coverage(request), candidates: [candidate(primary, 2), candidate(lower, 1)] })
    expect(pack.sections.relevantFacts.map((item) => item.document.id)).toContain('primary')
    expect(pack.sections.relevantFacts.map((item) => item.document.id)).not.toContain('lower')
    expect(pack.sections.omittedFactRefs).toContain('assertion/lower@1')
    expect(pack.text).toContain('Primary verified detail')
    expect(pack.text).toContain('Coverage: partial; context-omissions=1; search-not-absence=true.')
    expect(pack.tokenUsage.renderedMemoryTokens).toBeLessThanOrEqual(pack.tokenUsage.memoryTokenLimit)
  })

  it('reports bounded empty search as not found in this search, never as absolute absence (C27)', () => {
    const request = makeRequest()
    const pack = composeContextPack({ request, coverage: coverage(request), candidates: [] }, { id: 'chars', countTokens: (text) => text.length })
    expect(pack.text).toContain('not proof that the user never said it')
    expect(pack.coverage.noResultMeansAbsence).toBe(false)
  })

  it('passes cancellation and hard-caps deep-recall expansion/evidence work', async () => {
    const request = makeRequest()
    const result = await runBoundedDeepRecall(request, async ({ limits }) => limits, { maxExpansionEdges: 100, maxEvidenceFetches: 100 })
    expect(result).toMatchObject({ status: 'complete', value: { maxExpansionEdges: 32, maxEvidenceFetches: 64 } })
    const controller = new AbortController()
    controller.abort()
    expect(await runBoundedDeepRecall(request, async () => 'should not run', { signal: controller.signal })).toMatchObject({ status: 'cancelled', value: null })
  })
})
