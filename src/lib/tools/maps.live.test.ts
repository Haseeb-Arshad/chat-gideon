import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MapBlock } from '../cards/schema'
import { forgetMaps } from './maps'
import { runServerTool } from './registry'
import { EphemeralMemoryStore } from './memory'

/**
 * Maps against the live Mapbox and Open-Meteo, through the same call a
 * conversation makes, run on purpose with
 * `npx vitest run src/lib/tools/maps.live.test.ts --mode live`.
 *
 * Skipped in the ordinary suite, and without MAPBOX_PUBLIC_TOKEN. A place
 * costs three lookups and a route one more, well inside Mapbox's free tier. It
 * answers what fixtures cannot: whether each hard name still finds the pin it
 * did, or the question, when the services' rankings move.
 */

const live = import.meta.env.MODE === 'live'

/** A key from the environment, or from .env when the tests were started without it. */
function key(name: string): string {
  if (process.env[name]) return process.env[name]
  if (!existsSync('.env')) return ''
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((each) => each.startsWith(`${name}=`))
  return line ? line.slice(name.length + 1).trim() : ''
}

function report(row: Record<string, unknown>) {
  process.stdout.write(`LIVE ${JSON.stringify(row)}\n`)
}

const context = () => ({
  store: new EphemeralMemoryStore(),
  timezone: 'Europe/London',
  signal: new AbortController().signal,
  env: (name: string) => key(name) || undefined,
  location: { city: 'London', region: 'England', country: 'United Kingdom', latitude: 51.51, longitude: -0.13, timezone: 'Europe/London' },
})

/** Each name, and the country its pin should be in, or null when the right answer is a question. */
const PLACES: Array<[name: string, country: string | null]> = [
  ['Lisbon', 'Portugal'],
  ['Porto', 'Portugal'],
  ['Tuscany', 'Italy'],
  ['Georgia', 'Georgia'],
  ['Lake District', 'United Kingdom'],
  ['Machu Picchu', 'Peru'],
  ['Eiffel Tower', 'France'],
  ['Louvre', 'France'],
  ['Times Square', 'United States'],
  ['British Museum, London', 'United Kingdom'],
  ['Faisal Mosque', 'Pakistan'],
  ['Hunza Valley', 'Pakistan'],
  ['Springfield', null],
]

describe.skipIf(!live || !key('MAPBOX_PUBLIC_TOKEN'))('live maps', () => {
  it('finds each hard name the pin it means, or asks', { timeout: 120_000 }, async () => {
    forgetMaps()
    for (const [name, country] of PLACES) {
      const startedAt = Date.now()
      const outcome = await runServerTool('show_map', { mode: 'place', place: name }, context())
      const card = await outcome.card
      report({ name, ms: Date.now() - startedAt, ok: outcome.ok, content: outcome.content.split('\n')[0] })
      if (country === null) {
        expect(outcome.ok, name).toBe(false)
        expect(outcome.content, name).toContain('Ask the user which one')
        continue
      }
      expect(outcome.ok, name).toBe(true)
      expect(outcome.content.split(':')[0], name).toContain(country)
      const text = JSON.stringify(card)
      expect(text, name).toContain(key('MAPBOX_PUBLIC_TOKEN'))
      if (key('MAPBOX_SERVER_TOKEN')) expect(text.includes(key('MAPBOX_SERVER_TOKEN')), name).toBe(false)
    }
  })

  it('draws a route, and says when no road joins two places', { timeout: 60_000 }, async () => {
    const walk = await runServerTool('show_map', { mode: 'route', from: "King's Cross", to: 'British Museum', travel: 'walking' }, context())
    report({ route: 'walk', ok: walk.ok, content: walk.content.split('\n')[0] })
    expect(walk.ok).toBe(true)
    const card = await walk.card
    expect((card?.blocks.find((block) => block.type === 'map') as MapBlock).line?.length).toBeGreaterThan(5)
    expect(card?.blocks.some((block) => block.type === 'steps')).toBe(true)

    const fromHere = await runServerTool('show_map', { mode: 'route', to: 'Brighton' }, context())
    report({ route: 'from here', ok: fromHere.ok, content: fromHere.content.split('\n').slice(0, 2).join(' ') })
    expect(fromHere.content).toContain('starts from where the user')

    const ocean = await runServerTool('show_map', { mode: 'route', from: 'London', to: 'New York' }, context())
    report({ route: 'ocean', ok: ocean.ok, content: ocean.content.split('\n')[0] })
    expect(ocean.content).toContain('There is no way from London to New York')
  })
})
