import { describe, expect, it } from 'vitest'
import {
  bindMemoryCommand,
  evaluateGrant,
  isSelfClaim,
  parseAssertionVersion,
  parseEventEnvelope,
  parseSessionDescriptor,
  parsePublicMemoryCommand,
  parseReceipt,
  sourceBasisFor,
  sourceCanEstablishAssistantText,
  sourceCanEstablishSelfAssertion,
  type RevisionId,
} from './contracts'
import { TestMemoryAdapter } from './test-adapter'

const event = {
  schemaVersion: 1,
  id: 'event/1',
  idempotencyKey: 'turn-1:user-1',
  conversationId: 'conversation/1',
  turnId: 'turn/1',
  actor: { kind: 'principal', principalId: 'user/1' },
  subject: { kind: 'known', subjectId: 'user/1' },
  sourceKind: 'user_statement',
  sourceAuthority: { kind: 'authenticated_user', revision: 'auth/1' },
  committedPhase: 'committed',
  sequence: 1,
  sourceTime: null,
  sourceTimePrecision: 'unknown',
  receivedAt: '2026-09-21T10:00:00.000Z',
  consent: null,
  sourceSpans: [],
  payload: { text: 'The user likes tea.' },
} as const

const session = {
  schemaVersion: 1,
  trust: 'authenticated',
  authority: 'node_signed_cookie',
  principal: { id: 'user/1', kind: 'anonymous', trust: 'authenticated' },
  client: { id: 'http/user-1', channel: 'http', connectionRevision: null },
  subject: { kind: 'known', subjectId: 'user/1' },
  scope: { id: 'user/1', kind: 'account', parentId: null },
  grants: [{ id: 'grant/user/1', scopeId: 'user/1', actions: ['read', 'remember', 'correct', 'forget', 'recall'], issuedBy: 'server_policy', expiresAt: null }],
  policyEpoch: 1,
} as const

