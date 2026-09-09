import { describe, expect, it } from 'vitest'
import {
  MAX_MEMORIES,
  MAX_MEMORY_LENGTH,
  type Memory,
  isMemory,
  rank,
  remember,
  similarity,
  stem,
  tokenise,
  touch,
} from './memory'

function make(text: string, overrides: Partial<Memory> = {}): Memory {
  const stamp = '2026-01-01T00:00:00.000Z'
  return {
    id: text.slice(0, 8),
    kind: 'fact',
    text,
    createdAt: stamp,
    usedAt: stamp,
    uses: 0,
    ...overrides,
  }
}

describe('tokenise', () => {
  it('drops punctuation and common words', () => {
    expect(tokenise('The user is learning to play the cello!')).toEqual([
      'user',
      'learn',
      'play',
      'cello',
    ])
  })

  it('strips a possessive so the name still matches', () => {
    expect(tokenise("Haseeb's laptop")).toEqual(['haseeb', 'laptop'])
  })
})

describe('stem', () => {
  it('collapses the inflections that actually come up', () => {
    expect(stem('plays')).toBe('play')
    expect(stem('running')).toBe('run')
    expect(stem('learning')).toBe('learn')
    expect(stem('studies')).toBe('study')
    expect(stem('preferred')).toBe('prefer')
  })

  it('leaves short words and genuine double-s endings alone', () => {
    expect(stem('cat')).toBe('cat')
    expect(stem('chess')).toBe('chess')
    expect(stem('focus')).toBe('focus')
  })
})

describe('similarity', () => {
  it('scores a restatement high', () => {
    expect(similarity('The user prefers tea', 'user prefers tea')).toBeGreaterThan(0.8)
  })

  it('scores unrelated facts near zero', () => {
    expect(similarity('The user prefers tea', 'The user lives in Lahore')).toBeLessThan(0.4)
  })

  it('is empty-safe', () => {
    expect(similarity('', 'anything')).toBe(0)
  })
})

describe('remember', () => {
  it('stores a new fact', () => {
    const { memories, result } = remember([], 'preference', 'The user prefers tea')
    expect(memories).toHaveLength(1)
    expect(result.status).toBe('stored')
    expect(result.memory.kind).toBe('preference')
  })

  it('merges a restatement instead of duplicating it', () => {
    const first = remember([], 'fact', 'The user prefers tea')
    const second = remember(first.memories, 'preference', 'The user prefers tea in the morning')
    expect(second.memories).toHaveLength(1)
    expect(second.result.status).toBe('merged')
    // The newer phrasing wins, and the kind is corrected with it.
    expect(second.memories[0].text).toBe('The user prefers tea in the morning')
    expect(second.memories[0].kind).toBe('preference')
  })

  it('truncates something far too long to be one fact', () => {
    const { result } = remember([], 'fact', 'x'.repeat(MAX_MEMORY_LENGTH + 100))
    expect(result.memory.text.length).toBe(MAX_MEMORY_LENGTH)
  })

  it('collapses whitespace so the same fact is recognised as the same', () => {
    const { result } = remember([], 'fact', '  The   user\n prefers tea  ')
    expect(result.memory.text).toBe('The user prefers tea')
  })

  it('evicts the least useful memory rather than the oldest when full', () => {
    // A precious old fact that keeps getting used, plus a full store of chaff.
    const precious = make('The user is allergic to penicillin', {
      id: 'precious',
      uses: 40,
      usedAt: '2026-06-01T00:00:00.000Z',
    })
    const chaff = Array.from({ length: MAX_MEMORIES - 1 }, (_, i) =>
      make(`disposable detail number ${i}`, { id: `chaff-${i}`, uses: 0 }),
    )

    const { memories } = remember([precious, ...chaff], 'fact', 'A brand new fact')
    expect(memories).toHaveLength(MAX_MEMORIES)
    expect(memories.some((memory) => memory.id === 'precious')).toBe(true)
  })
})

describe('rank', () => {
  const store = [
    make('The user plays the cello'),
    make('The user lives in Lahore'),
    make('The user is building a voice agent called GIDEON'),
  ]

  it('finds the memory the query is about', () => {
    expect(rank(store, 'what instrument do I play')[0]?.memory.text).toBe('The user plays the cello')
  })

  it('returns nothing when no term matches', () => {
    expect(rank(store, 'quantum chromodynamics')).toEqual([])
  })

  it('is empty-safe on both sides', () => {
    expect(rank([], 'anything')).toEqual([])
    expect(rank(store, '')).toEqual([])
  })

  it('weights a rare term above a term every memory shares', () => {
    // "user" appears in all three and should carry almost no signal; "cello"
    // appears once and should decide the ranking.
    const results = rank(store, 'user cello')
    expect(results[0]?.memory.text).toBe('The user plays the cello')
  })

  it('breaks a tie toward what was used more recently', () => {
    const now = Date.parse('2026-06-10T00:00:00.000Z')
    const stale = make('The user enjoys running', { id: 'stale', usedAt: '2026-01-01T00:00:00.000Z' })
    const fresh = make('The user enjoys running', { id: 'fresh', usedAt: '2026-06-09T00:00:00.000Z' })
    expect(rank([stale, fresh], 'running', now)[0]?.memory.id).toBe('fresh')
  })
})

describe('touch', () => {
  it('records that a memory was useful', () => {
    const memory = make('The user plays the cello')
    const [updated] = touch([memory], [memory], new Date('2026-06-01T00:00:00.000Z'))
    expect(updated.uses).toBe(1)
    expect(updated.usedAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('leaves untouched memories alone', () => {
    const a = make('a fact', { id: 'a' })
    const b = make('b fact', { id: 'b' })
    const result = touch([a, b], [a])
    expect(result.find((memory) => memory.id === 'b')?.uses).toBe(0)
  })

  it('is a no-op when nothing was used', () => {
    const memories = [make('a fact')]
    expect(touch(memories, [])).toBe(memories)
  })
})

describe('isMemory', () => {
  it('accepts a well-formed record', () => {
    expect(isMemory(make('a fact'))).toBe(true)
  })

  it('rejects junk from a corrupted or foreign file', () => {
    expect(isMemory(null)).toBe(false)
    expect(isMemory({ text: 'no id' })).toBe(false)
    expect(isMemory({ ...make('a fact'), kind: 'nonsense' })).toBe(false)
  })
})
