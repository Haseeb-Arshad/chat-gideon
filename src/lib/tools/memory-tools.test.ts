import { describe, expect, it } from 'vitest'
import { EphemeralMemoryStore } from './memory'
import { runServerTool, type ToolContext } from './registry'

/**
 * The memory tools as the speaking model calls them. What is pinned here is
 * the one call that changes two things: a fact that has changed takes the old
 * one's place, and takes nothing else with it.
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
