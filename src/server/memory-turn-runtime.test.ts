import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostgresMemoryStore } from '../../backend/memory/src/postgres.ts'
import type { MemorySession } from '../lib/memory/contracts'
import { memoryFeatureFlags } from '../lib/memory/rollout'
import { sameMemoryRecallBinding, type MemoryRecallTurnContext } from '../lib/memory/turn-runtime'

const fixtures = vi.hoisted(() => ({
  prepare: vi.fn(),
  retrieve: vi.fn(),
  mode: vi.fn(),
}))
vi.mock('../../backend/memory/src/retrieval.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../backend/memory/src/retrieval.ts')>(),
  prepareMemoryRetrieval: fixtures.prepare,
  retrieveMemory: fixtures.retrieve,
}))
vi.mock('../../backend/memory/src/controls.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../backend/memory/src/controls.ts')>(),
  readMemoryMode: fixtures.mode,
}))
import { createRuntime } from './memory-turn-runtime'

/**
 * The automatic lookup started from a released transcript, before its turn
 * arrives. The database side of the reuse (what may be borrowed and the
 * closing check) is in `recall-latency.live.test.ts`; this is the turn side:
 * which turns may borrow, and that they keep their own binding.
 */

const FLAGS = memoryFeatureFlags({ GIDEON_MEMORY_ROLLOUT_PERCENT: '100', GIDEON_MEMORY_CAPTURE_ENABLED: '1', GIDEON_MEMORY_COMMAND_WRITES_ENABLED: '1', GIDEON_MEMORY_RECALL_ENABLED: '1' }, 'user/x', true)
const session = {
  trust: 'authenticated',
  principal: { id: 'principal/owner' },
  scope: { id: 'scope/owner' },
  policyEpoch: 3,
  store: {},
} as unknown as MemorySession<PostgresMemoryStore>
const SAID = 'Where does my sister live?'

function turn(text: string, overrides: Partial<MemoryRecallTurnContext> = {}): MemoryRecallTurnContext {
  return {
    turnId: 'turn-1', responseId: 'response-1', principalId: session.principal.id, scopeId: session.scope.id, policyEpoch: session.policyEpoch,
    timezone: 'Asia/Karachi', latestUserText: text, transcriptHash: `hash/${text}`, speculative: false, conversationState: null,
    ...overrides,
  }
}

function pack() {
  const authority = { principalId: session.principal.id, scopeId: session.scope.id, policyEpoch: session.policyEpoch }
  return { status: 'ready', text: 'Your sister lives in Lahore.', authenticatedContext: authority, coverage: { authority } }
}

/** What `retrieveMemory` was handed as an early reading on its nth call, if anything. */
const borrowedOn = (call = 0) => (fixtures.retrieve.mock.calls[call]?.[2] as { prepared?: unknown } | undefined)?.prepared

