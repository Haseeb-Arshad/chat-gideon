import { describe, expect, it } from 'vitest'
import { createServerMemorySession } from '../src/server/memory-session.ts'
import { EphemeralMemoryStore } from '../src/lib/tools/memory.ts'
import type { ExactVersionRef } from '../src/lib/memory/contracts.ts'
import {
  composeContextPack,
  createRetrievalRequest,
  exactVectorSearch,
  fuseRetrievalBranches,
  rankLexicalDocuments,
  selectApplicableConstraints,
  type RetrievalCoverage,
  type RetrievalDocument,
  type RetrievalRequest,
  type VersionedEmbedding,
} from '../src/lib/memory/retrieval.ts'

const session = createServerMemorySession({
  owner: 'user/stage08-synthetic-ablation',
  store: new EphemeralMemoryStore(),
  channel: 'test',
  authority: 'worker_auth_session',
})

function reference(assertionId: string): ExactVersionRef {
  return { assertionId: assertionId as ExactVersionRef['assertionId'], revision: 1 }
}

function makeRequest(query: string, now: Date): RetrievalRequest {
  const parsed = createRetrievalRequest(session, {
    query,
    resolved: { topicId: null, topicLabel: null, entities: [], assertionIds: [], artifactIds: [], unknownReferents: [] },
    activity: { kind: 'board_meeting', topicId: null, topicLabel: null, projectId: null, format: null, attributes: {} },
    requestedTime: { mode: 'current', instant: null, timeZone: 'UTC' },
    consistency: 'authoritative',
    budget: { tier: 'maximum', reserveAnswerTokens: 96, reserveToolTokens: 64 },
    deadlineAt: new Date(now.getTime() + 10_000).toISOString(),
  }, { now: now.toISOString() })
  if (!parsed.ok) throw new Error(parsed.failure.message)
  return parsed.request
}

function makeDocument(request: RetrievalRequest, id: string, text: string, kind: RetrievalDocument['kind'] = 'fact'): RetrievalDocument {
  const ref = reference(`assertion/stage08/${id}`)
  return {
    id: `assertion:${ref.assertionId}:${ref.revision}`,
    scopeId: request.authenticatedContext.scopeId,
    reference: ref,
    sourceKind: 'assertion',
    kind,
    text,
    status: 'accepted',
    polarity: 'positive',
    subjectId: session.subject.kind === 'known' ? session.subject.subjectId : null,
    topicId: null,
    topicLabel: null,
    projectId: null,
    artifactIds: [],
    slotId: null,
    conflictGroupId: null,
    conditions: kind === 'constraint' ? [{ key: 'activity', operator: 'equals', value: 'board_meeting' }] : [],
    exceptions: [],
    validFrom: null,
    validUntil: null,
    temporalRelation: 'ordinary',
    historical: false,
    interpretedAt: request.createdAt,
    receivedAt: request.createdAt,
    basis: 'synthetic_fixture',
    evidence: [],
    sourceEventId: null,
    requiresCurrentVerification: false,
  }
}

