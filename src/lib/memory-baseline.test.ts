import { describe, expect, it } from 'vitest'
import { createCurrentMemoryBaseline, createProfileSessionSummaryBaseline, measureBaseline } from './memory-baseline'
import type { Memory } from './tools/memory'

const stamp = '2026-09-21T00:00:00.000Z'
const memories: Memory[] = [
  { id: 'quiet', kind: 'preference', text: 'The user prefers quiet venues for work meetings.', createdAt: stamp, usedAt: stamp, uses: 0 },
  { id: 'cello', kind: 'fact', text: 'The user plays the cello.', createdAt: stamp, usedAt: stamp, uses: 0 },
]

describe('memory baselines', () => {
  it('selects current memory without mutating usage metadata', () => {
    const before = structuredClone(memories)
    const adapter = createCurrentMemoryBaseline(memories)
    const result = adapter.select('where should we meet for work')

    expect(result).toMatchObject({ backend: 'legacy-memory', source: 'legacy-memory' })
    expect(result.records[0]).toMatchObject({ id: 'quiet', source: 'legacy-memory', kind: 'memory' })
    expect(memories).toEqual(before)
  })

  it('labels profile and session-summary material as supplied fixtures', () => {
    const adapter = createProfileSessionSummaryBaseline({
      profile: 'The user prefers concise replies.',
      sessions: [{ id: 'session-1', summary: 'The user compared quiet venues for a client meeting.' }],
    })
    const result = adapter.select('quiet meeting')

    expect(result.backend).toBe('profile-session-summary')
    expect(result.source).toBe('supplied-summary-fixture')
    expect(result.records[0]).toMatchObject({ id: 'session-1', kind: 'session-summary' })
    expect(result.context).toContain('[session-summary]')
  })

  it('measures only bounded metadata with an injectable clock', () => {
    const times = [10, 13]
    const measurements = measureBaseline(createCurrentMemoryBaseline(memories), [{ label: 'quiet', query: 'quiet' }], () => times.shift()!)

    expect(measurements).toEqual([
      {
        queryLabel: 'quiet',
        backend: 'legacy-memory',
        source: 'legacy-memory',
        selectionMs: 3,
        selectedCount: 1,
        contextChars: 57,
        estimatedTokens: 15,
      },
    ])
  })
})
