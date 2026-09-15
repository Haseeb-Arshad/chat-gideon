import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamTurn, type ClientToolBridge } from './agent-core'
import type { CoarseLocation } from './location'
import type { ServerFrame } from './protocol'
import { describePosition } from './tools/client-tools'
import { forgetMaps } from './tools/maps'
import { forgetWeather } from './tools/weather'

/**
 * "What's the weather like here?" when the host could not tell where here is.
 * What is pinned: the server asks the browser, once, before the tool that
 * needs it; names the position by its town; tells the model the forecast is
 * for where the device placed them; and never asks during a guess at an
 * unfinished sentence, or where there is no browser to ask.
 */

const original = globalThis.fetch

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
  process.env.GIDEON_MEMORY_PATH = 'none'
  process.env.MAPBOX_PUBLIC_TOKEN = 'pk.eyJ1IjoidGVzdCIsImEiOiJ0ZXN0In0.dGVzdHNpZ25hdHVyZQ'
  forgetWeather()
  forgetMaps()
})

afterEach(() => {
  globalThis.fetch = original
  delete process.env.OPENROUTER_API_KEY
  delete process.env.MAPBOX_PUBLIC_TOKEN
})

const sse = (events: unknown[]) =>
  new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
const toolCall = (name: string, args: Record<string, unknown>) =>
  sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_0', function: { name, arguments: JSON.stringify(args) } }] } }] }])
const text = (words: string) => sse([{ choices: [{ delta: { content: words } }] }])

/** Open-Meteo's forecast, cut to an hour and a day. */
const forecast = {
  current: { time: '2026-09-15T22:00', temperature_2m: 26.2, apparent_temperature: 31, weather_code: 1, is_day: 0, wind_speed_10m: 6, relative_humidity_2m: 82 },
  hourly: { time: ['2026-09-15T22:00'], temperature_2m: [26.2], precipitation_probability: [0], weather_code: [1], is_day: [0] },
  daily: { time: ['2026-09-15'], weather_code: [1], temperature_2m_max: [33], temperature_2m_min: [23], precipitation_probability_max: [10], uv_index_max: [7], sunrise: ['2026-09-15T05:58'], sunset: ['2026-09-15T18:22'] },
}

/** Mapbox's reverse geocoder for 33.60, 73.05, as it answered on 15 September 2026. */
const reverse = {
  features: [
    { properties: { name: 'Suhdar', feature_type: 'locality', context: { region: { name: 'Punjab' }, country: { name: 'Pakistan' } } } },
    { properties: { name: 'Rawalpindi', feature_type: 'place', context: { region: { name: 'Punjab' }, country: { name: 'Pakistan' } } } },
  ],
}

function world() {
  const chats: Array<Record<string, unknown>> = []
  const replies = [toolCall('weather', {}), text('Mainly clear in Rawalpindi, 26 degrees.')]
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/search/geocode/v6/reverse')) return Response.json(reverse)
    if (url.includes('api.open-meteo.com')) return Response.json(forecast)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (body.stream === true) {
      chats.push(body)
      return replies.shift() ?? text('')
    }
    return Response.json({})
  }) as unknown as typeof fetch
  return chats
}

async function turn(options: { bridge?: ClientToolBridge | null; speculative?: boolean; onLocation?: (location: CoarseLocation) => void }) {
  const frames: ServerFrame[] = []
  for await (const frame of streamTurn('t1', [{ role: 'user', content: "What's the weather like here?" }], new AbortController().signal, { timezone: 'Asia/Karachi', ...options })) {
    frames.push(frame)
  }
  return frames
}

const systemText = (chat: Record<string, unknown>) =>
  (chat.messages as Array<{ role: string; content: string }>).filter((message) => message.role === 'system').map((message) => message.content).join('\n')

describe('where the user is, when the host could not tell', () => {
  it("asks the browser before the weather, names the place, and forecasts for it", async () => {
    const chats = world()
    const asked: string[] = []
    const bridge: ClientToolBridge = {
      call: async (_call, name) => {
        asked.push(name)
        return { ok: true, content: describePosition(33.6012, 73.0479) }
      },
    }
    const learned: CoarseLocation[] = []
    const frames = await turn({ bridge, onLocation: (location) => learned.push(location) })

    // The model was told the tools find the place, rather than to ask for it.
    expect(systemText(chats[0])).toContain('leave the place out and the tool asks their browser')
    expect(asked).toEqual(['get_location'])
    const request = frames.findIndex((frame) => frame.t === 'tool_request')
    const weather = frames.findIndex((frame) => frame.t === 'action' && frame.name === 'weather')
    expect(request).toBeGreaterThanOrEqual(0)
    expect(request).toBeLessThan(weather)
    expect(learned).toEqual([{ city: 'Rawalpindi', region: 'Punjab', country: 'Pakistan', latitude: 33.6, longitude: 73.05, timezone: 'Asia/Karachi', from: 'device' }])

    const told = (chats[1].messages as Array<{ role: string; content: string }>).find((message) => message.role === 'tool')?.content ?? ''
    expect(told).toContain("No place was given, so this is for where the user's device places them: Rawalpindi, Punjab, Pakistan.")
    const card = frames.find((frame): frame is Extract<ServerFrame, { t: 'card' }> => frame.t === 'card')?.card
    expect(card).toMatchObject({ recipe: 'weather', title: 'Weather, Rawalpindi' })
    expect(card?.blocks.some((block) => block.type === 'map')).toBe(true)
  })

  it('asks nothing when the session already knows, and says it plainly when there is no browser to ask', async () => {
    const chats = world()
    const bridge = { call: vi.fn() }
    const known: CoarseLocation = { city: 'Rawalpindi', region: 'Punjab', country: 'Pakistan', latitude: 33.6, longitude: 73.05, timezone: 'Asia/Karachi', from: 'device' }
    for await (const _frame of streamTurn('t1', [{ role: 'user', content: 'weather here?' }], new AbortController().signal, { bridge, location: known })) void _frame
    expect(bridge.call).not.toHaveBeenCalled()
    expect(systemText(chats[0])).toContain("The user's device places them in Rawalpindi, Punjab, Pakistan. It is for questions about where they are")

    const again = world()
    const frames = await turn({ bridge: null })
    expect(frames.some((frame) => frame.t === 'tool_request')).toBe(false)
    const told = (again[1].messages as Array<{ role: string; content: string }>).find((message) => message.role === 'tool')?.content ?? ''
    expect(told).toContain('where the user is could not be found')
  })

  it('never asks during a guess at an unfinished sentence', async () => {
    world()
    const bridge = { call: vi.fn() }
    const frames = await turn({ bridge, speculative: true })
    expect(bridge.call).not.toHaveBeenCalled()
    expect(frames.at(-1)).toMatchObject({ t: 'error', code: 'speculation_needs_tools' })
  })
})
