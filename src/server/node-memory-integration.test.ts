import { describe, expect, it } from 'vitest'
import { createServerMemorySession } from './memory-session'
import { buildCommittedUserEvent } from './node-memory-integration'
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
