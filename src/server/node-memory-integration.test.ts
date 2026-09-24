import { describe, expect, it } from 'vitest'
import { createServerMemorySession } from './memory-session'
import { buildCommittedUserEvent, createRecallInput } from './node-memory-integration'
import { createConversationState, replayConversationState } from '../lib/conversation-state'
import { composeContextPack, createRetrievalRequest, type RetrievalCoverage, type RetrievalDocument } from '../lib/memory/retrieval'
import { EphemeralMemoryStore } from '../lib/tools/memory'

describe('Node memory integration capture boundary', () => {
  it('creates one idempotent authenticated user event from only the final user turn', () => {
    const session = createServerMemorySession({
      owner: 'user/stage09-capture',
      store: new EphemeralMemoryStore(),
      channel: 'http',
      authority: 'node_signed_cookie',
    })
    const event = buildCommittedUserEvent(session, {
      turnId: 'client-turn-1',
      conversationId: 'browser-conversation-1',
      principalId: session.principal.id,
      scopeId: session.scope.id,
      policyEpoch: session.policyEpoch,
      latestUserText: 'My current project is ChatGideon.',
      transcriptHash: 'unused-by-event-envelope',
    })
    expect(event).toMatchObject({
      sourceKind: 'user_statement',
      sourceAuthority: { kind: 'authenticated_user' },
      actor: { kind: 'principal', principalId: session.principal.id },
      subject: session.subject,
      consent: { purpose: 'memory_capture' },
      payload: { text: 'My current project is ChatGideon.' },
    })
    expect(event?.sourceSpans).toHaveLength(1)
    expect(event?.sourceSpans[0]).toMatchObject({ start: 0, end: 'My current project is ChatGideon.'.length, quote: 'My current project is ChatGideon.' })
    expect(event?.idempotencyKey).toBe(buildCommittedUserEvent(session, {
      turnId: 'client-turn-1',
      conversationId: 'browser-conversation-1',
      principalId: session.principal.id,
      scopeId: session.scope.id,
      policyEpoch: session.policyEpoch,
      latestUserText: 'My current project is ChatGideon.',
      transcriptHash: 'different-on-retry',
    })?.idempotencyKey)
    expect(JSON.stringify(event)).not.toContain('assistant')
  })

  it('refuses empty and oversized source text before any durable capture call', () => {
    const session = createServerMemorySession({
      owner: 'user/stage09-capture-bounds', store: new EphemeralMemoryStore(), channel: 'http', authority: 'node_signed_cookie',
    })
    const base = {
      turnId: 'client-turn-2', conversationId: 'browser-conversation-2', principalId: session.principal.id,
      scopeId: session.scope.id, policyEpoch: session.policyEpoch, transcriptHash: 'hash',
    }
    expect(buildCommittedUserEvent(session, { ...base, latestUserText: '   ' })).toBeNull()
    expect(buildCommittedUserEvent(session, { ...base, latestUserText: 'x'.repeat(8_193) })).toBeNull()
  })
})

describe('Node memory integration recall request', () => {
  it('builds a retrieval request the retrieval contract accepts, for ordinary and deep recall', () => {
    const session = createServerMemorySession({ owner: 'user/stage13-recall', store: new EphemeralMemoryStore(), channel: 'http', authority: 'node_signed_cookie' })
    for (const depth of [undefined, 'deep' as const]) {
      const parsed = createRetrievalRequest(session, createRecallInput('what do I like to drink?', 'Asia/Karachi', null, 'what do I like to drink?', depth))
      expect(parsed.ok, depth ?? 'standard').toBe(true)
    }
  })

  it('leaves room for real memory under the default byte counter instead of collapsing to "budget exhausted"', () => {
    const session = createServerMemorySession({ owner: 'user/stage13-budget', store: new EphemeralMemoryStore(), channel: 'http', authority: 'node_signed_cookie' })
    const query = 'Suggest a creamy curry I could make tonight.'
    const state = replayConversationState(createConversationState({ conversationId: 'conversation/budget', now: '2026-09-20T12:00:00.000Z' }), [{
      type: 'turn_committed',
      turn: { turnId: 'turn/budget', revision: 1, sequence: 1, role: 'user', text: query, source: 'final_transcript', committedAt: '2026-09-20T12:00:00.000Z', delivery: 'committed', heardText: null },
    }])
    const parsed = createRetrievalRequest(session, createRecallInput(query, 'UTC', state, query))
    if (!parsed.ok) throw new Error(parsed.failure.message)
    const document = (id: string, kind: 'constraint' | 'fact', text: string) => ({
      id, scopeId: session.scope.id, reference: { assertionId: `assertion/command/${id.padEnd(40, '0')}`, revision: 1 }, sourceKind: 'assertion', kind, text,
      status: 'accepted', polarity: 'positive', subjectId: null, topicId: null, topicLabel: null, projectId: null, artifactIds: [], slotId: null,
      conflictGroupId: null, conditions: [], exceptions: [], validFrom: null, validUntil: null, temporalRelation: 'ordinary', historical: false,
      interpretedAt: '2026-09-20T12:00:00.000Z', receivedAt: '2026-09-20T12:00:00.000Z', basis: 'explicit_user_statement',
      evidence: [{ eventId: `event/${id}`, relation: 'supports', sourceRef: `source/${id}` }], sourceEventId: null, requiresCurrentVerification: false,
    }) as unknown as RetrievalDocument
    const constraint = document('nuts', 'constraint', 'I am allergic to tree nuts, especially cashews')
    const facts = ['I usually cook dinner for four people', 'I prefer vegetarian meals', 'I live in Faisalabad'].map((text, index) => document(`fact${index}`, 'fact', text))
    const pack = composeContextPack({
      request: parsed.request,
      coverage: { outcome: 'complete', branches: {}, candidateCount: 4, filteredCandidateCount: 0, freshness: { state: 'authoritative' } } as unknown as RetrievalCoverage,
      candidates: facts.map((item) => ({ document: item, fusedScore: 1, branches: ['lexical'], reasons: ['test'] })),
      constraints: [{ document: constraint, applicability: 'applicable', reason: 'test', isHardConstraint: true }],
    })
    expect(pack.status).not.toBe('budget_exhausted')
    expect(pack.text).toContain('allergic to tree nuts')
    for (const item of facts) expect(pack.text).toContain(item.text)
    expect(pack.tokenUsage.renderedMemoryTokens).toBeLessThanOrEqual(pack.tokenUsage.memoryTokenLimit)
  })
})