describe('memory contract runtime validation', () => {
  it('validates a committed event from JSON-shaped data', () => {
    const parsed = parseEventEnvelope(JSON.parse(JSON.stringify(event)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.subject).toEqual({ kind: 'known', subjectId: 'user/1' })
  })

  it('rejects malformed JSON shapes and unsafe unknown enum values', () => {
    expect(parseEventEnvelope({ ...event, sequence: '1' }).ok).toBe(false)
    expect(parseEventEnvelope({ ...event, committedPhase: 'speculative' }).ok).toBe(false)
    expect(parseEventEnvelope({ ...event, sourceTime: '2026-09-21', sourceTimePrecision: 'unknown' }).ok).toBe(false)
    expect(parseEventEnvelope({ ...event, payload: { text: 'x'.repeat(17_000) } }).ok).toBe(false)
  })

  it('rejects invalid source spans instead of trusting offsets', () => {
    const parsed = parseEventEnvelope({
      ...event,
      sourceSpans: [{
        document: { sourceId: 'source/1', revision: 'source-rev/1', contentHash: '0123456789abcdef' },
        start: 9,
        end: 3,
        textHash: '0123456789abcdef',
        quote: 'tea',
      }],
    })
    expect(parsed.ok).toBe(false)
  })

  it('keeps a colleague quote attributed to the third party', () => {
    const quoted = {
      ...event,
      id: 'event/quote',
      actor: { kind: 'third_party', label: 'colleague', externalId: null },
      subject: { kind: 'unresolved', label: 'colleague' },
      sourceKind: 'quoted_third_party',
      sourceAuthority: { kind: 'third_party_evidence', revision: 'source-rev/1' },
      payload: { text: 'I hate working remotely.' },
    }
    const parsed = parseEventEnvelope(quoted)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(isSelfClaim(parsed.value.actor, parsed.value.subject)).toBe(false)
      expect(sourceBasisFor(parsed.value.sourceKind, parsed.value.actor, parsed.value.subject)).toBe('attributed_third_party')
    }
  })

  it('does not treat hypothetical future speech as an explicit self fact', () => {
    const hypothetical = {
      ...event,
      id: 'event/hypothetical',
      payload: { text: 'Imagine I move to Tokyo next year.', mode: 'hypothetical' },
    }
    const parsed = parseEventEnvelope(hypothetical)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(sourceBasisFor(parsed.value.sourceKind, parsed.value.actor, parsed.value.subject)).toBe('explicit_user_statement')
      expect(sourceCanEstablishSelfAssertion(parsed.value.sourceKind, parsed.value.actor, parsed.value.subject, parsed.value.payload)).toBe(false)
    }
  })

  it('accepts a conditional preference and preserves an unknown effective date', () => {
    const parsed = parseAssertionVersion({
      schemaVersion: 1,
      id: 'assertion/1',
      revision: 1,
      scopeId: 'user/1',
      subject: { kind: 'known', subjectId: 'user/1' },
      kind: 'preference',
      payload: {
        kind: 'preference',
        text: 'Prefers quiet venues',
        conditions: [{ key: 'activity', operator: 'equals', value: 'work_meeting' }],
        exceptions: [],
      },
      attribution: { actor: { kind: 'principal', principalId: 'user/1' }, basis: 'explicit_user_statement' },
      polarity: 'positive',
      status: 'accepted',
      time: {
        validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null },
        receivedAt: '2026-09-21T10:00:00.000Z',
        interpretedAt: '2026-09-21T10:00:00.000Z',
        relation: 'ordinary',
      },
      evidence: [],
      dependencies: [],
      producer: { name: 'explicit-command', version: '1', model: null },
    })
    expect(parsed.ok).toBe(true)
  })

  it('requires a bounded serialized state for episode checkpoints', () => {
    const base = {
      schemaVersion: 1,
      id: 'assertion/episode/1',
      revision: 1,
      scopeId: 'user/1',
      subject: { kind: 'known', subjectId: 'user/1' },
      kind: 'episode_checkpoint',
      attribution: { actor: { kind: 'assistant', assistantId: 'gideon' }, basis: 'inference' },
      polarity: 'unknown',
      status: 'accepted',
      time: { validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null }, receivedAt: '2026-09-21T10:00:00.000Z', interpretedAt: '2026-09-21T10:00:00.000Z', relation: 'ordinary' },
      evidence: [],
      dependencies: [],
      producer: { name: 'conversation-state', version: '1', model: null },
    }
    const payload = {
      kind: 'episode_checkpoint',
      topic: 'Plans',
      decisions: [],
      alternatives: ['Plan A', 'Plan B'],
      reasons: ['Cost unresolved'],
      openItems: ['cost'],
      meaningfulOutcomes: [],
      sourceWatermark: 'turn/3',
      state: { schemaVersion: 1, sourceSequence: 3, recentTurns: [] },
    }
    expect(parseAssertionVersion({ ...base, payload }).ok).toBe(true)
    expect(parseAssertionVersion({ ...base, payload: { ...payload, state: undefined } }).ok).toBe(false)
  })

  it('rejects unregistered slot cardinality but permits unresolved free-form claims', () => {
    const base = {
      schemaVersion: 1,
      id: 'assertion/slot',
      revision: 1,
      scopeId: 'user/1',
      subject: { kind: 'unresolved', label: 'colleague' },
      kind: 'fact',
      attribution: { actor: { kind: 'third_party', label: 'colleague', externalId: null }, basis: 'attributed_third_party' },
      polarity: 'positive',
      status: 'candidate',
      time: { validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null }, receivedAt: '2026-09-21T10:00:00.000Z', interpretedAt: '2026-09-21T10:00:00.000Z', relation: 'ordinary' },
      evidence: [],
      dependencies: [],
      producer: { name: 'test', version: '1', model: null },
    }
    expect(parseAssertionVersion({ ...base, payload: { kind: 'fact', proposition: { type: 'slot', slot: { slotId: 'person.favorite_color', cardinality: 'scalar' }, value: 'blue' } } }).ok).toBe(false)
    expect(parseAssertionVersion({ ...base, payload: { kind: 'fact', proposition: { type: 'free_form', text: 'The colleague dislikes remote work.', subject: { kind: 'unresolved', label: 'colleague' }, conditions: [] } } }).ok).toBe(true)
  })

  it('rejects client attempts to provide tenant, grants, or source authority', () => {
    const command = parsePublicMemoryCommand({
      schemaVersion: 1,
      commandId: 'command/1',
      kind: 'remember',
      text: 'The user likes tea.',
      assertionKind: 'preference',
      conditions: [],
      scopeId: 'user/other',
      grants: ['forget'],
      sourceAuthority: 'server',
    })
    expect(command.ok).toBe(false)
    if (!command.ok) expect(command.error.issues.some((item) => item.code === 'unsafe_field')).toBe(true)
  })

  it('binds command authority from the session rather than command data', () => {
    const parsedSession = parseSessionDescriptor(session)
    expect(parsedSession.ok).toBe(true)
    const command = parsePublicMemoryCommand({ schemaVersion: 1, commandId: 'command/1', kind: 'remember', text: 'The user likes tea.', assertionKind: 'preference', conditions: [] })
    expect(command.ok).toBe(true)
    if (parsedSession.ok && command.ok) {
      const bound = bindMemoryCommand({ ...parsedSession.value, store: { marker: 'test-only' } }, command.value)
      expect(bound.ok).toBe(true)
      if (bound.ok) {
        expect(bound.value.scope.id).toBe('user/1')
        expect(bound.value.principalId).toBe('user/1')
        expect(bound.value.sourceAuthority.kind).toBe('authenticated_user')
      }
    }
  })

  it('denies a cross-scope candidate read before selection', () => {
    const parsedSession = parseSessionDescriptor(session)
    expect(parsedSession.ok).toBe(true)
    if (parsedSession.ok) {
      expect(evaluateGrant(parsedSession.value, 'recall', 'user/other' as never)).toMatchObject({ allowed: false, failure: { code: 'unauthorized' } })
    }
  })

  it('does not turn retrieved prompt injection into action authority', () => {
    const parsedSession = parseSessionDescriptor(session)
    expect(parsedSession.ok).toBe(true)
    if (parsedSession.ok) {
      const result = evaluateGrant(parsedSession.value, 'export')
      expect(result.allowed).toBe(false)
      expect(sourceCanEstablishAssistantText('assistant_displayed', { kind: 'client_report', revision: 'source-rev/1' as RevisionId })).toBe(false)
    }
  })

  it('rejects forged browser assistant attribution', () => {
    const parsed = parseEventEnvelope({
      ...event,
      sourceKind: 'assistant_generated',
      actor: { kind: 'principal', principalId: 'user/1' },
      sourceAuthority: { kind: 'client_report', revision: 'client-rev/1' },
    })
    expect(parsed.ok).toBe(false)
  })

  it('rejects contradictory receipt states', () => {
    expect(parseReceipt({
      schemaVersion: 1,
      receiptId: 'receipt/1',
      eventId: 'event/1',
      receivedAt: '2026-09-21T10:00:00.000Z',
      ok: true,
      state: 'accepted',
      canonicalRevision: null,
      indexWatermark: 'watermark/1',
    }).ok).toBe(false)
    expect(parseReceipt({
      schemaVersion: 1,
      receiptId: 'receipt/2',
      eventId: 'event/1',
      receivedAt: '2026-09-21T10:00:00.000Z',
      ok: false,
      state: 'failed',
      canonicalRevision: null,
      indexWatermark: null,
      failure: { code: 'unavailable', message: 'Try again.', retryable: true },
    }).ok).toBe(true)
    expect(parseReceipt({
      schemaVersion: 1,
      receiptId: 'receipt/3',
      eventId: 'event/1',
      receivedAt: '2026-09-21T10:00:00.000Z',
      ok: false,
      state: 'failed',
      canonicalRevision: null,
      indexWatermark: null,
      failure: { code: 'validation', message: 'Bad input.', retryable: false, details: { raw: { secret: 'do not keep' } } },
    }).ok).toBe(false)
  })

  it('keeps unknown future schema versions out of the accepted contract', () => {
    expect(parsePublicMemoryCommand({ schemaVersion: 99, commandId: 'command/1', kind: 'recall', query: 'tea', limit: 1 }).ok).toBe(false)
  })

  it('uses the test adapter to retain exact versions and suppressions', async () => {
    const adapter = new TestMemoryAdapter()
    const parsed = parseEventEnvelope(event)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const first = await adapter.transaction(async (transaction) => transaction.insertEvent(parsed.value))
    const duplicate = await adapter.transaction(async (transaction) => transaction.insertEvent(parsed.value))
    expect(first).toBe('inserted')
    expect(duplicate).toBe('duplicate')
    expect(await adapter.transaction((transaction) => transaction.findEventByIdempotency(event.idempotencyKey))).toMatchObject({ id: 'event/1' })
  })

  it('keeps the public session descriptor free of storage handles', () => {
    const parsed = parseSessionDescriptor(session)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect('store' in parsed.value).toBe(false)
  })
})
