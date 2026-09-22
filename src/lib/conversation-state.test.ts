import { describe, expect, it } from 'vitest'
import {
  checkpointConversationState,
  conversationContext,
  createConversationState,
  expireConversationState,
  readConversationState,
  reduceConversationState,
  replayConversationState,
  resolveArtifactReference,
  resolveTopic,
  serializeConversationState,
  type ConversationEvent,
  type ConversationState,
} from './conversation-state'

const T1 = '2026-09-21T10:00:00.000Z'
const T2 = '2026-09-21T10:01:00.000Z'
const T3 = '2026-09-21T10:02:00.000Z'

function state(options: Parameters<typeof createConversationState>[0] = { conversationId: 'conversation/test', sessionId: 'session/test', now: T1 }): ConversationState {
  return createConversationState(options)
}

function apply(initial: ConversationState, events: readonly ConversationEvent[]): ConversationState {
  return replayConversationState(initial, events)
}

function turn(turnId: string, sequence: number, role: 'user' | 'assistant', text: string, committedAt = T1) {
  return {
    turnId,
    revision: 1,
    sequence,
    role,
    text,
    source: role === 'user' ? 'final_transcript' as const : 'assistant_generated' as const,
    committedAt,
    delivery: 'committed' as const,
    heardText: null,
  }
}

