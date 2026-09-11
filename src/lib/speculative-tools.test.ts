import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESEARCH_FILLERS, streamTurn } from './agent-core'
import type { ServerFrame } from './protocol'

/**
 * What a turn may do before anyone knows it is the right one, and what the
 * whole research path looks like from the agent loop.
 *
 * A guess at an unfinished sentence must be unobservable if wrong. Storing a
 * memory is observable, so a guess that reaches for `remember` is dropped
 * unexecuted. Reading the clock, or researching, leaves no trace, so a guess
 * may do those — and for research that is the whole point: the slow part of
 * the turn starts before the sentence has finished.
 */

const original = globalThis.fetch

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
  process.env.GIDEON_MEMORY_PATH = 'none'
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

function toolCallEvent(name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_0', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  }
}

const textEvent = (text: string) => ({ choices: [{ delta: { content: text } }] })
const toolCallStream = (name: string, args: Record<string, unknown>) => sse([toolCallEvent(name, args)])
const textStream = (text: string) => sse([textEvent(text)])

async function collect(question: string, speculative: boolean) {
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

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> }

/**
 * A small web for the research path: the conversational model streams, the
 * research model answers in one piece, and Exa returns a fixed page.
 */
function world(chat: Response[], researcher: unknown[]) {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> })
    if (url.includes('api.exa.ai')) {
      return Response.json({
        results: [
          {
            title: 'Met Office: London',
            url: 'https://weather.example.org/london',
            publishedDate: '2026-09-10T06:00:00.000Z',
            highlights: ['London today: light rain, high of 17C.'],
          },
        ],
      })
    }
    if (body.stream === true) return chat.shift() ?? Response.json({}, { status: 500 })
    return Response.json(researcher.shift() ?? {}, { status: researcher.length >= 0 ? 200 : 500 })
  }) as unknown as typeof fetch
  return calls
}

function researcherTurns(query: string) {
  return [
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'r0', type: 'function', function: { name: 'search', arguments: JSON.stringify({ query }) } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          message: {
            content:
              'Light rain in London today, high of 17C.\nSources: Met Office: London https://weather.example.org/london',
          },
        },
      ],
    },
  ]
}

const deltas = (frames: ServerFrame[]) =>
  frames.flatMap((frame) => (frame.t === 'delta' ? [frame.text] : []))

describe('speculative turns and tools', () => {
  it('runs a read-only tool and finishes the guess', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallStream('get_time', {}))
      .mockResolvedValueOnce(textStream('It is just past noon.'))
    globalThis.fetch = fetch as unknown as typeof fetch

    const frames = await collect('what time is it', true)
    expect(frames.some((frame) => frame.t === 'error')).toBe(false)
    expect(frames.at(-1)).toMatchObject({ t: 'done', text: 'It is just past noon.' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('drops the guess unexecuted when it reaches for a tool that leaves a trace', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallStream('remember', { text: 'The user likes tea.' }))
      .mockResolvedValueOnce(textStream('Noted.'))
    globalThis.fetch = fetch as unknown as typeof fetch

    const frames = await collect('remember that I like tea', true)
    expect(frames.at(-1)).toMatchObject({ t: 'error', code: 'speculation_needs_tools' })
    // One round only: the tool was never run and the model was never asked again.
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('lets a real turn do the same work', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallStream('remember', { text: 'The user likes tea.' }))
      .mockResolvedValueOnce(textStream('Noted.'))
    globalThis.fetch = fetch as unknown as typeof fetch

    const frames = await collect('remember that I like tea', false)
    expect(frames.some((frame) => frame.t === 'action' && frame.name === 'remember')).toBe(true)
    expect(frames.at(-1)).toMatchObject({ t: 'done', text: 'Noted.' })
  })
})

describe('research through the agent loop', () => {
  it('researches inside a guess, filling the silence and citing its sources', async () => {
    process.env.EXA_API_KEY = 'exa-test'
    const calls = world(
      [
        toolCallStream('research', { question: 'What is the weather in London today?' }),
        textStream('Light rain, and a high of seventeen.'),
      ],
      researcherTurns('London weather today'),
    )

    const frames = await collect("what's the weather in London today", true)
    const said = deltas(frames)

    // Something is said the moment research starts, before any answer exists.
    expect(RESEARCH_FILLERS).toContain(said[0])
    const pending = frames.find((frame) => frame.t === 'action' && frame.pending)
    expect(pending).toMatchObject({ name: 'research', summary: 'Looking that up…' })
    const final = frames.find((frame) => frame.t === 'action' && !frame.pending)
    expect(final).toMatchObject({
      name: 'research',
      ok: true,
      links: [
        {
          title: 'Met Office: London',
          url: 'https://weather.example.org/london',
          publishedDate: '2026-09-10',
        },
      ],
    })
    // Not necessarily the last frame: the card drawn from the brief may follow it.
    expect(frames.find((frame) => frame.t === 'done')).toMatchObject({
      t: 'done',
      text: `${said[0]} Light rain, and a high of seventeen.`,
    })

    // The speaking model heard the brief, and knows it already said the filler.
    const answerRound = calls.filter((call) => call.body.stream === true)[1]
    const messages = answerRound.body.messages as Array<{ role: string; content: string }>
    expect(messages.find((message) => message.role === 'tool')?.content).toContain('high of 17C')
    expect(messages.filter((message) => message.role === 'assistant').at(-1)?.content).toBe(said[0])

    // Exa was asked by the research model, with the key, not by the speaking model.
    const exa = calls.filter((call) => call.url.includes('api.exa.ai'))
    expect(exa).toHaveLength(1)
    expect(exa[0].headers['x-api-key']).toBe('exa-test')
  })

  it('adds no holding line when the model already said something', async () => {
    process.env.EXA_API_KEY = 'exa-test'
    world(
      [
        sse([
          textEvent('Checking the forecast.'),
          toolCallEvent('research', { question: 'What is the weather in Paris today?' }),
        ]),
        textStream('Sunny, twenty-two.'),
      ],
      researcherTurns('Paris weather today'),
    )

    const frames = await collect('weather in Paris today', false)
    expect(deltas(frames).some((text) => RESEARCH_FILLERS.includes(text))).toBe(false)
    // The two rounds read as one reply, not "forecast.Sunny".
    expect(frames.find((frame) => frame.t === 'done')).toMatchObject({
      t: 'done',
      text: 'Checking the forecast. Sunny, twenty-two.',
    })
  })

  it('does not offer research at all without a key behind it', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(textStream('Hello.'))
    globalThis.fetch = fetch as unknown as typeof fetch

    await collect('hello there', false)
    const body = JSON.parse(String(fetch.mock.calls[0][1].body)) as {
      tools: Array<{ function: { name: string } }>
    }
    const offered = body.tools.map((tool) => tool.function.name)
    expect(offered).toContain('get_time')
    expect(offered).not.toContain('research')
  })
})
