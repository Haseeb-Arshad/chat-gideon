/**
 * Turns a research brief into a card for the screen.
 *
 * It runs beside the spoken answer, never in front of it. The brief goes back
 * to the speaking model at once and this starts at the same moment, so the
 * card usually lands as GIDEON's first words are heard. It is one small model
 * call to decide what the answer *is* — a person, a number, a headline — and
 * pull out the few facts worth reading at a glance, then, for a person or a
 * place, one Wikipedia lookup for a picture.
 *
 * Every failure here is silent. A card is an extra: a GIDEON that cannot draw
 * one still answers, and the searching pane simply dissolves.
 */

import { hostOf, parseCard, type Card, type CardImage } from '../cards'
import { defaultDeps, type EnvReader, type ResearchResult } from './research'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php'
/** Wikimedia asks every API client to say who it is. */
const USER_AGENT = 'GIDEON/1.0 (voice companion; research cards)'

/**
 * The same model as the conversation, because it is already fast and warm and
 * reliably returns JSON when asked. Nothing here needs reasoning: the brief has
 * done the finding out, and this only decides how to lay it out.
 */
export const CARD_MODEL = 'openai/gpt-4.1-mini'

/** Past this the answer it illustrates has usually finished being spoken. */
const EXTRACT_TIMEOUT_MS = 12_000
const IMAGE_TIMEOUT_MS = 3_000
/** Wide enough for the card's portrait at twice the pixel density. */
const IMAGE_WIDTH = 800
const CACHE_LIMIT = 32

export interface CardDeps {
  fetch: typeof fetch
  openrouterHeaders: Record<string, string> | null
  model: string
}

export function cardDeps(env: EnvReader): CardDeps {
  const research = defaultDeps(env)
  return {
    fetch: research.fetch,
    openrouterHeaders: research.openrouterHeaders,
    model: env('OPENROUTER_CARD_MODEL') ?? CARD_MODEL,
  }
}

const CARD_PROMPT = `You lay out one information card for a screen, from a research brief that a voice assistant is about to read aloud. The card sits beside the spoken answer and shows what is worth seeing at a glance.

Use only what the brief states. Never add a fact, name, number or date that is not in it, and copy numbers exactly as the brief writes them.

Reply with one JSON object and nothing else:
{"show": boolean, "kind": "entity" | "figure" | "news" | "answer", "title": string, "subtitle": string, "summary": string, "figure": {"value": string, "label": string} | null, "kicker": string, "facts": [{"label": string, "value": string}], "subject": string | null}

show is false when the brief says the answer could not be found, when the answer is a bare yes or no, or when there are not at least two real facts to show.

kind is entity for a person, place, organisation, creature, work or thing; figure when the answer is one number, such as a price, a score, a temperature or a count; news for a recent event; answer for anything else.

title: the name of the thing for an entity, the headline for news, otherwise a short noun phrase for what was asked, such as "Bitcoin price" or "Weather in London". At most six words.
subtitle: at most eight words, such as what the entity is ("Theoretical physicist"). Empty when there is nothing to add.
summary: one sentence of at most twenty-five words that answers the question.
figure: only for kind figure. value is the number with its unit exactly as the brief writes it, such as "$67,420" or "17°C"; label says what it measures in at most five words. Otherwise null.
kicker: only for news, the date of the event as the brief gives it. Otherwise empty.
facts: three to five for an entity, two or three otherwise. label is one to three words in Title Case, such as "Born" or "Known for"; value is at most ten words. Never repeat the title, the summary or the figure.
subject: only for an entity, the exact title of its English Wikipedia article, such as "Albert Einstein". Otherwise null.

Plain text in every field. No markdown, no URLs, no sources.`

/** The brief without its closing list of sources, which a card does not need. */
export function briefBody(brief: string): string {
  const at = brief.search(/(^|\n)\s*Sources?:/i)
  return (at >= 0 ? brief.slice(0, at) : brief).trim()
}

function parseJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

async function extract(
  question: string,
  body: string,
  deps: CardDeps,
  signal: AbortSignal,
): Promise<unknown> {
  if (!deps.openrouterHeaders) return null
  const response = await deps.fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: deps.openrouterHeaders,
    body: JSON.stringify({
      model: deps.model,
      messages: [
        { role: 'system', content: CARD_PROMPT },
        { role: 'user', content: `Question: ${question}\n\nBrief:\n${body}` },
      ],
      response_format: { type: 'json_object' },
      // Throughput, not latency: nothing is shown until the whole object has
      // arrived, so the first token being early buys nothing. Sorting by
      // latency measured 3.6 seconds for one card and past 9 for the next.
      provider: { sort: 'throughput', allow_fallbacks: true },
      temperature: 0,
      // A bound on a JSON object, not on anything spoken: a card that runs
      // past this is malformed and is dropped either way.
      max_tokens: 700,
    }),
    signal,
  })
  if (!response.ok) {
    void response.body?.cancel()
    return null
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const content = payload.choices?.[0]?.message?.content
  return typeof content === 'string' ? parseJson(content) : null
}