describe('bounded conversation continuity', () => {
  it('resolves an ordinal against the exact display revision that was shown', () => {
    const initial = state()
    const events: ConversationEvent[] = [
      {
        type: 'artifact_changed',
        snapshot: {
          artifactId: 'screen', displayRevision: 1, title: 'Results', sourceTurnId: 'turn/1', sourceSequence: 1, status: 'visible',
          items: [{ stableId: 'a', label: 'Laptop A', kind: 'product' }, { stableId: 'b', label: 'Laptop B', kind: 'product' }, { stableId: 'c', label: 'Laptop C', kind: 'product' }],
        },
      },
      {
        type: 'artifact_changed',
        snapshot: {
          artifactId: 'screen', displayRevision: 2, title: 'Results', sourceTurnId: 'turn/2', sourceSequence: 2, status: 'visible',
          items: [{ stableId: 'c', label: 'Laptop C', kind: 'product' }, { stableId: 'a', label: 'Laptop A', kind: 'product' }, { stableId: 'b', label: 'Laptop B', kind: 'product' }],
        },
      },
    ]
    const current = apply(initial, events)
    expect(resolveArtifactReference(current, { artifactId: 'screen', displayRevision: 1, ordinal: 2 })).toMatchObject({
      status: 'resolved', displayRevision: 1, item: { stableId: 'b', label: 'Laptop B' },
    })
    expect(resolveArtifactReference(current, { artifactId: 'screen', displayRevision: 2, ordinal: 2 })).toMatchObject({
      status: 'resolved', displayRevision: 2, item: { stableId: 'a', label: 'Laptop A' },
    })
  })

  it('asks when two suspended or active topics match instead of merging them', () => {
    const current = apply(state(), [
      { type: 'turn_committed', turn: turn('turn/a', 1, 'user', 'Open Alpha project'), topic: { topicId: 'topic/alpha', label: 'Alpha project' } },
      { type: 'topic_suspended', topicId: 'topic/alpha', sourceTurnId: 'turn/a', sourceSequence: 2 },
      { type: 'turn_committed', turn: turn('turn/b', 3, 'user', 'Open Beta project', T2), topic: { topicId: 'topic/beta', label: 'Beta project' } },
    ])
    expect(resolveTopic(current, 'project')).toMatchObject({ status: 'ambiguous' })
    const result = resolveTopic(current, 'project')
    if (result.status === 'ambiguous') expect(result.candidates.map((candidate) => candidate.topicId).sort()).toEqual(['topic/alpha', 'topic/beta'])
  })

  it('lets a final correction replace an ASR hypothesis and invalidates its descendants', () => {
    const current = apply(state(), [
      { type: 'turn_committed', turn: turn('turn/voice', 1, 'user', 'Use Java for this') },
      {
        type: 'referent_candidates', referenceId: 'ref/tech', sourceTurnId: 'turn/voice', sourceSequence: 2,
        candidates: [{ stableId: 'java', label: 'Java', kind: 'technology', sourceTurnId: 'turn/voice', artifactId: null, displayRevision: null }], derivedFrom: ['turn/voice'],
      },
      {
        type: 'turn_corrected', correctionId: 'correction/voice', turnId: 'turn/voice', previousRevision: 1, sourceSequence: 3,
        committed: { ...turn('turn/voice', 3, 'user', 'Use Jev for this', T2), revision: 2 },
      },
    ])
    expect(current.recentTurns).toHaveLength(1)
    expect(current.recentTurns[0]).toMatchObject({ text: 'Use Jev for this', revision: 2 })
    expect(current.referents[0]?.status).toBe('invalidated')
    expect(conversationContext(current)).toContain('Use Jev for this')
    expect(conversationContext(current)).not.toContain('Use Java for this')
  })

  it('keeps constraints and choices local to their topic, including rejection reasons', () => {
    const initial = state()
    const current = apply(initial, [
      { type: 'turn_committed', turn: turn('turn/a', 1, 'user', 'Laptop A'), topic: { topicId: 'topic/a', label: 'Laptop choice' } },
      {
        type: 'decision_recorded',
        decision: {
          decisionId: 'decision/laptop', topicId: 'topic/a', question: 'Which laptop?',
          alternatives: [{ stableId: 'laptop-a', label: 'Laptop A', rejectionReason: 'Fan noise' }, { stableId: 'laptop-b', label: 'Laptop B', rejectionReason: null }],
          selectedId: null, statedReasons: [], unresolvedFactors: ['cost'], sourceTurnId: 'turn/a', sourceSequence: 2, status: 'open', derivedFrom: ['turn/a'],
        },
      },
      {
        type: 'local_constraint',
        constraint: { constraintId: 'constraint/a', text: 'Quiet fan matters for this laptop choice.', topicId: 'topic/a', sourceTurnId: 'turn/a', sourceSequence: 3, expiresAt: null, status: 'active', derivedFrom: ['turn/a'] },
      },
    ])
    const checkpoint = checkpointConversationState(current, { now: T2 })
    expect(checkpoint.checkpoint?.reasons).toContain('Laptop A: Fan noise')
    expect(checkpoint.checkpoint?.openItems).toContain('cost')
    expect(conversationContext(checkpoint)).toContain('Quiet fan matters')
    expect(conversationContext(checkpoint)).not.toContain('global')
  })

  it('distinguishes a proposal or promise from a verified outcome', () => {
    const current = apply(state(), [
      { type: 'proposal_state', proposal: { proposalId: 'proposal/email', text: 'I will email tomorrow.', sourceTurnId: 'turn/1', sourceSequence: 1, status: 'proposed', derivedFrom: ['turn/1'] } },
      { type: 'commitment_state', commitment: { commitmentId: 'commitment/email', text: 'Email tomorrow', sourceTurnId: 'turn/1', sourceSequence: 2, status: 'accepted', receiptId: null, derivedFrom: ['turn/1'] } },
    ])
    expect(checkpointConversationState(current, { now: T2 }).checkpoint?.meaningfulOutcomes).toEqual([])
    const verified = reduceConversationState(current, {
      type: 'tool_outcome',
      outcome: { outcomeId: 'outcome/email', requestId: null, toolName: 'email', summary: 'Email provider receipt received.', sourceTurnId: 'turn/2', sourceSequence: 3, status: 'verified', receiptId: 'receipt/email/1', derivedFrom: ['turn/2'] },
    })
    expect(checkpointConversationState(verified, { now: T3 }).checkpoint?.meaningfulOutcomes).toEqual(['Email provider receipt received.'])
  })

  it('resumes a suspended topic without importing another topic’s local constraint', () => {
    const current = apply(state(), [
      { type: 'turn_committed', turn: turn('turn/a', 1, 'user', 'Work on Alpha', T1), topic: { topicId: 'topic/alpha', label: 'Alpha' } },
      { type: 'topic_suspended', topicId: 'topic/alpha', sourceTurnId: 'turn/a', sourceSequence: 2 },
      { type: 'local_constraint', constraint: { constraintId: 'constraint/a', text: 'Alpha needs a quiet room.', topicId: 'topic/alpha', sourceTurnId: 'turn/a', sourceSequence: 3, expiresAt: null, status: 'active', derivedFrom: ['turn/a'] } },
      { type: 'turn_committed', turn: turn('turn/b', 4, 'user', 'Work on Beta', T2), topic: { topicId: 'topic/beta', label: 'Beta' } },
      { type: 'local_constraint', constraint: { constraintId: 'constraint/b', text: 'Beta needs a large budget.', topicId: 'topic/beta', sourceTurnId: 'turn/b', sourceSequence: 5, expiresAt: null, status: 'active', derivedFrom: ['turn/b'] } },
      { type: 'topic_suspended', topicId: 'topic/beta', sourceTurnId: 'turn/b', sourceSequence: 6 },
      { type: 'topic_resumed', topicId: 'topic/alpha', sourceTurnId: 'turn/a', sourceSequence: 7 },
    ])
    expect(current.activeTopic?.topicId).toBe('topic/alpha')
    const context = conversationContext(current)
    expect(context).toContain('Alpha needs a quiet room.')
    expect(context).not.toContain('Beta needs a large budget.')
  })

  it('replaces a temporary local instruction while preserving old history outside the active state', () => {
    const current = apply(state(), [
      { type: 'local_constraint', constraint: { constraintId: 'style/current', text: 'Keep it low cost.', topicId: null, sourceTurnId: 'turn/old', sourceSequence: 1, expiresAt: null, status: 'active', derivedFrom: ['turn/old'] } },
      { type: 'local_constraint', constraint: { constraintId: 'style/current', text: 'Use the premium budget for this presentation.', topicId: null, sourceTurnId: 'turn/current', sourceSequence: 2, expiresAt: null, status: 'active', derivedFrom: ['turn/current'] } },
    ])
    const context = conversationContext(current)
    expect(context).toContain('premium budget')
    expect(context).not.toContain('low cost')
    expect(current.localConstraints).toHaveLength(1)
  })

  it('round-trips the full bounded state and expires temporary state deterministically', () => {
    const current = apply(state({ conversationId: 'conversation/roundtrip', sessionId: 'session/test', now: T1, expiresAt: T3 }), [
      { type: 'turn_committed', turn: turn('turn/1', 1, 'user', 'Keep this thread', T1), topic: { topicId: 'topic/1', label: 'Thread', expiresAt: T2 } },
      { type: 'referent_candidates', referenceId: 'ref/1', sourceTurnId: 'turn/1', sourceSequence: 2, candidates: [{ stableId: 'item/1', label: 'Item one', kind: 'item', sourceTurnId: 'turn/1', artifactId: 'screen', displayRevision: 1 }], derivedFrom: ['turn/1'] },
      { type: 'open_question', question: { questionId: 'question/1', text: 'What is the cost?', topicId: 'topic/1', sourceTurnId: 'turn/1', sourceSequence: 3, status: 'open', derivedFrom: ['turn/1'] } },
    ])
    const checkpointed = checkpointConversationState(current, { now: T2, expiresAt: T3 })
    const restored = readConversationState(serializeConversationState(checkpointed))
    expect(restored).not.toBeNull()
    expect(restored).toMatchObject({ activeTopic: { topicId: 'topic/1' }, referents: [{ referenceId: 'ref/1' }], openQuestions: [{ text: 'What is the cost?' }] })
    const expired = expireConversationState(checkpointed, T3)
    expect(expired.activeTopic).toBeNull()
    expect(expired.checkpoint).toBeNull()
    expect(expired.expiresAt).toBe(T3)
  })
})
