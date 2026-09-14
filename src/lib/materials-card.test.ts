import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamTurn } from './agent-core'
import type { ServerFrame } from './protocol'
import { forgetCards } from './tools/card-builder'
import { forgetWikidata } from './tools/desk/wikidata'
import { forgetWorldBank } from './tools/desk/world-bank'

/**
 * A question whose research looked figures up, through the whole turn: the
 * card drawn from those figures goes out as soon as the brief is ready, the
 * model-written card adds its sentence as a patch after it, and the speaking
 * model is told what is on the screen beside it.
 */

const original = globalThis.fetch

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
  process.env.GIDEON_MEMORY_PATH = 'none'
  process.env.EXA_API_KEY = 'exa-test'
  forgetCards()
  forgetWorldBank()
  forgetWikidata()
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

const toolCall = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

const BRIEF =
  "Japan's population peaked at 128,070,000 in 2010 and was 123,366,734 in 2025, according to the World Bank.\nSources: World Bank: Population https://data.worldbank.org/indicator/SP.POP.TOTL?locations=JP"

function world() {
  const chat = [
    sse([{ choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall('call_0', 'research', { question: 'How has the population of Japan changed?' }) }] } }] }]),
    sse([{ choices: [{ delta: { content: 'It peaked in 2010 and has been falling since.' } }] }]),
  ]
  const desk = [
    { choices: [{ message: { content: null, tool_calls: [toolCall('r0', 'search', { query: 'Japan population' }), toolCall('r1', 'country_data', { countries: ['JPN'], indicator: 'population' })] } }] },
    { choices: [{ message: { content: BRIEF } }] },
  ]
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url, body })
    if (url.includes('api.exa.ai/search')) {
      return Response.json({ results: [{ title: 'Japan population', url: 'https://example.org/japan', highlights: ['Falling since 2010.'] }] })
    }
    if (url.includes('api.exa.ai')) return Response.json({ error: 'down' }, { status: 500 })
    if (url.includes('api.worldbank.org')) {
      return Response.json([
        { page: 1, pages: 1, per_page: 1000, total: 3 },
        [
          { country: { id: 'JP', value: 'Japan' }, countryiso3code: 'JPN', date: '1960', value: 93216000 },
          { country: { id: 'JP', value: 'Japan' }, countryiso3code: 'JPN', date: '2010', value: 128070000 },
          { country: { id: 'JP', value: 'Japan' }, countryiso3code: 'JPN', date: '2025', value: 123366734 },
        ],
      ])
    }
    if (body.stream === true) return chat.shift() ?? Response.json({}, { status: 500 })
    if (body.response_format) {
      // The model-written card, drawn from the brief.
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                show: true,
                kind: 'figure',
                title: 'Population of Japan',
                subtitle: '',
                summary: "Japan's population peaked in 2010 and was 123,366,734 in 2025.",
                figure: { value: '123,366,734', label: 'Population in 2025' },
                facts: [{ label: 'Peak', value: '128,070,000 in 2010' }],
              }),
            },
          },
        ],
      })
    }
    return Response.json(desk.shift() ?? {})
  }) as unknown as typeof fetch
  return calls
}

describe('a card from figures', () => {
  it('goes out when the brief is ready, and grows by the written sentence after it', async () => {
    const calls = world()
    const frames: ServerFrame[] = []
    for await (const frame of streamTurn('t1', [{ role: 'user', content: 'how has the population of japan changed' }], new AbortController().signal, { timezone: 'UTC' })) {
      frames.push(frame)
    }

    const card = frames.find((frame) => frame.t === 'card')
    expect(card?.t === 'card' && card.card).toMatchObject({ recipe: 'trend', size: 'wide', title: 'Population, Japan' })
    const blocks = card?.t === 'card' ? (card.card?.blocks ?? []) : []
    expect(blocks.map((block) => block.type)).toEqual(['headline', 'stat', 'chart'])
    expect(blocks.find((block) => block.type === 'stat')).toMatchObject({ value: '123.4 million', label: 'In 2025' })

    const patch = frames.find((frame) => frame.t === 'card_patch')
    expect(patch).toBeDefined()
    expect(frames.indexOf(patch!)).toBeGreaterThan(frames.indexOf(card!))
    if (patch?.t !== 'card_patch') return
    expect(patch.partial).toBe(false)
    // The sentence and the fact the figures did not already say; not a second figure.
    expect(patch.blocks.map((block) => block.type)).toEqual(['prose', 'facts'])
    expect(patch.blocks[0]).toMatchObject({ slot: 'summary', paragraphs: ["Japan's population peaked in 2010 and was 123,366,734 in 2025."] })

    // The speaking model is told what is showing, so it refers to the chart rather than reading it.
    const answering = calls.filter((call) => call.body.stream === true)[1]
    const tool = (answering.body.messages as Array<{ role: string; content: string }>).find((message) => message.role === 'tool')
    expect(tool?.content).toContain("On the user's screen now: a chart of population for Japan, 1960 to 2025.")
  })
})
