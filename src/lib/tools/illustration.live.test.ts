import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runServerTool } from './registry'
import { EphemeralMemoryStore } from './memory'
import { readCard } from '../cards/read'
import { illustrationDocument } from '../illustrations/document'

/** Deliberate live generation, never part of the offline suite. No personal input. */
describe.skipIf(import.meta.env.MODE !== 'live')('live illustration', () => {
  it('produces a complete interactive Anatomy figure through the registered server tool', { timeout: 180_000 }, async () => {
    process.loadEnvFile('.env')
    expect(process.env.OPENROUTER_API_KEY, 'provider key configured').toBeTruthy()
    const outcome = await runServerTool('draw_illustration', { request: 'Draw an interactive isometric spring balance on warm paper. Slider labelled Load from 0 to 10 N, a dial and a visible spring stretching. Illustrative spring constant 100 N/m; readout extension in cm calculated from Hooke law. Reset button. Keep the object grounded on a bench with screws and feet. No autoplay; arrow keys on slider must work. Label this a simplified illustrative model.' }, { store: new EphemeralMemoryStore(), env: name => process.env[name], timezone: 'Asia/Karachi', signal: new AbortController().signal, audit: { record: (type: string, payload: unknown) => { if (type === 'illustration_provider') console.log(JSON.stringify({ type, payload })) } } as never })
    expect(outcome.ok, outcome.content).toBe(true)
    const card = await outcome.card
    mkdirSync('output/illustrations', { recursive: true })
    writeFileSync('output/illustrations/live-card.json', JSON.stringify(card, null, 2))
    expect(readCard(card)).toEqual(card)
    const block = card?.blocks[0]
    expect(block?.type).toBe('illustration')
    if (block?.type !== 'illustration') throw new Error('Missing drawing')
    expect(block.html).toMatch(/type=["']range["']/)
    expect(block.html).toContain('<script')
    writeFileSync('output/illustrations/live-drawing.html', illustrationDocument(block.html, block.title))
    console.log(JSON.stringify({ liveGeneration: true, title: card!.title, characters: block.html.length, artifact: 'output/illustrations/live-drawing.html' }))
  })
})
