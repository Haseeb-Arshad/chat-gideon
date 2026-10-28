import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateIllustration, runIllustration } from './illustration'
import { readCard } from '../cards/read'
import { digestOf } from '../cards/digest'
import { EphemeralMemoryStore } from './memory'
import { illustrationDocument } from '../illustrations/document'
import { MAX_ILLUSTRATION_HTML, readIllustrationHtml } from '../illustrations/validation'
import { availableTools, streamTurn } from '../agent-core'
import type { ServerFrame } from '../protocol'

const drawing = { title: 'Spring balance', summary: 'An illustrative spring stretches with load. Values are a conceptual model.', html: '<main><svg viewBox="0 0 600 380" role="img" aria-label="Spring balance"><circle cx="100" cy="100" r="30" /></svg><button>Reset</button></main>' }
const response = (value: unknown, reason = 'stop') => Response.json({ choices: [{ finish_reason: reason, message: { content: JSON.stringify(value) } }] })
/** A streamed completion, cut into the given number of pieces. */
const sse =(value: unknown, pieces = 6, reason = 'stop') => {
  const text = JSON.stringify(value)
  const size = Math.ceil(text.length / pieces)
  const events = Array.from({ length: pieces }, (_, index) => `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(index * size, (index + 1) * size) } }] })}\n\n`)
  events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`)
  return new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(event)); controller.close() } }))
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('drawing generation', () => {
  it('accepts a provider JSON envelope wrapped in a code fence', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(drawing) + '\n```' } }] }))
    expect(await generateIllustration('Draw a balance', { fetch: fetcher, openrouterHeaders: {}, model: 'test' }, new AbortController().signal)).toMatchObject({ recipe: 'illustration' })
  })
  it('releases pending, completed and card frames through the shared turn engine', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test')
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
    let rounds = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.response_format) return body.stream ? sse(drawing) : response(drawing)
      const delta = rounds++ === 0 ? { tool_calls: [{ index: 0, id: 'draw-call', function: { name: 'draw_illustration', arguments: JSON.stringify({ request: 'Draw a spring balance' }) } }] } : { content: 'Try the load slider.' }
      return new Response(event({ choices: [{ delta }] }) + 'data: [DONE]\n\n')
    }))
    expect(availableTools()).toContain('draw_illustration')
    const frames: ServerFrame[] = []
    for await (const frame of streamTurn('drawing-turn', [{ role: 'user', content: 'Draw a spring balance' }], new AbortController().signal, { memoryStore: new EphemeralMemoryStore(), timezone: 'UTC' })) frames.push(frame)
    expect(frames).toContainEqual(expect.objectContaining({ t: 'action', name: 'draw_illustration', pending: true, detail: 'Draw a spring balance' }))
    expect(frames).toContainEqual(expect.objectContaining({ t: 'action', name: 'draw_illustration', ok: true, summary: 'Drawing prepared' }))
    expect(frames).toContainEqual(expect.objectContaining({ t: 'card', call: 'draw-call', card: expect.objectContaining({ recipe: 'illustration' }) }))
    expect(frames).toContainEqual(expect.objectContaining({ t: 'done' }))
  })
  it('returns a wire-readable drawing with a digest that never exposes executable code', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(drawing))
    const card = await generateIllustration('Draw a spring balance', { fetch: fetcher, openrouterHeaders: { Authorization: 'test' }, model: 'test/model' }, new AbortController().signal)
    expect(card).toMatchObject({ recipe: 'illustration', size: 'feature', sources: [], asOf: null })
    expect(readCard(card)).toEqual(card)
    expect(digestOf(card!)).toContain('Current control values are not available')
    expect(digestOf(card!)).not.toContain('<svg')
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(body.messages[1].content).toBe('Draw a spring balance')
    expect(body.messages[0].content).toContain('illustrative')
  })
  it.each([['truncated', drawing, 'length'], ['missing summary', { ...drawing, summary: '' }, 'stop'], ['external code', { ...drawing, html: '<svg></svg><script src="https://evil.test/x.js"></script>' }, 'stop']])('rejects %s without sending a broken card', async (_name, value, reason) => {
    const card = await generateIllustration('Draw', { fetch: vi.fn(async () => response(value, String(reason))), openrouterHeaders: {}, model: 'test' }, new AbortController().signal)
    expect(card).toBeNull()
  })
  it('does not make a provider call after cancellation or without a key', async () => {
    const fetcher = vi.fn()
    const controller = new AbortController(); controller.abort()
    expect(await generateIllustration('Draw', { fetch: fetcher, openrouterHeaders: {}, model: 'test' }, controller.signal)).toBeNull()
    expect(await generateIllustration('Draw', { fetch: fetcher, openrouterHeaders: null, model: 'test' }, new AbortController().signal)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('soft-fails a provider outage and audits failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('provider down') }))
    const record = vi.fn()
    const outcome = await runIllustration({ request: 'Draw a spring' }, { store: new EphemeralMemoryStore(), env: name => name === 'OPENROUTER_API_KEY' ? 'test' : undefined, timezone: 'UTC', signal: new AbortController().signal, audit: { record } as never })
    expect(outcome.ok).toBe(false)
    expect(outcome.card).toBeUndefined()
    expect(record).toHaveBeenCalledWith('illustration_generation', expect.objectContaining({ ok: false }))
  })
})

describe('isolated drawing documents', () => {
  it('puts CSP before any code, includes the actual kit, and escapes document titles', () => {
    const html = illustrationDocument(drawing.html, '</title><script>bad()</script>', 'example')
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'))
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("form-action 'none'")
    expect(html).toContain('window.Anatomy=')
    expect(html).toContain('&lt;/title&gt;')
    expect(html).not.toContain('<script>bad()')
  })
  it.each(['<svg></svg><meta http-equiv="refresh" content="0;url=https://evil.test">', '<svg></svg><iframe></iframe>', '<svg></svg><form></form>', '<svg><image href="https://evil.test/x"/></svg>', '<svg></svg><script>import("x")</script>', '<svg>\u0000</svg>', 'x'.repeat(MAX_ILLUSTRATION_HTML + 1), '<p>No drawing</p>'])('rejects unsupported document content', html => {
    expect(readIllustrationHtml(html)).toBeNull()
  })
})
