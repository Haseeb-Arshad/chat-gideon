import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TIMING,
  ResearchCache,
  SharedRun,
  defaultDeps,
  research,
  type ResearchDeps,
  type ResearchResult,
} from './research'

/**
 * The researcher against a scripted web.
 *
 * `fetch` is routed by URL: OpenRouter answers from a queue of scripted model
 * turns, Exa answers from fixtures. What is under test is the machinery around
 * the model — that searches in one round run together, that the brief keeps
 * only the sources it cited, that a slow run is hedged and a dead one falls
 * back, and that a run outlives a caller who gives up on it.
 */

type Json = Record<string, unknown>

interface Scripted {
  /** Successive OpenRouter responses, consumed in order. */
  model: Array<Json | { status: number }>
  search?: (body: Json) => Json
  contents?: (body: Json) => Json
  answer?: (body: Json) => Json | { status: number }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const isStatus = (value: object): value is { status: number } =>
  'status' in value && Object.keys(value).length === 1

function scripted(script: Scripted) {
  const calls: Array<{ url: string; body: Json; headers: Record<string, string> }> = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {}
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> })

    if (url.includes('openrouter.ai')) {
      const next = script.model.shift()
      if (!next) return json({ error: 'script exhausted' }, 500)
      return isStatus(next) ? json({ error: 'down' }, next.status) : json(next)
    }
    if (url.endsWith('/search')) return json(script.search?.(body) ?? { results: [] })
    if (url.endsWith('/contents')) return json(script.contents?.(body) ?? { results: [] })
    if (url.endsWith('/answer')) {
      const value = script.answer?.(body) ?? { status: 500 }
      return isStatus(value) ? json({ error: 'down' }, value.status) : json(value)
    }
    return json({ error: `unexpected ${url}` }, 404)
  }) as unknown as typeof globalThis.fetch

  return { fetch, calls }
}

function deps(fetch: typeof globalThis.fetch, overrides: Partial<ResearchDeps> = {}): ResearchDeps {
  return {
    fetch,
    exaKey: 'exa-test',
    openrouterHeaders: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    model: 'test/researcher',
    fallbackModel: 'test/fallback',
    effort: 'none',
    timing: { ...DEFAULT_TIMING, orphanGraceMs: 5 },
    now: () => 1_800_000_000_000,
    ...overrides,
  }
}

