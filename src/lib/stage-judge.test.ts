import { describe, expect, it, vi } from 'vitest'
import { decideMove, judgeScreen, readScreen, type JudgeDeps, type ScreenState } from './stage-judge'

/**
 * The screen follows the conversation: a card steps aside when the talk moves
 * on and comes back when its topic does. The model makes the call; these check
 * that nothing it says can do more than that, and that the page's own account
 * of what it is showing is never taken on trust.
 */

const SCREEN: ScreenState = {
  open: true,
  front: 'turn-2:call_0',
  cards: [
    { id: 'turn-1:call_0', title: 'Albert Einstein', query: 'Who was Albert Einstein?', kind: 'entity' },
    { id: 'turn-2:call_0', title: 'Chocolate cake', query: 'chocolate cake', kind: 'gallery' },
  ],
}
const LABELS = ['c1', 'c2']

describe('readScreen', () => {
  it('keeps well-formed cards and drops everything else', () => {
    const screen = readScreen({
      open: true,
      front: 'b',
      cards: [
        { id: 'a', title: 'Albert Einstein', query: 'who was einstein', kind: 'entity' },
        { id: 'a', title: 'Duplicate' },
        { title: 'No id' },
        { id: 'c', title: '' },
        'not a card',
        { id: 'b', title: '  Chocolate\n cake ', query: 'cake', kind: 'gallery' },
      ],
    })
    expect(screen).toEqual({
      open: true,
      front: 'b',
      cards: [
        { id: 'a', title: 'Albert Einstein', query: 'who was einstein', kind: 'entity' },
        { id: 'b', title: 'Chocolate cake', query: 'cake', kind: 'gallery' },
      ],
    })
  })

  it('is only open in front of a card it actually has', () => {
    expect(readScreen({ open: true, front: 'missing', cards: [{ id: 'a', title: 'A' }] })).toMatchObject({
      open: false,
      front: null,
    })
  })

  it('shows nothing for nothing', () => {
    expect(readScreen(undefined)).toBeNull()
    expect(readScreen({ cards: [] })).toBeNull()
    expect(readScreen('cards')).toBeNull()
  })

  it('keeps no more than the newest twelve, and bounds every field', () => {
    const cards = Array.from({ length: 20 }, (_, index) => ({ id: `id-${index}`, title: 'x'.repeat(500) }))
    const screen = readScreen({ cards })!
    expect(screen.cards).toHaveLength(12)
    expect(screen.cards[0].id).toBe('id-8')
    expect(screen.cards[0].title).toHaveLength(120)
  })
})

describe('decideMove', () => {
  const PUT_AWAY: ScreenState = { ...SCREEN, open: false, front: null }

  it('leaves the open card alone while the talk is about it', () => {
    expect(decideMove({ about: 'c2', close: false }, SCREEN, LABELS)).toBeNull()
  })

  it('brings a card forward when the talk is about it', () => {
    expect(decideMove({ about: 'c1', close: false }, SCREEN, LABELS)).toEqual({
      op: 'show',
      card: 'turn-1:call_0',
    })
    // Including the one that was in front before everything was put away.
    expect(decideMove({ about: 'c2', close: false }, PUT_AWAY, LABELS)).toEqual({
      op: 'show',
      card: 'turn-2:call_0',
    })
    expect(decideMove({ about: 1 }, PUT_AWAY, LABELS)).toEqual({ op: 'show', card: 'turn-1:call_0' })
  })

  it('steps aside when the talk is about none of them, or asks to close', () => {
    expect(decideMove({ about: null, close: false }, SCREEN, LABELS)).toEqual({ op: 'tuck' })
    expect(decideMove({ about: 'c2', close: true }, SCREEN, LABELS)).toEqual({ op: 'tuck' })
    // Nothing is open, so there is nothing to step aside.
    expect(decideMove({ about: null, close: false }, PUT_AWAY, LABELS)).toBeNull()
  })

  it('knows a card by its title as well as its label', () => {
    expect(decideMove({ about: 'Chocolate cake', close: false }, PUT_AWAY, LABELS)).toEqual({
      op: 'show',
      card: 'turn-2:call_0',
    })
    expect(decideMove({ about: 'c1 (Albert Einstein)', close: false }, SCREEN, LABELS)).toEqual({
      op: 'show',
      card: 'turn-1:call_0',
    })
    // A title shortened the way people shorten it still names the card.
    expect(decideMove({ about: 'einstein', close: false }, SCREEN, LABELS)).toEqual({
      op: 'show',
      card: 'turn-1:call_0',
    })
    expect(decideMove({ about: 'it', close: false }, SCREEN, LABELS)).toBeNull()
  })

  it('changes nothing for an answer that names no card', () => {
    expect(decideMove({ about: 'c9', close: false }, SCREEN, LABELS)).toBeNull()
    expect(decideMove({ close: false }, SCREEN, LABELS)).toBeNull()
    expect(decideMove('tuck', SCREEN, LABELS)).toBeNull()
  })
})

describe('judgeScreen', () => {
  function deps(content: string) {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ choices: [{ message: { content } }] }),
    )
    const judge: JudgeDeps = {
      fetch: fetch as unknown as typeof globalThis.fetch,
      openrouterHeaders: { Authorization: 'Bearer test' },
      model: 'test-model',
    }
    return { fetch, judge }
  }

  const talk = [
    { role: 'user' as const, content: 'show me chocolate cake' },
    { role: 'assistant' as const, content: 'Here are a few.' },
    { role: 'user' as const, content: 'go back to Einstein, how old was he?' },
  ]

  it('asks about the cards and the conversation, and answers with a move', async () => {
    const { fetch, judge } = deps('{"about": "c1", "close": false}')
    const move = await judgeScreen(talk, SCREEN, judge, new AbortController().signal)
    expect(move).toEqual({ op: 'show', card: 'turn-1:call_0' })

    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body)) as {
      messages: Array<{ content: string }>
      max_tokens: number
    }
    expect(body.messages[1].content).toContain('c1: "Albert Einstein"')
    expect(body.messages[1].content).toContain('c2 is open in front of the user.')
    expect(body.messages[1].content).toContain('User: go back to Einstein, how old was he?')
    expect(body.max_tokens).toBeLessThanOrEqual(40)
  })

  it('makes no move from an answer it cannot read', async () => {
    const { judge } = deps('I think you should show the first card')
    expect(await judgeScreen(talk, SCREEN, judge, new AbortController().signal)).toBeNull()
  })

  it('never calls out without a key, and never throws', async () => {
    const { fetch, judge } = deps('{}')
    expect(await judgeScreen(talk, SCREEN, { ...judge, openrouterHeaders: null }, new AbortController().signal)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()

    const broken = vi.fn(async () => {
      throw new Error('network down')
    })
    expect(
      await judgeScreen(talk, SCREEN, { ...judge, fetch: broken as never }, new AbortController().signal),
    ).toBeNull()
  })
})
