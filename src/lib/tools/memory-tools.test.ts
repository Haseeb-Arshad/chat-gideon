import { describe, expect, it } from 'vitest'
import { EphemeralMemoryStore } from './memory'
import { runServerTool, type ToolContext } from './registry'

/**
 * The memory tools as the speaking model calls them. Replacement and forgetting
 * are destructive, so both are pinned to what the user actually said: an
 * unambiguous selector, exact words, and nothing else going with it.
 */

const context = (store: EphemeralMemoryStore): ToolContext => ({
  store,
  timezone: 'UTC',
  signal: new AbortController().signal,
  env: () => undefined,
})

async function kept(store: EphemeralMemoryStore) {
  return (await store.all()).map((memory) => memory.text)
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
