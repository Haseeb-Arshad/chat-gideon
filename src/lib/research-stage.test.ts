import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PICTURE_FILLERS, streamTurn } from './agent-core'
import type { ServerFrame } from './protocol'
import type { ScreenState } from './stage-judge'
import { forgetCards } from './tools/card-builder'

/**
 * The research stage from the agent loop's side: what the searching pane is
 * told while the desk works, the card that follows the answer, the pictures
 * that go up when they are asked for, and the screen stepping aside when the
 * talk moves on or coming back when it returns.
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

const CAKE_PHOTOS = [
  {
    title: 'Chocolate cake photo – Free image on Unsplash',
    url: 'https://unsplash.com/photos/cake-1',
    image: 'https://images.unsplash.com/photo-111?mark=https%3A%2F%2Fimages.unsplash.com%2Fopengraph%2Flogo.png',
    extras: { imageLinks: ['https://images.unsplash.com/photo-112?w=400'] },
  },
  {
    title: 'Close-up of a chocolate cake · Free Stock Photo',
    url: 'https://www.pexels.com/photo/222/',
    image: 'https://images.pexels.com/photos/222/pexels-photo-222.jpeg?h=627',
  },
  {
    title: 'Chocolate cake stock photos',
    url: 'https://www.istockphoto.com/photos/chocolate-cake',
    image: 'https://www.istockphoto.com/components/IStockLogoDesktop.svg',
  },
  {
    title: 'The best chocolate cake',
    url: 'https://www.seriouseats.com/chocolate-cake',
    image: 'https://www.seriouseats.com/thmb/cake.jpg',
  },
]

interface World {
  chat: Response[]
  card?: unknown
  /** What the screen judge answers. */
  judge?: unknown
}

type Call = { url: string; body: Record<string, unknown> }

/**
 * A small web: the conversational model streams, and the research desk, the
 * card builder, the screen judge, Exa, Openverse and Wikipedia answer whole.
 */
function world({ chat, card = EINSTEIN_CARD, judge = { about: 'c1', close: false } }: World) {
  const desk = researcher()
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url, body })
    if (url.includes('api.exa.ai')) {
      if ((body.contents as { extras?: unknown } | undefined)?.extras) {
        return Response.json({ results: CAKE_PHOTOS })
      }
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
    if (url.includes('openverse')) return Response.json({ results: [] })
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
    const system = String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? '')
    if (system.includes('keep the screen')) {
      return Response.json({ choices: [{ message: { content: JSON.stringify(judge) } }] })
    }
    if (body.response_format) {
      return Response.json({ choices: [{ message: { content: JSON.stringify(card) } }] })
    }
    return Response.json(desk.shift() ?? {})
  }) as unknown as typeof fetch
  return calls
}

async function collect(question: string, options: { speculative?: boolean; screen?: ScreenState } = {}) {
  const frames: ServerFrame[] = []
  for await (const frame of streamTurn(
    't1',
    [{ role: 'user', content: question }],
    new AbortController().signal,
    { speculative: options.speculative ?? false, timezone: 'UTC', screen: options.screen ?? null },
  )) {
    frames.push(frame)
  }
  return frames
}