let handles: object[]
beforeEach(() => {
  handles = []
  fixtures.prepare.mockImplementation(() => {
    const handle = { settled: Promise.resolve() }
    handles.push(handle)
    return handle
  })
  fixtures.retrieve.mockImplementation(async (_session: unknown, _input: unknown, options: { prepared?: unknown }) => ({
    ok: true, request: null, pack: pack(), diagnostics: options.prepared ? { earlyReading: true } : {},
  }))
  fixtures.mode.mockResolvedValue({ temporary: false, learningEnabled: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the lookup started from a released transcript', () => {
  it('is borrowed by the turn those exact words start, which keeps its own binding', async () => {
    const runtime = createRuntime(session, FLAGS)
    await runtime.prefetch!(SAID, { timezone: 'Asia/Karachi', conversationState: null })
    expect(fixtures.prepare).toHaveBeenCalledOnce()
    expect(fixtures.prepare.mock.calls[0][1]).toMatchObject({ query: SAID, consistency: 'warm_preferred' })

    const context = turn(SAID)
    const result = await runtime.retrieve(SAID, context, new AbortController().signal)
    expect(borrowedOn()).toBe(handles[0])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    // The pack is composed for this turn's request and bound to this turn alone.
    expect(result.binding).toBe(context)
    expect(sameMemoryRecallBinding(context, result.binding)).toBe(true)
    // Recorded with the turn, so production shows how often the reading was ready in time.
    expect(result.early).toBe(true)
    expect(fixtures.retrieve.mock.calls[0][1]).toMatchObject({ query: SAID, requestedTime: { timeZone: 'Asia/Karachi' } })
    // The temporary-mode read started with the reading serves the turn too.
    expect(fixtures.mode).toHaveBeenCalledOnce()
  })

  it.each([
    ['punctuation', 'Where does my sister live'],
    ['case', 'where does my sister live?'],
    ['a longer sentence', `${SAID} And what does she do?`],
  ])('is not borrowed by a turn whose words differ in %s', async (_difference, said) => {
    const runtime = createRuntime(session, FLAGS)
    await runtime.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    const result = await runtime.retrieve(said, turn(said), new AbortController().signal)
    expect(result).toMatchObject({ status: 'ready' })
    expect(result).not.toHaveProperty('early')
    expect(fixtures.retrieve).toHaveBeenCalledOnce()
    expect(borrowedOn()).toBeUndefined()
  })

  it('is not borrowed once it is more than a few seconds old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const prompt = createRuntime(session, FLAGS)
    const late = createRuntime(session, FLAGS)
    await prompt.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    await late.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    vi.setSystemTime(Date.now() + 2_900)
    await prompt.retrieve(SAID, turn(SAID), new AbortController().signal)
    expect(borrowedOn(0)).toBe(handles[0])

    vi.setSystemTime(Date.now() + 200)
    await late.retrieve(SAID, turn(SAID), new AbortController().signal)
    expect(borrowedOn(1)).toBeUndefined()
  })

  it('is used by one committed turn only', async () => {
    const runtime = createRuntime(session, FLAGS)
    await runtime.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    await runtime.retrieve(SAID, turn(SAID), new AbortController().signal)
    await runtime.retrieve(SAID, turn(SAID, { turnId: 'turn-2', responseId: 'response-2' }), new AbortController().signal)
    expect(borrowedOn(0)).toBe(handles[0])
    expect(borrowedOn(1)).toBeUndefined()
  })

  it('is replaced by the next transcript, so earlier words are no longer borrowed', async () => {
    const runtime = createRuntime(session, FLAGS)
    await runtime.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    await runtime.prefetch!('What does she do?', { timezone: 'UTC', conversationState: null })
    await runtime.retrieve(SAID, turn(SAID), new AbortController().signal)
    expect(borrowedOn()).toBeUndefined()
  })

  it('sends nothing to the embedding provider and returns nothing in a temporary conversation', async () => {
    fixtures.mode.mockResolvedValue({ temporary: true, learningEnabled: true })
    const authorize = vi.fn(() => true)
    const runtime = createRuntime(session, FLAGS, { authorizeRemoteEmbedding: authorize })
    await runtime.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    const early = fixtures.prepare.mock.calls[0][2] as { authorizeRemoteEmbedding: (...args: unknown[]) => Promise<boolean> }
    // The reading started on the transcript waits for the setting before its embedding, as the turn's own does.
    expect(await early.authorizeRemoteEmbedding(session, { purpose: 'query_embedding', scopeId: session.scope.id, documentCount: 1 })).toBe(false)
    expect(authorize).not.toHaveBeenCalled()

    const result = await runtime.retrieve(SAID, turn(SAID), new AbortController().signal)
    expect(result).toEqual({ status: 'unavailable', reason: 'temporary' })
  })

  it('lets a speculative guess borrow only its own exact words, and gives the committed turn its own pack', async () => {
    const runtime = createRuntime(session, FLAGS)
    await runtime.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    const guess = 'Where does my sis'
    await runtime.retrieve(guess, turn(guess, { turnId: 'guess-1', speculative: true }), new AbortController().signal)
    expect(borrowedOn(0)).toBeUndefined()

    const speculative = turn(SAID, { turnId: 'guess-2', responseId: 'response-guess', speculative: true })
    const guessed = await runtime.retrieve(SAID, speculative, new AbortController().signal)
    const committed = turn(SAID)
    const answered = await runtime.retrieve(SAID, committed, new AbortController().signal)
    expect(borrowedOn(1)).toBe(handles[0])
    expect(borrowedOn(2)).toBe(handles[0])
    // Each composed its own pack, bound to itself; neither binding matches the other turn's.
    expect(fixtures.retrieve).toHaveBeenCalledTimes(3)
    if (guessed.status !== 'ready' || answered.status !== 'ready') throw new Error('expected both lookups to answer')
    expect(guessed.binding).toBe(speculative)
    expect(answered.binding).toBe(committed)
    expect(sameMemoryRecallBinding(committed, guessed.binding)).toBe(false)
    expect(answered.pack).not.toBe(guessed.pack)
  })

  it('is not used for a deep lookup', async () => {
    const runtime = createRuntime(session, FLAGS)
    await runtime.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    await runtime.retrieve(SAID, turn(SAID, { depth: 'deep' }), new AbortController().signal)
    expect(borrowedOn()).toBeUndefined()
  })

  it('is not started for an owner without recall, or for silence', async () => {
    const off = createRuntime(session, memoryFeatureFlags({ GIDEON_MEMORY_ROLLOUT_PERCENT: '100', GIDEON_MEMORY_CAPTURE_ENABLED: '1' }, 'user/x', true))
    await off.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    const guest = createRuntime({ ...session, trust: 'ephemeral' } as unknown as MemorySession<PostgresMemoryStore>, FLAGS)
    await guest.prefetch!(SAID, { timezone: 'UTC', conversationState: null })
    await createRuntime(session, FLAGS).prefetch!('   ', { timezone: 'UTC', conversationState: null })
    expect(fixtures.prepare).not.toHaveBeenCalled()
    expect(fixtures.mode).not.toHaveBeenCalled()
  })
})
