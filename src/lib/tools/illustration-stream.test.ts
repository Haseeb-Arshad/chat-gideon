import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateIllustration } from './illustration'
import { EphemeralMemoryStore } from './memory'
import { partialJsonString, previewOfDraft } from '../illustrations/stream'
import { draftDocument } from '../illustrations/document'
import { streamTurn } from '../agent-core'
import type { ServerFrame } from '../protocol'

const drawing = { title: 'Spring balance', summary: 'An illustrative spring stretches with load. Values are a conceptual model.', html: '<main><svg viewBox="0 0 600 380" role="img" aria-label="Spring balance"><circle cx="100" cy="100" r="30" /></svg><button>Reset</button></main>' }
const big = { ...drawing, html: `<main><svg viewBox="0 0 600 380">${'<circle cx="1" cy="1" r="1"/>'.repeat(40)}</svg><script>let a=1</script><button>Reset</button></main>` }

/** A streamed completion, cut into the given number of pieces. */
const sse = (value: unknown, pieces = 6, reason = 'stop') => {
  const text = JSON.stringify(value)
  const size = Math.ceil(text.length / pieces)
  const events = Array.from({ length: pieces }, (_, index) => `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(index * size, (index + 1) * size) } }] })}\n\n`)
  events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`)
  return new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(event)); controller.close() } }))
}
const runAhead = () => { let now = 0; vi.spyOn(Date, 'now').mockImplementation(() => (now += 600)) }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('reading a drawing that is still being written', () => {
  it('reads a string field out of JSON that is not finished, escapes included', () => {
    expect(partialJsonString('{"title":"A","html":"<p class=\\"x\\">one\\ntwo \\u00e9', 'html')).toEqual({ value: '<p class="x">one\ntwo é', done: false })
    expect(partialJsonString('{"html":"abc\\', 'html')).toEqual({ value: 'abc', done: false })
    expect(partialJsonString('{"html":"abc\\u00', 'html')).toEqual({ value: 'abc', done: false })
    expect(partialJsonString('{"title":"A","html":"done"}', 'html')).toEqual({ value: 'done', done: true })
    expect(partialJsonString('{"title":"A"', 'html')).toBeNull()
  })
  it('previews only what is safe to look at: no scripts, no handlers, no half-written tag', () => {
    expect(previewOfDraft('<h1>Title</h1>')).toBeNull()
    expect(previewOfDraft('<svg viewBox="0 0 10 10"><circle onclick="bad()" r="2"/><script>run()</script><rect width="4"')).toBe('<svg viewBox="0 0 10 10"><circle r="2"/>')
    expect(previewOfDraft('<svg><g/></svg><script>const a=1;')).toBe('<svg><g/></svg>')
  })
  it('gives the watching frame a nonce-only script policy', () => {
    const html = draftDocument('c1', 'abc123')
    expect(html).toContain("script-src 'nonce-abc123'")
    expect(html).toContain("connect-src 'none'")
    expect(html.match(/<script/g)).toHaveLength(1)
  })
})

describe('generating a drawing someone is watching', () => {
  it('reports the drawing as it grows and still returns the finished card', async () => {
    runAhead()
    const drafts: string[] = []
    const card = await generateIllustration('Draw circles', { fetch: vi.fn(async () => sse(big, 12)), openrouterHeaders: {}, model: 'test', onDraft: draft => drafts.push(draft.html) }, new AbortController().signal)
    expect(card).toMatchObject({ recipe: 'illustration', title: 'Spring balance', partial: false })
    expect(drafts.length).toBeGreaterThan(1)
    expect(new Set(drafts).size).toBe(drafts.length)
    expect(drafts.every(html => !html.includes('<script') && html.includes('<svg'))).toBe(true)
    expect(drafts.at(-1)!.length).toBeGreaterThan(drafts[0].length)
  })
  it('asks the provider to stream only when something is watching', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return bodies.length === 1 ? sse(drawing) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(drawing) } }] })
    })
    await generateIllustration('Draw', { fetch: fetcher as typeof fetch, openrouterHeaders: {}, model: 'test', onDraft: () => undefined }, new AbortController().signal)
    await generateIllustration('Draw', { fetch: fetcher as typeof fetch, openrouterHeaders: {}, model: 'test' }, new AbortController().signal)
    expect(bodies[0].stream).toBe(true)
    expect(bodies[1].stream).toBeUndefined()
  })
  it('rejects a stream that ended without finishing', async () => {
    expect(await generateIllustration('Draw', { fetch: vi.fn(async () => sse(drawing, 4, 'length')), openrouterHeaders: {}, model: 'test', onDraft: () => undefined }, new AbortController().signal)).toBeNull()
  })
})

describe('a drawing on its way to the screen', () => {
  const turn = async (answer: () => Response) => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test')
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
    let rounds = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).response_format) return answer()
      const delta = rounds++ === 0 ? { tool_calls: [{ index: 0, id: 'draw-call', function: { name: 'draw_illustration', arguments: JSON.stringify({ request: 'Draw a spring balance' }) } }] } : { content: 'Try the load slider.' }
      return new Response(event({ choices: [{ delta }] }) + 'data: [DONE]\n\n')
    }))
    const frames: ServerFrame[] = []
    for await (const frame of streamTurn('drawing-turn', [{ role: 'user', content: 'Draw a spring balance' }], new AbortController().signal, { memoryStore: new EphemeralMemoryStore(), timezone: 'UTC' })) frames.push(frame)
    return frames
  }

  it('puts the draft on screen first and finishes the same card, so the stage never shows two', async () => {
    runAhead()
    const frames = await turn(() => sse(big, 10))
    const cards = frames.filter((frame): frame is Extract<ServerFrame, { t: 'card' }> => frame.t === 'card')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ call: 'draw-call', card: { recipe: 'illustration', partial: true }, displayRevision: 1 })
    const patches = frames.filter((frame): frame is Extract<ServerFrame, { t: 'card_patch' }> => frame.t === 'card_patch')
    expect(patches.length).toBeGreaterThan(1)
    expect(new Set([cards[0].artifactId, ...patches.map(patch => patch.artifactId)]).size).toBe(1)
    const last = patches.at(-1)!
    expect(last).toMatchObject({ partial: false, displayRevision: 2 })
    expect(last.blocks[0]).toMatchObject({ type: 'illustration', html: big.html })
    expect(patches.slice(0, -1).every(patch => patch.partial && patch.displayRevision === 1)).toBe(true)
    expect(frames.some(frame => frame.t === 'done')).toBe(true)
  })
  it('shows the first strokes before the model has finished, not after', async () => {
    runAhead()
    const frames = await turn(() => sse(big, 10))
    const action = frames.findIndex(frame => frame.t === 'action' && frame.name === 'draw_illustration' && frame.pending)
    const finished = frames.findIndex(frame => frame.t === 'action' && frame.name === 'draw_illustration' && !frame.pending)
    const firstCard = frames.findIndex(frame => frame.t === 'card')
    expect(action).toBeGreaterThanOrEqual(0)
    expect(firstCard).toBeGreaterThan(action)
    expect(firstCard).toBeLessThan(finished)
  })
  it('takes the draft down when the drawing fails after it began to appear', async () => {
    runAhead()
    const frames = await turn(() => sse(big, 10, 'length'))
    const first = frames.find((frame): frame is Extract<ServerFrame, { t: 'card' }> => frame.t === 'card' && frame.card !== null)
    expect(first).toBeDefined()
    expect(frames).toContainEqual(expect.objectContaining({ t: 'action', name: 'draw_illustration', ok: false }))
    const gone = frames.filter(frame => frame.t === 'card' && frame.card === null)
    expect(gone).toHaveLength(1)
    expect(gone[0]).toMatchObject({ artifactId: first!.artifactId })
  })
})
