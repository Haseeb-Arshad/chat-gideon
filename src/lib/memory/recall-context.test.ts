import { describe, expect, it } from 'vitest'
import { createConversationState, replayConversationState, type ConversationEvent } from '../conversation-state'
import { correctShape, recallFieldsFromConversation, rememberShape } from './recall-context'

const T = '2026-09-23T10:00:00.000Z'
const turn = (turnId: string, sequence: number, role: 'user' | 'assistant', text: string) => ({
  turnId, revision: 1, sequence, role, text,
  source: role === 'user' ? 'final_transcript' as const : 'assistant_generated' as const,
  committedAt: T, delivery: 'committed' as const, heardText: null,
})
const fresh = () => createConversationState({ conversationId: 'conversation/recall', sessionId: 'session/recall', now: T })

describe('recall fields from conversation state', () => {
  it('is empty and topic-free without a conversation state', () => {
    expect(recallFieldsFromConversation(null, 'hello')).toMatchObject({ recentSpan: [], taskOverrides: [], resolved: { topicId: null }, activity: { kind: null, topicId: null } })
  })

  it('carries the active topic, the turns before the query, and local instructions', () => {
    const events: ConversationEvent[] = [
      { type: 'turn_committed', turn: turn('turn/1', 1, 'user', 'Plan the Lahore offsite'), topic: { topicId: 'topic/offsite', label: 'Lahore offsite' } },
      { type: 'turn_committed', turn: turn('turn/2', 2, 'assistant', 'Sure, for how many people?') },
      { type: 'local_constraint', constraint: { constraintId: 'constraint/quiet', text: 'Only quiet venues for this.', topicId: 'topic/offsite', sourceTurnId: 'turn/1', sourceSequence: 3, expiresAt: null, status: 'active', derivedFrom: ['turn/1'] } },
      { type: 'local_constraint', constraint: { constraintId: 'constraint/other', text: 'Other topic rule.', topicId: 'topic/other', sourceTurnId: 'turn/1', sourceSequence: 4, expiresAt: null, status: 'active', derivedFrom: ['turn/1'] } },
      { type: 'turn_committed', turn: turn('turn/3', 5, 'user', 'Twelve people, where should we go?') },
    ]
    const fields = recallFieldsFromConversation(replayConversationState(fresh(), events), 'Twelve people, where should we go?')
    expect(fields.resolved).toMatchObject({ topicId: 'topic/offsite', topicLabel: 'Lahore offsite' })
    expect(fields.activity).toMatchObject({ kind: null, topicId: 'topic/offsite' })
    expect(fields.recentSpan?.map((item) => item.sequence)).toEqual([1, 2])
    expect(fields.recentSpan?.every((item) => item.committed)).toBe(true)
    expect(fields.taskOverrides?.map((item) => item.id)).toEqual(['constraint/quiet'])
  })

  it('marks a shortened recent turn instead of cutting it silently', () => {
    const state = replayConversationState(fresh(), [{ type: 'turn_committed', turn: turn('turn/long', 1, 'user', 'x'.repeat(900)) }])
    const [span] = recallFieldsFromConversation(state, 'next').recentSpan ?? []
    expect(span?.text.length).toBeLessThanOrEqual(500)
    expect(span?.text.endsWith('…[truncated]')).toBe(true)
  })
})

describe('explicit memory command shapes', () => {
  const now = new Date(T)

  it('scopes a preference to the active topic only when asked, and refuses without a topic', () => {
    const state = replayConversationState(fresh(), [{ type: 'turn_committed', turn: turn('turn/1', 1, 'user', 'For this deck'), topic: { topicId: 'topic/deck', label: 'Investor deck' } }])
    expect(rememberShape({}, state, 'UTC', now)).toEqual({ ok: true, value: { conditions: [] } })
    expect(rememberShape({ appliesTo: 'this_topic' }, state, 'UTC', now)).toEqual({ ok: true, value: { conditions: [{ key: 'topic', operator: 'equals', value: 'topic/deck' }] } })
    expect(rememberShape({ appliesTo: 'this_topic' }, fresh(), 'UTC', now).ok).toBe(false)
  })

  it('turns an expiry date into a temporary exception ending at local midnight after that day', () => {
    const shape = rememberShape({ until: '2026-09-30' }, null, 'Asia/Karachi', now)
    expect(shape).toMatchObject({ ok: true, value: { relation: 'temporary_exception', validTime: { from: T, until: '2026-09-30T19:00:00.000Z', precision: 'second', sourceTimeZone: 'Asia/Karachi' } } })
    expect(rememberShape({ until: '2026-09-01' }, null, 'UTC', now).ok).toBe(false)
    expect(rememberShape({ until: 'next week' }, null, 'UTC', now).ok).toBe(false)
  })

  it('keeps a mistake distinct from a real change and dates a change in the user zone', () => {
    expect(correctShape({}, 'UTC', now)).toEqual({ ok: true, value: { relation: 'correction' } })
    expect(correctShape({ change: 'changed', since: '2026-06-01' }, 'Asia/Karachi', now)).toEqual({
      ok: true, value: { relation: 'transition', validTime: { from: '2026-05-31T19:00:00.000Z', until: null, precision: 'day', sourceTimeZone: 'Asia/Karachi' } },
    })
    expect(correctShape({ change: 'changed' }, 'Asia/Karachi', now)).toMatchObject({ ok: true, value: { relation: 'transition', validTime: { from: '2026-09-22T19:00:00.000Z', precision: 'day' } } })
    expect(correctShape({ change: 'changed', since: 'last spring' }, 'UTC', now).ok).toBe(false)
  })
})
