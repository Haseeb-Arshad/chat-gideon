import { describe, expect, it } from 'vitest'
import { MAX_MEMORIES, EphemeralMemoryStore, type Memory, type MemoryStore } from './memory'
import { runServerTool, type ToolContext } from './registry'

/**
 * The memory tools as the speaking model calls them. Replacement and forgetting
 * are destructive, so both are pinned to what the user actually said: an
 * unambiguous selector, exact words, and nothing else going with it.
 */

const context = (store: MemoryStore): ToolContext => ({
  store,
  timezone: 'UTC',
  signal: new AbortController().signal,
  env: () => undefined,
})

async function kept(store: MemoryStore) {
  return (await store.all()).map((memory) => memory.text)
}

async function fullStore(): Promise<EphemeralMemoryStore> {
  const stamp = '2026-01-01T00:00:00.000Z'
  const memories: Memory[] = Array.from({ length: MAX_MEMORIES }, (_, i) => ({
    id: `existing-${i}`,
    kind: 'fact',
    text: `Existing durable detail ${i}`,
    createdAt: stamp,
    usedAt: stamp,
    uses: 1,
  }))
  const store = new EphemeralMemoryStore()
  // The fixture is intentionally a direct seed: it models legacy state without
  // making the admission test depend on 400 setup tool calls.
  await store.save(memories)
  return store
}

class RejectingStore implements MemoryStore {
  private readonly memories: Memory[] = []

  all = async () => structuredClone(this.memories)

  save = async (_memories: Memory[]) => {
    throw new Error('storage rejected the write')
  }

  mutate = async <T>(change: (memories: Memory[]) => { memories: Memory[]; result: T }) => {
    const { memories, result } = change(structuredClone(this.memories))
    await this.save(memories)
    return result
  }
}

describe('remember a fact that has changed', () => {
  it('takes the old fact out as it keeps the new one', async () => {
    const store = new EphemeralMemoryStore()
    await runServerTool('remember', { text: 'The user lives on Mill Lane in York.' }, context(store))
    await runServerTool('remember', { text: "The user's sister is called Aisha." }, context(store))

    const outcome = await runServerTool('remember', { text: 'The user lives in Leeds.', replaces: 'where the user lives' }, context(store))

    expect(outcome.content).toBe('Replaced 1 older memory. Stored.')
    expect(await kept(store)).toEqual(["The user's sister is called Aisha.", 'The user lives in Leeds.'])
  })

  it('replaces only what is about the same thing as the new fact, however loosely it was named', async () => {
    const store = new EphemeralMemoryStore()
    await runServerTool('remember', { text: 'The user is vegetarian.' }, context(store))
    await runServerTool('remember', { text: 'The user takes tea with milk.' }, context(store))

    // Both old facts answer to what it was told to replace, but the new fact is about tea, not about being vegetarian.
    const loose = await runServerTool('remember', { text: 'The user likes their tea strong.', replaces: 'vegetarian tea' }, context(store))

    expect(loose.content).toBe('Replaced 1 older memory. Stored.')
    expect(await kept(store)).toEqual(['The user is vegetarian.', 'The user likes their tea strong.'])
  })

  it('replaces nothing on a match with "the user" alone, or on nothing at all', async () => {
    const store = new EphemeralMemoryStore()
    await runServerTool('remember', { text: 'The user lives on Mill Lane in York.' }, context(store))
    await runServerTool('remember', { text: 'The user plays the cello.' }, context(store))

    const vague = await runServerTool('remember', { text: 'The user is learning Spanish.', replaces: 'the user' }, context(store))
    expect(vague.content).toBe('Stored.')
    const unmatched = await runServerTool('remember', { text: 'The user drinks tea.', replaces: 'their car' }, context(store))
    expect(unmatched.content).toBe('Stored.')

    expect(await kept(store)).toHaveLength(4)
  })
})

describe('forget', () => {
  it('removes only the memory every word of the query names', async () => {
    const store = new EphemeralMemoryStore()
    await runServerTool('remember', { text: 'The user is allergic to peanuts.' }, context(store))
    await runServerTool('remember', { text: 'The user is allergic to shellfish.' }, context(store))
    await runServerTool('remember', { text: 'The user plays the cello.' }, context(store))

    const outcome = await runServerTool('forget', { query: 'allergic to peanuts' }, context(store))

    expect(outcome.ok).toBe(true)
    expect(await kept(store)).toEqual(['The user is allergic to shellfish.', 'The user plays the cello.'])
  })

  it('removes nothing when the query only shares words with unrelated facts', async () => {
    const store = new EphemeralMemoryStore()
    await runServerTool('remember', { text: 'The user is allergic to peanuts.' }, context(store))
    await runServerTool('remember', { text: 'The user plays the cello.' }, context(store))

    const outcome = await runServerTool('forget', { query: 'cello playing' }, context(store))

    expect(outcome.content).toBe('There was nothing stored about that.')
    expect(await kept(store)).toEqual(['The user is allergic to peanuts.', 'The user plays the cello.'])
  })

  it('refuses to act when the query alone would match everything', async () => {
    const store = new EphemeralMemoryStore()
    await runServerTool('remember', { text: 'The user is allergic to peanuts.' }, context(store))
    await runServerTool('remember', { text: 'The user plays the cello.' }, context(store))

    const outcome = await runServerTool('forget', { query: 'the user' }, context(store))

    expect(outcome.content).toBe('There was nothing stored about that.')
    expect(await kept(store)).toHaveLength(2)
  })
})

describe('truthful admission and storage receipts', () => {
  it('returns a failed receipt when the full legacy cache cannot retain the new fact', async () => {
    const store = await fullStore()

    const outcome = await runServerTool(
      'remember',
      { text: 'The user prefers quiet venues' },
      context(store),
    )

    expect(outcome).toMatchObject({
      ok: false,
      summary: 'Memory was not stored: capacity reached',
    })
    expect(outcome.content).toContain('was not retained')
    expect(await kept(store)).not.toContain('The user prefers quiet venues')
    expect(await store.all()).toHaveLength(MAX_MEMORIES)
  })

  it('turns a storage.save rejection into a failed receipt and action summary', async () => {
    const store = new RejectingStore()

    const outcome = await runServerTool('remember', { text: 'The user prefers tea' }, context(store))

    expect(outcome).toMatchObject({ ok: false, summary: 'Memory was not stored' })
    expect(outcome.content).toContain('Nothing was confirmed as stored')
    expect(await store.all()).toEqual([])
  })
})