function toolCallTurn(calls: Array<{ name: string; args: Json }>): Json {
  return {
    model: 'test/researcher',
    choices: [
      {
        message: {
          content: null,
          tool_calls: calls.map((call, index) => ({
            id: `call_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      },
    ],
  }
}

function textTurn(content: string): Json {
  return { model: 'test/researcher', choices: [{ message: { content } }] }
}

const searchFixture = (body: Json): Json => {
  const query = String(body.query)
  return {
    results: [
      {
        title: `Result for ${query}`,
        url: `https://example.org/${encodeURIComponent(query)}`,
        publishedDate: '2026-09-09T00:00:00.000Z',
        highlights: [`The answer to ${query} is forty-two.`],
      },
      {
        title: 'Unrelated page',
        url: 'https://elsewhere.test/noise',
        highlights: ['Nothing to do with it.'],
      },
    ],
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fetch that only ever ends by being aborted, and records that it was. */
function hangingModel(answer?: () => Response) {
  const aborted: boolean[] = []
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/answer') && answer) return Promise.resolve(answer())
    const index = aborted.push(false) - 1
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted[index] = true
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
  }) as unknown as typeof globalThis.fetch
  return { fetch, aborted }
}

describe('research', () => {
  it('runs every search in a round together, then keeps only the sources the brief cited', async () => {
    const searchesSeen: string[] = []
    const { fetch, calls } = scripted({
      model: [
        toolCallTurn([
          { name: 'search', args: { query: 'first part', recency: 'week' } },
          { name: 'search', args: { query: 'second part' } },
        ]),
        textTurn(
          'Both parts are forty-two.\nSources: Result for first part https://example.org/first%20part; Result for second part https://example.org/second%20part',
        ),
      ],
      search: (body) => {
        searchesSeen.push(String(body.query))
        return searchFixture(body)
      },
    })

    const result = await research(
      'what are the first part and the second part',
      { signal: new AbortController().signal, timezone: 'Europe/London' },
      deps(fetch),
      null,
    )

    expect(result.ok).toBe(true)
    expect(result.via).toBe('agent')
    expect(result.searches).toBe(2)
    expect(searchesSeen).toEqual(['first part', 'second part'])
    expect(result.brief).toContain('forty-two')
    // The unrelated page was seen but not cited, so it does not reach the ledger.
    expect(result.sources.map((source) => source.url)).toEqual([
      'https://example.org/first%20part',
      'https://example.org/second%20part',
    ])
    expect(result.sources[0].publishedDate).toBe('2026-09-09')

    const exaCalls = calls.filter((call) => call.url.endsWith('/search'))
    expect(exaCalls).toHaveLength(2)
    expect(exaCalls[0].headers['x-api-key']).toBe('exa-test')
    // "week" became a published-after bound; the unbounded one sent none.
    expect(exaCalls[0].body.startPublishedDate).toBeTypeOf('string')
    expect(exaCalls[1].body.startPublishedDate).toBeUndefined()

    // The first model round was made to search, with the configured effort.
    const modelCalls = calls.filter((call) => call.url.includes('openrouter'))
    expect(modelCalls[0].body.tool_choice).toBe('required')
    expect(modelCalls[0].body.models).toEqual(['test/fallback'])
    expect(modelCalls[0].body.reasoning).toEqual({ effort: 'none', exclude: true })
    // The direct answer is asked for once, at the start, so a hedge is ready if
    // one is needed; a quick run keeps the research model's brief regardless.
    expect(calls.filter((call) => call.url.endsWith('/answer'))).toHaveLength(1)
  })

  it('reads a page when asked and feeds the text back', async () => {
    const { fetch, calls } = scripted({
      model: [
        toolCallTurn([{ name: 'search', args: { query: 'thing' } }]),
        toolCallTurn([{ name: 'read', args: { url: 'https://example.org/thing' } }]),
        textTurn('It is forty-two, per the page.\nSources: Result for thing https://example.org/thing'),
      ],
      search: searchFixture,
      contents: () => ({
        results: [{ title: 'Result for thing', url: 'https://example.org/thing', text: 'Full page text.' }],
      }),
    })

    const result = await research('thing?', { signal: new AbortController().signal }, deps(fetch), null)
    expect(result.ok).toBe(true)
    const modelCalls = calls.filter((call) => call.url.includes('openrouter'))
    const toolReplies = (modelCalls[2].body.messages as Array<{ role: string; content: string }>).filter(
      (message) => message.role === 'tool',
    )
    expect(toolReplies.at(-1)?.content).toContain('Full page text.')
    expect(calls.find((call) => call.url.endsWith('/contents'))?.body.urls).toEqual([
      'https://example.org/thing',
    ])
  })

  it('falls back to a direct answer at once when the research model is down', async () => {
    const { fetch } = scripted({
      model: [{ status: 502 }],
      answer: () => ({
        answer: 'Forty-two, according to the almanac.',
        citations: [{ title: 'The Almanac', url: 'https://almanac.test/42' }],
      }),
    })

    const result = await research('what is it', { signal: new AbortController().signal }, deps(fetch), null)
    expect(result.ok).toBe(true)
    expect(result.via).toBe('answer')
    expect(result.brief).toContain('Forty-two')
    expect(result.brief).toContain('https://almanac.test/42')
    expect(result.sources).toEqual([{ title: 'The Almanac', url: 'https://almanac.test/42' }])
  })

  it('tells the speaking model plainly when nothing could be found out', async () => {
    const { fetch } = scripted({ model: [{ status: 502 }], answer: () => ({ status: 500 }) })
    const result = await research('what is it', { signal: new AbortController().signal }, deps(fetch), null)
    expect(result.ok).toBe(false)
    expect(result.via).toBe('none')
    expect(result.brief).toMatch(/could not be completed/)
  })

  it('does not mistake a direct answer with no text for an answer', async () => {
    const { fetch } = scripted({ model: [{ status: 502 }], answer: () => ({ citations: [] }) })
    const result = await research('what is it', { signal: new AbortController().signal }, deps(fetch), null)
    expect(result.ok).toBe(false)
    expect(result.brief).toMatch(/could not be completed/)
  })

  it('never rejects, and reports a cancellation as one', async () => {
    const controller = new AbortController()
    const { fetch } = hangingModel()
    const pending = research('slow question', { signal: controller.signal }, deps(fetch), null)
    controller.abort()
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.brief).toBe('Cancelled.')
  })

  it('says it is unconfigured without touching the network', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
    const result = await research(
      'anything',
      { signal: new AbortController().signal },
      deps(fetch, { exaKey: '' }),
      null,
    )
    expect(result.ok).toBe(false)
    expect(result.brief).toMatch(/not configured/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('hedging a slow run', () => {
  const quick = { ...DEFAULT_TIMING, hedgeAfterMs: 10, budgetMs: 5_000, orphanGraceMs: 5 }

  it('lets a direct answer win once the research model has taken too long', async () => {
    const { fetch, aborted } = hangingModel(() =>
      json({ answer: 'Forty-two.', citations: [{ title: 'Almanac', url: 'https://almanac.test/42' }] }),
    )

    const result = await research(
      'slow question',
      { signal: new AbortController().signal },
      deps(fetch, { timing: quick }),
      null,
    )
    expect(result.via).toBe('answer')
    expect(result.brief).toContain('Forty-two.')
    // The losing research run was stopped, not left spending.
    await sleep(0)
    expect(aborted).toEqual([true])
  })

  it('keeps waiting for the research model when the direct answer fails', async () => {
    const answerCalls: string[] = []
    let modelCalls = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/answer')) {
        answerCalls.push(url)
        return json({ error: 'down' }, 500)
      }
      if (url.endsWith('/search')) return json(searchFixture({ query: 'slow' }))
      await sleep(40)
      modelCalls += 1
      return json(
        modelCalls === 1
          ? toolCallTurn([{ name: 'search', args: { query: 'slow' } }])
          : textTurn('Forty-two, from the research desk.'),
      )
    }) as unknown as typeof globalThis.fetch

    const result = await research(
      'slow but fine',
      { signal: new AbortController().signal },
      deps(fetch, { timing: quick }),
      null,
    )
    expect(result.via).toBe('agent')
    expect(result.brief).toContain('research desk')
    expect(answerCalls).toHaveLength(1)
  })
})

describe('what counts as a brief', () => {
  const almanac = () => ({
    answer: 'Forty-two, per the almanac.',
    citations: [{ title: 'Almanac', url: 'https://almanac.test/42' }],
  })

  it('makes a model that writes its tool call out as text write the brief instead', async () => {
    const { fetch, calls } = scripted({
      model: [
        toolCallTurn([{ name: 'search', args: { query: 'q' } }]),
        textTurn('<tool_call>\n{"name": "search", "arguments": {"query": "q again"}}\n</tool_call>'),
        textTurn('Forty-two.\nSources: Result for q https://example.org/q'),
      ],
      search: searchFixture,
    })

    const result = await research('what is q', { signal: new AbortController().signal }, deps(fetch), null)
    expect(result.via).toBe('agent')
    expect(result.brief).toBe('Forty-two.\nSources: Result for q https://example.org/q')
    const writing = calls.filter((call) => call.url.includes('openrouter'))[2].body
    expect(writing.tools).toBeUndefined()
    const messages = writing.messages as Array<{ role: string; content: string }>
    expect(messages.at(-1)?.content).toMatch(/Write the brief now/)
  })

  it('gives up on a model that will not write a brief, and lets the direct answer stand in', async () => {
    const markup = textTurn('<tool_call>{"name": "read", "arguments": {"url": "https://example.org/q"}}</tool_call>')
    const { fetch } = scripted({
      model: [toolCallTurn([{ name: 'search', args: { query: 'q' } }]), markup, markup],
      search: searchFixture,
      answer: almanac,
    })

    const result = await research('what is q', { signal: new AbortController().signal }, deps(fetch), null)
    expect(result.via).toBe('answer')
    expect(result.brief).toContain('almanac')
    expect(result.brief).not.toContain('tool_call')
  })

  it('will not pass off an answer from memory as research', async () => {
    const { fetch, calls } = scripted({ model: [textTurn('Forty-two, as I recall.')], answer: almanac })

    const result = await research('what is q', { signal: new AbortController().signal }, deps(fetch), null)
    expect(result.via).toBe('answer')
    expect(result.brief).not.toContain('recall')
    expect(calls.filter((call) => call.url.includes('openrouter'))).toHaveLength(1)
  })
})

describe('sharing a run', () => {
  it('outlives a caller that gives up, so the next asker joins it', async () => {
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const { fetch: scriptedFetch, calls } = scripted({
      model: [
        toolCallTurn([{ name: 'search', args: { query: 'q' } }]),
        textTurn('Forty-two.\nSources: Result for q https://example.org/q'),
      ],
      search: searchFixture,
    })
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('openrouter')) await released
      return scriptedFetch(input, init)
    }) as typeof globalThis.fetch
    const cache = new ResearchCache(() => 0)
    const shared = deps(fetch, { timing: { ...DEFAULT_TIMING, orphanGraceMs: 1_000 } })

    // The guess asks, then is discarded before the answer comes back.
    const guess = new AbortController()
    const guessed = research("what's the answer to q", { signal: guess.signal }, shared, cache)
    guess.abort()
    expect((await guessed).brief).toBe('Cancelled.')

    // The real turn asks nearly the same thing and picks the run up.
    const real = research('what is the answer to q', { signal: new AbortController().signal }, shared, cache)
    release()
    const result = await real

    expect(result.ok).toBe(true)
    expect(result.via).toBe('cache')
    expect(result.brief).toContain('Forty-two.')
    expect(calls.filter((call) => call.url.includes('openrouter'))).toHaveLength(2)
  })

  it('stops a run nobody comes back for', async () => {
    const { fetch, aborted } = hangingModel()
    const caller = new AbortController()
    const pending = research(
      'abandoned question',
      { signal: caller.signal },
      deps(fetch, { timing: { ...DEFAULT_TIMING, orphanGraceMs: 20 } }),
      null,
    )
    caller.abort()
    await pending
    // The research model and the direct answer held in reserve both keep
    // going through the grace period, then both are stopped.
    expect(aborted).toEqual([false, false])
    await sleep(80)
    expect(aborted).toEqual([true, true])
  })
})

describe('ResearchCache', () => {
  function result(brief: string, ok = true): ResearchResult {
    return { ok, brief, sources: [], via: 'agent', model: 'm', searches: 1, ms: 1 }
  }
  const settled = (value: ResearchResult) => new SharedRun(() => Promise.resolve(value), 5)

  it('finds a question phrased a little differently, and no other', () => {
    const cache = new ResearchCache(() => 0)
    cache.store('what is the weather in london today', settled(result('rain')))
    expect(cache.lookup("what's the weather in london today?")).not.toBeNull()
    expect(cache.lookup('weather london today')).not.toBeNull()
    expect(cache.lookup('what is the weather in london tomorrow')).toBeNull()
    expect(cache.lookup('what is the population of london')).toBeNull()
  })

  it('lets a second asker join a run still in progress', async () => {
    const { fetch, calls } = scripted({
      model: [
        toolCallTurn([{ name: 'search', args: { query: 'q' } }]),
        textTurn('Forty-two.\nSources: Result for q https://example.org/q'),
      ],
      search: searchFixture,
    })
    const cache = new ResearchCache(() => 0)
    const signal = new AbortController().signal

    const guess = research('what is the answer to q', { signal }, deps(fetch), cache)
    const real = research('what is the answer to q please', { signal }, deps(fetch), cache)
    const [a, b] = await Promise.all([guess, real])

    expect(a.via).toBe('agent')
    expect(b.via).toBe('cache')
    expect(b.brief).toBe(a.brief)
    expect(calls.filter((call) => call.url.includes('openrouter'))).toHaveLength(2)
  })

  it('does not keep a failure around to repeat', async () => {
    const cache = new ResearchCache(() => 0)
    const run = settled(result('nothing', false))
    cache.store('broken question', run)
    await run.promise
    await sleep(0)
    expect(cache.lookup('broken question')).toBeNull()
  })

  it('forgets after ten minutes', () => {
    let now = 0
    const cache = new ResearchCache(() => now)
    cache.store('old question about things', settled(result('x')))
    now = 11 * 60_000
    expect(cache.lookup('old question about things')).toBeNull()
  })
})

describe('defaultDeps', () => {
  it('takes its configuration from the host rather than the process', () => {
    const values: Record<string, string> = {
      EXA_API_KEY: 'exa-live',
      OPENROUTER_API_KEY: 'or-live',
      OPENROUTER_RESEARCH_MODEL: 'nvidia/nemotron-3-ultra-550b-a55b',
      OPENROUTER_RESEARCH_EFFORT: 'low',
    }
    const configured = defaultDeps((name) => values[name])
    expect(configured.exaKey).toBe('exa-live')
    expect(configured.model).toBe('nvidia/nemotron-3-ultra-550b-a55b')
    expect(configured.effort).toBe('low')
    expect(configured.openrouterHeaders?.Authorization).toBe('Bearer or-live')

    const bare = defaultDeps((name) => (name === 'OPENROUTER_RESEARCH_EFFORT' ? 'maximum' : undefined))
    expect(bare.exaKey).toBe('')
    expect(bare.openrouterHeaders).toBeNull()
    expect(bare.effort).toBe('none')
    expect(bare.model).toBe('openai/gpt-5.6-luna')
  })
})