function packCoverage(request: RetrievalRequest, candidateCount: number): RetrievalCoverage {
  const branch = { status: 'complete' as const, candidates: candidateCount, reason: null }
  return {
    outcome: 'complete',
    branches: {
      exact: branch,
      warm: { status: 'not_configured', candidates: 0, reason: 'synthetic_ablation' },
      lexical: branch,
      semantic: branch,
      evidence: { status: 'not_configured', candidates: 0, reason: 'synthetic_ablation' },
    },
    candidateCount,
    filteredCandidateCount: 0,
    expansionEdges: 0,
    evidenceFetches: 0,
    noResultMeansAbsence: false,
    authority: { ...request.authenticatedContext, deletionEpoch: 0 },
    freshness: { state: 'authoritative', observedAt: request.createdAt, watermark: null },
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

describe('Stage 08 paired synthetic retrieval ablation', () => {
  it('compares lexical, hybrid, and independent applicability paths without provider calls or user data', () => {
    const fixtures = Array.from({ length: 12 }, (_, index) => {
      const now = new Date(Date.now() + index)
      const query = `Lahore gathering ${index}`
      const request = makeRequest(query, now)
      const lexicalRelevant = makeDocument(request, `lexical-${index}`, `Lahore gathering ${index} near the station.`)
      const semanticRelevant = makeDocument(request, `semantic-${index}`, 'Juniper chamber suits small groups.')
      const hardConstraint = makeDocument(request, `constraint-${index}`, 'Step-free access is required.', 'constraint')
      const irrelevant = makeDocument(request, `irrelevant-${index}`, 'Aquarium hobby: volcanic geology and citrus fruit.', 'preference')
      return { request, query, lexicalRelevant, semanticRelevant, hardConstraint, irrelevant }
    })

    const variants = {
      lexical: { relevant: 0, includedRelevant: 0, possible: 0, hardConstraints: 0, candidates: [] as number[], contextBytes: [] as number[], elapsedMs: [] as number[] },
      hybrid: { relevant: 0, includedRelevant: 0, possible: 0, hardConstraints: 0, candidates: [] as number[], contextBytes: [] as number[], elapsedMs: [] as number[] },
      applicability: { relevant: 0, includedRelevant: 0, possible: 0, hardConstraints: 0, candidates: [] as number[], contextBytes: [] as number[], elapsedMs: [] as number[] },
    }
    let filteredCandidateCount = 0

    for (const fixture of fixtures) {
      const { request, lexicalRelevant, semanticRelevant, hardConstraint, irrelevant } = fixture
      const allDocuments = [lexicalRelevant, semanticRelevant, hardConstraint, irrelevant]
      const lexicalStart = performance.now()
      const lexicalDocs = rankLexicalDocuments(request, allDocuments, 8)
      const lexicalCandidates = fuseRetrievalBranches([{ name: 'lexical', documents: lexicalDocs, reason: 'paired_baseline' }], 8)
      const lexicalElapsed = performance.now() - lexicalStart

      const embeddings: VersionedEmbedding[] = allDocuments.map((document) => ({
        scopeId: request.authenticatedContext.scopeId,
        reference: document.reference!,
        sourceKind: 'assertion',
        sourceRef: `assertion/${document.reference!.assertionId}/1`,
        sourceEventId: null,
        modelId: 'fixture/deterministic',
        modelVersion: 'synthetic-v1',
        dimension: 2,
        contentHash: 'a'.repeat(64),
        vector: document.id === semanticRelevant.id ? [1, 0] : [0, 1],
      }))
      embeddings.push({
        ...embeddings[0]!,
        scopeId: 'user/unrelated-scope' as RetrievalDocument['scopeId'],
        reference: reference(`assertion/stage08/unrelated-${fixture.query.length}`),
        sourceRef: 'assertion/unrelated/1',
        vector: [1, 0],
      })
      embeddings.push({
        ...embeddings[0]!,
        modelVersion: 'wrong-fixture-version',
        reference: semanticRelevant.reference!,
        sourceRef: `assertion/${semanticRelevant.reference!.assertionId}/1`,
        vector: [1, 0],
      })
      const hybridStart = performance.now()
      const semanticSearch = exactVectorSearch(request, { modelId: 'fixture/deterministic', modelVersion: 'synthetic-v1', dimension: 2, vector: [1, 0] }, embeddings, allDocuments, 8)
      filteredCandidateCount += semanticSearch.filteredCandidateCount
      const hybridCandidates = fuseRetrievalBranches([
        { name: 'lexical', documents: lexicalDocs, reason: 'paired_baseline' },
        { name: 'semantic', documents: semanticSearch.documents, reason: 'synthetic_vector_fixture' },
      ], 8)
      const hybridElapsed = performance.now() - hybridStart

      const modes = [
        { name: 'lexical' as const, candidates: lexicalCandidates, elapsed: lexicalElapsed, allConstraintDocs: lexicalCandidates.map((item) => item.document) },
        { name: 'hybrid' as const, candidates: hybridCandidates, elapsed: hybridElapsed, allConstraintDocs: hybridCandidates.map((item) => item.document) },
        { name: 'applicability' as const, candidates: hybridCandidates, elapsed: hybridElapsed, allConstraintDocs: [...hybridCandidates.map((item) => item.document), hardConstraint] },
      ]
      const gold = new Set([lexicalRelevant.id, semanticRelevant.id])
      for (const mode of modes) {
        const compositionStarted = performance.now()
        const selectedConstraints = selectApplicableConstraints(request, mode.allConstraintDocs)
        const pack = composeContextPack({
          request,
          coverage: packCoverage(request, mode.candidates.length),
          candidates: mode.candidates,
          constraints: selectedConstraints,
        })
        const variant = variants[mode.name]
        variant.possible += gold.size
        variant.relevant += mode.candidates.filter((item) => gold.has(item.document.id)).length
        variant.includedRelevant += pack.sections.relevantFacts.filter((item) => gold.has(item.document.id)).length
        variant.hardConstraints += pack.sections.applicableConstraints.filter((item) => item.isHardConstraint && item.applicability === 'applicable').length
        variant.candidates.push(mode.candidates.length)
        variant.contextBytes.push(new TextEncoder().encode(pack.text).length)
        variant.elapsedMs.push(mode.elapsed + performance.now() - compositionStarted)
      }

      const fullConstraints = selectApplicableConstraints(request, [...hybridCandidates.map((item) => item.document), hardConstraint])
      expect(fullConstraints.some((item) => item.document.id === hardConstraint.id && item.applicability === 'applicable')).toBe(true)
    }

    const report = {
      schemaVersion: 1,
      evidenceType: 'synthetic_development_fixture_only',
      fixtureCount: fixtures.length,
      goldRelevantDocumentsPerFixture: 2,
      contextCounter: 'utf8-byte-upper-bound-v1',
      provider: { model: null, externalCalls: 0, networkCalls: 0, costUsd: 0 },
      variants: Object.fromEntries(Object.entries(variants).map(([name, value]) => [name, {
        relevantRecall: Number((value.relevant / value.possible).toFixed(4)),
        relevantHits: value.relevant,
        relevantPossible: value.possible,
        contextRelevantRecall: Number((value.includedRelevant / value.possible).toFixed(4)),
        contextRelevantHits: value.includedRelevant,
        applicableHardConstraints: value.hardConstraints,
        applicableHardConstraintPossible: fixtures.length,
        medianCandidates: median(value.candidates),
        medianContextBytes: median(value.contextBytes),
        medianLocalFixtureLatencyMs: Number(median(value.elapsedMs).toFixed(4)),
      }])),
      diagnostics: {
        filteredCandidates: filteredCandidateCount,
        expectedFilteredCandidates: fixtures.length * 5,
        rawTextLogged: false,
      },
      caveat: 'Fixture vectors are hand-authored control-flow probes, not a semantic model and not evidence of real-world retrieval quality or latency.',
    }
    console.info('[stage08-retrieval-ablation]', JSON.stringify(report))

    expect(variants.lexical.relevant / variants.lexical.possible).toBeLessThan(variants.hybrid.relevant / variants.hybrid.possible)
    expect(variants.applicability.hardConstraints).toBe(fixtures.length)
    expect(variants.hybrid.hardConstraints).toBe(0)
    expect(filteredCandidateCount).toBe(fixtures.length * 5)
    for (const variant of Object.values(variants)) {
      for (const contextBytes of variant.contextBytes) expect(contextBytes).toBeLessThanOrEqual(2_912)
    }
  })
})