function isWikimediaImage(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'https:' && (hostname === 'upload.wikimedia.org' || hostname === 'thumb.wikimedia.org')
  } catch {
    return false
  }
}

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !['the', 'and', 'of'].includes(word)),
  )
}

/**
 * The lead picture of a Wikipedia article, or nothing.
 *
 * "Nothing" is the answer for a disambiguation page, a missing article, an
 * article without a picture, and an article whose title shares no word with
 * what was asked for, which is what a bad redirect looks like. A wrong face on
 * the card would be worse than no face.
 */
export async function wikipediaImage(
  subject: string,
  deps: Pick<CardDeps, 'fetch'>,
  signal: AbortSignal,
): Promise<CardImage | null> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    redirects: '1',
    prop: 'pageimages|pageprops',
    piprop: 'thumbnail',
    pithumbsize: String(IMAGE_WIDTH),
    ppprop: 'disambiguation',
    titles: subject,
    origin: '*',
  })
  const response = await deps.fetch(`${WIKIPEDIA_API}?${params}`, {
    headers: { 'Api-User-Agent': USER_AGENT, 'User-Agent': USER_AGENT },
    signal,
  })
  if (!response.ok) {
    void response.body?.cancel()
    return null
  }
  const payload = (await response.json()) as {
    query?: {
      pages?: Array<{
        title?: string
        missing?: boolean
        invalid?: boolean
        pageprops?: Record<string, unknown>
        thumbnail?: { source?: string; width?: number; height?: number }
      }>
    }
  }
  const page = payload.query?.pages?.[0]
  if (!page?.title || page.missing || page.invalid) return null
  if (page.pageprops && 'disambiguation' in page.pageprops) return null
  // Wikimedia's own image hosts only. Thumbnails moved from `upload.` to
  // `thumb.wikimedia.org` in 2026, so the host is checked, not a prefix.
  const source = page.thumbnail?.source ?? ''
  if (!isWikimediaImage(source)) return null

  const asked = significantWords(subject)
  const found = significantWords(page.title)
  if (![...asked].some((word) => found.has(word))) return null

  return {
    url: source,
    alt: page.title,
    credit: 'Wikipedia',
    width: page.thumbnail?.width,
    height: page.thumbnail?.height,
  }
}

async function draw(question: string, result: ResearchResult, deps: CardDeps): Promise<Card | null> {
  const signal = AbortSignal.timeout(EXTRACT_TIMEOUT_MS)
  try {
    const body = briefBody(result.brief)
    const raw = await extract(question, body, deps, signal)
    const parsed = parseCard(raw, { query: question, brief: body, sources: result.sources })
    if (!parsed) return null

    const { card, subject } = parsed
    if (card.kind === 'entity' && subject) {
      card.image = await wikipediaImage(
        subject,
        deps,
        AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]),
      ).catch(() => null)
    } else if (card.kind === 'news') {
      // A news story's own picture, from the page that reported it.
      const lead = result.sources.find((source) => source.image?.startsWith('https://'))
      if (lead?.image) {
        card.image = { url: lead.image, alt: card.title, credit: hostOf(lead.url) }
      }
    }
    return card
  } catch {
    return null
  }
}

/**
 * Cards already drawn, by the brief they were drawn from.
 *
 * The research desk hands the same brief to every turn that asks the same
 * question, including the real turn that follows a speculative one, so this
 * turns the second request for a card into no work at all.
 */
const drawn = new Map<string, Promise<Card | null>>()

function abandoned(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null)
    else signal.addEventListener('abort', () => resolve(null), { once: true })
  })
}

/**
 * A card for `result`, or null.
 *
 * The drawing itself is not tied to the caller's signal. A speculative turn
 * that is thrown away is usually followed a moment later by the real one asking
 * for the same card, so the work is left to finish and the caller merely stops
 * waiting for it. Its own timeout still bounds it.
 */
export function buildCard(
  question: string,
  result: ResearchResult,
  deps: CardDeps,
  signal: AbortSignal,
): Promise<Card | null> {
  if (!result.ok || !result.brief.trim() || !deps.openrouterHeaders) return Promise.resolve(null)

  let pending = drawn.get(result.brief)
  if (!pending) {
    pending = draw(question, result, deps)
    drawn.set(result.brief, pending)
    if (drawn.size > CACHE_LIMIT) drawn.delete(drawn.keys().next().value as string)
    const key = result.brief
    // A failed card is not worth remembering; the next ask should try again.
    void pending.then((card) => {
      if (!card) drawn.delete(key)
    })
  }
  return Promise.race([pending, abandoned(signal)])
}

/** For tests: forget every card drawn so far. */
export function forgetCards() {
  drawn.clear()
}
