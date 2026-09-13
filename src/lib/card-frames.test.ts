import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardPatch } from './cards/patch'
import type { CardV2 } from './cards/schema'
import type { ServerFrame } from './protocol'
import type { ToolOutcome } from './tools/registry'

/**
 * A card that grows after the reply has finished: the loop keeps sending, in
 * order, each piece the moment it is ready, rather than holding every piece
 * until the slowest one is done or dropping whatever came after `done`.
 *
 * The tool is replaced here so the timing of the card and its patches is in
 * the test's hands, step by step, with no clock involved.
 */

const toolOutcome = vi.hoisted(() => ({ current: null as null | (() => ToolOutcome) }))

vi.mock('./tools/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/registry')>()
  return {
    ...actual,
    runServerTool: vi.fn(async () => toolOutcome.current!()),
  }
})

const { streamTurn } = await import('./agent-core')

const original = globalThis.fetch

function sse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
  process.env.GIDEON_MEMORY_PATH = 'none'
  const chat = [
    sse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_0', function: { name: 'show_images', arguments: '{"query":"curie"}' } },
              ],
            },
          },
        ],
      },
    ]),
    sse([{ choices: [{ delta: { content: 'Here she is.' } }] }]),
  ]
  globalThis.fetch = vi.fn(async () => chat.shift() ?? Response.json({}, { status: 500 })) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = original
  toolOutcome.current = null
  delete process.env.OPENROUTER_API_KEY
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const CARD: CardV2 = {
  schema: 2,
  recipe: 'profile',
  size: 'standard',
  query: 'curie',
  title: 'Marie Curie',
  blocks: [{ id: 'headline', slot: 'body', type: 'headline', title: 'Marie Curie' }],
  sources: [],
  asOf: null,
  partial: true,
}

const SUMMARY: CardPatch = {
  blocks: [{ id: 'summary', slot: 'body', type: 'prose', paragraphs: ['A physicist and chemist.'] }],
  drop: [],
  partial: true,
}
const FINAL: CardPatch = { blocks: [], drop: [], partial: false }

async function next(turn: AsyncGenerator<ServerFrame>) {
  const { value, done } = await turn.next()
  return done ? null : value
}

async function until(turn: AsyncGenerator<ServerFrame>, t: ServerFrame['t']) {
  for (let frame = await next(turn); frame; frame = await next(turn)) {
    if (frame.t === t) return frame
  }
  return null
}

describe('a card growing after the reply', () => {
  it('sends the card, then each patch as it comes, after done', async () => {
    const card = deferred<CardV2 | null>()
    const summary = deferred<void>()
    toolOutcome.current = () => ({
      ok: true,
      content: 'A picture of her is on screen.',
      card: card.promise,
      cardPatches: (async function* () {
        await summary.promise
        yield SUMMARY
        yield FINAL
      })(),
    })

    const turn = streamTurn('t1', [{ role: 'user', content: 'show me marie curie' }], new AbortController().signal)
    expect(await until(turn, 'done')).toMatchObject({ t: 'done', text: expect.stringContaining('Here she is.') })

    // The reply is over; the card is not, and the loop is still waiting for it.
    card.resolve(CARD)
    expect(await next(turn)).toEqual({ t: 'card', id: 't1', call: 'call_0', card: CARD })

    summary.resolve()
    expect(await next(turn)).toEqual({ t: 'card_patch', id: 't1', call: 'call_0', ...SUMMARY })
    expect(await next(turn)).toEqual({ t: 'card_patch', id: 't1', call: 'call_0', ...FINAL })
    expect(await next(turn)).toBeNull()
  })

  it('sends no patches for a card that turned out to be none', async () => {
    const patches = vi.fn()
    toolOutcome.current = () => ({
      ok: true,
      content: 'Nothing worth showing.',
      card: Promise.resolve(null),
      cardPatches: (async function* () {
        patches()
        yield FINAL
      })(),
    })

    const frames: ServerFrame[] = []
    for await (const frame of streamTurn('t1', [{ role: 'user', content: 'show me' }], new AbortController().signal)) {
      frames.push(frame)
    }
    expect(frames).toContainEqual({ t: 'card', id: 't1', call: 'call_0', card: null })
    expect(frames.some((frame) => frame.t === 'card_patch')).toBe(false)
    expect(patches).not.toHaveBeenCalled()
  })

  it('stops sending when the turn is cancelled', async () => {
    const controller = new AbortController()
    const card = deferred<CardV2 | null>()
    toolOutcome.current = () => ({ ok: true, content: 'On screen.', card: card.promise })

    const turn = streamTurn('t1', [{ role: 'user', content: 'show me marie curie' }], controller.signal)
    await until(turn, 'done')
    controller.abort()
    card.resolve(CARD)
    expect(await next(turn)).toBeNull()
  })
})