const judged = (calls: Call[]) =>
  calls.filter((call) =>
    String((call.body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? '').includes(
      'keep the screen',
    ),
  )

/** Einstein's card, open in front of the user. */
const EINSTEIN_OPEN: ScreenState = {
  open: true,
  front: 't0:call_0',
  cards: [{ id: 't0:call_0', title: 'Albert Einstein', query: 'Who was Albert Einstein?', kind: 'entity' }],
}

describe('cards from research', () => {
  it('tells the searching pane what is being asked, then sends the card', async () => {
    world({
      chat: [
        toolCallStream('research', { question: 'Who was Albert Einstein?' }),
        textStream('He was a physicist, born in Ulm.'),
      ],
    })
    const frames = await collect('who was einstein')

    const pending = frames.find((frame) => frame.t === 'action' && frame.pending)
    expect(pending).toMatchObject({ detail: 'Who was Albert Einstein?' })
    // The result carries the question too, so the resources list can be headed by it.
    const result = frames.find((frame) => frame.t === 'action' && !frame.pending)
    expect(result).toMatchObject({ detail: 'Who was Albert Einstein?', summary: '1 search' })

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
    expect(frames.indexOf(card!)).toBeGreaterThan(frames.indexOf(pending!))
    expect(frames.some((frame) => frame.t === 'done')).toBe(true)
  })

  it('says outright when the builder declines to draw a card', async () => {
    world({
      chat: [toolCallStream('research', { question: 'Was Einstein born in Ulm?' }), textStream('Yes, in Ulm.')],
      card: { show: false },
    })
    const frames = await collect('was einstein born in ulm')
    expect(frames).toContainEqual({ t: 'card', id: 't1', call: 'call_0', card: null })
    expect(frames.some((frame) => frame.t === 'done')).toBe(true)
  })
})

describe('pictures', () => {
  it('puts a gallery on screen and has one line said about it', async () => {
    const calls = world({
      chat: [toolCallStream('show_images', { query: 'chocolate cake' }), textStream('Here are a few.')],
    })
    const frames = await collect('show me some cake pictures')

    const pending = frames.find((frame) => frame.t === 'action' && frame.pending)
    expect(pending).toMatchObject({ name: 'show_images', summary: 'Finding pictures…', detail: 'chocolate cake' })
    const said = frames.flatMap((frame) => (frame.t === 'delta' ? [frame.text] : []))
    expect(PICTURE_FILLERS).toContain(said[0])

    const card = frames.find((frame) => frame.t === 'card')
    expect(card).toMatchObject({ card: { kind: 'gallery', title: 'Chocolate cake' } })
    const pictures = card?.t === 'card' ? (card.card?.pictures ?? []) : []
    // The stock library's logo never gets in; the rest do, leads first.
    expect(pictures.map((picture) => picture.host)).toEqual([
      'unsplash.com',
      'pexels.com',
      'seriouseats.com',
      'unsplash.com',
    ])

    // The speaking model is told what is showing, and asked for one line.
    const answerRound = calls.filter((call) => call.body.stream === true)[1]
    const tool = (answerRound.body.messages as Array<{ role: string; content: string }>).find(
      (message) => message.role === 'tool',
    )
    expect(tool?.content).toContain('4 pictures of chocolate cake')
  })
})

describe('keeping the screen in step with the talk', () => {
  it('steps the cards aside when the conversation moves on', async () => {
    const calls = world({ chat: [textStream('Pizza is a good choice.')], judge: { about: null, close: false } })
    const frames = await collect("let's talk about pizza instead", { screen: EINSTEIN_OPEN })

    expect(frames).toContainEqual({ t: 'stage', id: 't1', op: 'tuck' })
    // The speaking model is told what is on the screen beside it.
    const chat = calls.find((call) => call.body.stream === true)!
    const system = (chat.body.messages as Array<{ role: string; content: string }>).filter(
      (message) => message.role === 'system',
    )
    expect(system.some((message) => message.content.includes('"Albert Einstein"'))).toBe(true)
  })

  it('brings a card back when its topic returns', async () => {
    world({ chat: [textStream('He was 76.')], judge: { about: 'c1', close: false } })
    const frames = await collect('how old was Einstein when he died', {
      screen: { ...EINSTEIN_OPEN, open: false, front: null },
    })
    expect(frames).toContainEqual({ t: 'stage', id: 't1', op: 'show', card: 't0:call_0' })
  })

  it('leaves the screen to a turn that puts something new on it', async () => {
    world({
      chat: [
        toolCallStream('research', { question: 'Who was Marie Curie?' }),
        textStream('She was a chemist and physicist.'),
      ],
      judge: { about: null, close: false },
    })
    const frames = await collect('who was marie curie', { screen: EINSTEIN_OPEN })
    expect(frames.some((frame) => frame.t === 'stage')).toBe(false)
    expect(frames.some((frame) => frame.t === 'card')).toBe(true)
  })

  it('asks nothing when there is nothing on screen', async () => {
    const calls = world({ chat: [textStream('Hello.')], judge: { about: null, close: false } })
    const frames = await collect('hello')
    expect(judged(calls)).toHaveLength(0)
    expect(frames.some((frame) => frame.t === 'stage')).toBe(false)
  })
})
