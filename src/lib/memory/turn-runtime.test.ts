import { describe, expect, it } from 'vitest'
import { memoryTranscriptHash, sameMemoryRecallBinding, type MemoryRecallTurnContext } from './turn-runtime'

const binding = (patch: Partial<MemoryRecallTurnContext> = {}): MemoryRecallTurnContext => ({
  turnId: 'client-turn/1',
  responseId: 'server-response/1',
  principalId: 'user/1',
  scopeId: 'user/1',
  policyEpoch: 2,
  timezone: 'UTC',
  latestUserText: 'Use Java for this.',
  transcriptHash: 'hash/turn',
  speculative: true,
  conversationState: null,
  ...patch,
})

describe('turn-bound memory recall', () => {
  it('hashes exact transcript text deterministically without normalizing away corrections', async () => {
    const original = await memoryTranscriptHash('Use Java for this.')
    expect(original).toBe(await memoryTranscriptHash('Use Java for this.'))
    expect(original).not.toBe(await memoryTranscriptHash('Use Jev for this.'))
  })

  it('rejects a result from another owner turn generation or transcript', () => {
    const current = binding()
    expect(sameMemoryRecallBinding(current, binding())).toBe(true)
    expect(sameMemoryRecallBinding(current, binding({ responseId: 'server-response/2' }))).toBe(false)
    expect(sameMemoryRecallBinding(current, binding({ transcriptHash: 'hash/corrected' }))).toBe(false)
    expect(sameMemoryRecallBinding(current, binding({ turnId: 'client-turn/2' }))).toBe(false)
    expect(sameMemoryRecallBinding(current, binding({ principalId: 'user/2' }))).toBe(false)
    expect(sameMemoryRecallBinding(current, binding({ policyEpoch: 3 }))).toBe(false)
  })
})
