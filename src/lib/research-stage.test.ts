import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamTurn } from './agent-core'
import type { ServerFrame } from './protocol'
import { forgetCards } from './tools/card-builder'

/**
 * The research stage from the agent loop's side: what the searching pane is
 * told while the desk works, the card that follows the answer, and the model's
 * way of taking it all down again.
 */

const original = globalThis.fetch

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
  process.env.GIDEON_MEMORY_PATH = 'none'
  process.env.EXA_API_KEY = 'exa-test'
  forgetCards()
})

afterEach(() => {
  globalThis.fetch = original
  delete process.env.OPENROUTER_API_KEY
  delete process.env.EXA_API_KEY
})

function sse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const toolCallStream = (name: string, args: Record<string, unknown>) =>
  sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_0', function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    },
  ])
const textStream = (text: string) => sse([{ choices: [{ delta: { content: text } }] }])

const BRIEF =
  'Albert Einstein was a theoretical physicist, born 14 March 1879 in Ulm, who died 18 April 1955.\nSources: Albert Einstein | Britannica https://www.britannica.com/biography/Albert-Einstein'

const researcher = () => [
  {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'r0',
              type: 'function',
              function: { name: 'search', arguments: JSON.stringify({ query: 'Albert Einstein' }) },
            },
          ],
        },
      },
    ],
  },
  { choices: [{ message: { content: BRIEF } }] },
]

const EINSTEIN_CARD = {
  kind: 'entity',
  title: 'Albert Einstein',
  subtitle: 'Theoretical physicist',
  summary: 'A theoretical physicist born in Ulm.',
  facts: [
    { label: 'Born', value: '14 March 1879, Ulm' },
    { label: 'Died', value: '18 April 1955' },
  ],
  subject: 'Albert Einstein',
}

/** The conversational model streams, the desk and the card builder answer whole. */
function world(chat: Response[], card: unknown = EINSTEIN_CARD) {
  const desk = researcher()
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.includes('api.exa.ai')) {
      return Response.json({
        results: [
          {
            title: 'Albert Einstein | Britannica',
            url: 'https://www.britannica.com/biography/Albert-Einstein',
            highlights: ['Einstein, born 14 March 1879 in Ulm, died 18 April 1955.'],
          },
        ],
      })
    }
    if (url.includes('wikipedia.org')) {
      return Response.json({
        query: {
          pages: [
            {
              title: 'Albert Einstein',
              thumbnail: { source: 'https://upload.wikimedia.org/einstein.jpg', width: 800, height: 1000 },
            },
          ],
        },
      })
    }
    if (body.stream === true) return chat.shift() ?? Response.json({}, { status: 500 })
    if (body.response_format) {
      return Response.json({ choices: [{ message: { content: JSON.stringify(card) } }] })
    }
    return Response.json(desk.shift() ?? {})
  }) as unknown as typeof fetch
}

async function collect(question: string, speculative = false) {
  const frames: ServerFrame[] = []
  for await (const frame of streamTurn(
    't1',
    [{ role: 'user', content: question }],
    new AbortController().signal,
    { speculative, timezone: 'UTC' },
  )) {
    frames.push(frame)
  }
  return frames
}

describe('the research stage', () => {
  it('tells the searching pane what is being asked, then sends the card', async () => {
    world([
      toolCallStream('research', { question: 'Who was Albert Einstein?' }),
      textStream('He was a physicist, born in Ulm.'),
    ])
    const frames = await collect('who was einstein')

    const pending = frames.find((frame) => frame.t === 'action' && frame.pending)
    expect(pending).toMatchObject({ detail: 'Who was Albert Einstein?' })

    const card = frames.find((frame) => frame.t === 'card')
    expect(card).toMatchObject({
      t: 'card',
      id: 't1',
      call: 'call_0',
      card: {
        kind: 'entity',
        title: 'Albert Einstein',
        query: 'Who was Albert Einstein?',
        image: { url: 'https://upload.wikimedia.org/einstein.jpg' },
      },
    })
    // The card follows the search it came from, and the reply still finishes.
    expect(frames.indexOf(card!)).toBeGreaterThan(frames.indexOf(pending!))
    expect(frames.some((frame) => frame.t === 'done')).toBe(true)
  })

  it('sends no card when the builder declines to draw one', async () => {
    world(
      [toolCallStream('research', { question: 'Was Einstein born in Ulm?' }), textStream('Yes, in Ulm.')],
      { show: false },
    )
    const frames = await collect('was einstein born in ulm')
    // Said outright, so the searching pane can go at once.
    expect(frames).toContainEqual({ t: 'card', id: 't1', call: 'call_0', card: null })
    expect(frames.some((frame) => frame.t === 'done')).toBe(true)
  })

  it('clears the stage when the model is asked to', async () => {
    world([toolCallStream('clear_screen', {}), textStream('All clear.')])
    const frames = await collect("that's all, thanks")
    expect(frames).toContainEqual({ t: 'stage', id: 't1', op: 'clear' })
    expect(frames.at(-1)).toMatchObject({ t: 'done', text: 'All clear.' })
  })

  it('does not let a guess clear the screen', async () => {
    world([toolCallStream('clear_screen', {}), textStream('All clear.')])
    const frames = await collect("that's all", true)
    expect(frames.some((frame) => frame.t === 'stage')).toBe(false)
    expect(frames.at(-1)).toMatchObject({ t: 'error', code: 'speculation_needs_tools' })
  })
})
