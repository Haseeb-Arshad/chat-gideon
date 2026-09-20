/**
 * The researcher: a second, stronger model that goes and finds things out.
 *
 * The model that talks to the user is chosen for the speed of its first token,
 * because in a voice turn that is the number a person feels. It is not the
 * model you want deciding which of five search results to trust, noticing that
 * a figure is from 2023, or reading a page to check a claim. So live questions
 * are delegated: the conversational model calls `research` with the question in
 * plain words, and a research model with Exa search and page reading as its
 * tools runs its own short loop, then hands back a brief — the answer, the
 * facts with their dates, and the sources — for the speaking model to relay.
 *
 * Three properties matter more than the model choice. Research is read-only,
 * which is what allows it to run inside a *speculative* turn: it can start while
 * the user is still finishing the sentence, and a wrong guess wastes a search
 * rather than doing anything visible. A run is shared, not owned: the real turn
 * that follows a discarded guess usually asks nearly the same question, so it
 * joins the search already under way instead of starting again. And a slow run
 * is hedged: past a deadline a simpler answer races it, because in a voice
 * conversation a late answer is barely better than none.
 *
 * Nothing here reads the environment. The host passes configuration in, which
 * is what lets the same file run under Node and inside a Cloudflare Worker.
 */

import type { Material } from '../cards/materials'
import { captureTables, mediateTable, type CapturedTable } from '../cards/table-mediation'
import { VISUALIZATION_TOOL, VISUALIZATION_IDS, type VisualizationTrace } from '../cards/visualization-skills'
import { topStories } from './desk/news'
import { entityFacts, MAX_TITLES } from './desk/wikidata'
import { countryData, INDICATOR_KEYS, MAX_COUNTRIES, type DeskLookup } from './desk/world-bank'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const EXA_URL = 'https://api.exa.ai'

export const RESEARCH_MODEL = 'openai/gpt-5.6-luna'
export const RESEARCH_FALLBACK_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b'

export type ResearchEffort = 'none' | 'low' | 'medium' | 'high'

/**
 * How hard the researcher thinks, chosen by measurement rather than taste.
 * Over four questions with the hedge disabled, so every run could finish:
 *
 * | effort | median | worst  | searches per run | words |
 * | none   |  7.9 s |  8.5 s | 3.5              | 163   |
 * | low    |  8.7 s | 10.2 s | 4.3              | 177   |
 * | medium | 15.8 s | 17.1 s | 6.5              | 177   |
 * | high   | 25.3 s | 51.7 s | 8.3              | (*)   |
 *
 * The ceiling is not patience, it is the hedge. A run that has not finished by
 * `hedgeAfterMs` loses to the direct answer, so effort the desk cannot outrun
 * is effort spent and then thrown away: every `medium` run above would be
 * beaten by its own hedge and answered more shallowly, having searched twice
 * as hard to get there. `low` buys a search per run and fifteen more words of
 * brief for eight tenths of a second, and still lands before the hedge.
 *
 * (*) `high` was measured before this prompt asked for broader searching, so
 * its numbers are a floor rather than an estimate. Both it and `medium` stay
 * reachable through OPENROUTER_RESEARCH_EFFORT, for a host that would rather
 * wait: raise `hedgeAfterMs` past their worst case too, or the wait buys
 * nothing at all.
 */
export const RESEARCH_EFFORT: ResearchEffort = 'low'

/**
 * How thoroughly the desk answers, asked for per question rather than set once
 * for the deployment. `quick` is every ordinary question. `deep` is for "tell
 * me everything", "explain it fully", "the full paper" and the like, and for
 * going past what a card already shows: it reads the primary source rather
 * than a page about it, gets more rounds and more time before the hedge can
 * cut it off, and both the brief and the card it draws are allowed to run
 * longer. The voice still says the direct answer first; the extra length is
 * for the card and for whatever the user asks next.
 */
export type ResearchDepth = 'quick' | 'deep'

/**
 * Four rounds is search, search again on what the first round showed, read a
 * page, write. Anything longer is a model that has lost the thread while a
 * person sits in silence. `deep` is asked for on purpose, so it gets two more:
 * read the primary source, then search again on what it turned up.
 */
const MAX_ROUNDS = 4
const MAX_ROUNDS_DEEP = 6
/**
 * Eight rather than five: a question like "papers from August" is answered by
 * the breadth of one search, and the researcher was throwing away the tail of
 * every result set it asked for.
 */
const RESULTS_PER_SEARCH = 8
const HIGHLIGHT_CHARS = 900
/**
 * Ten thousand rather than six: Exa's ceiling for one page, and the
 * difference between a paper's abstract and its method. Someone asking what a
 * paper says wants what it did, which is never in the first six thousand
 * characters of a PDF.
 */
const PAGE_CHARS = 10_000
const SEARCH_TIMEOUT_MS = 9_000
const READ_TIMEOUT_MS = 10_000

export interface ResearchTiming {
  /** When a run still going gets a simpler attempt racing it. */
  hedgeAfterMs: number
  /** When the research model is given up on entirely. */
  budgetMs: number
  /** How long the direct answer may take. */
  answerTimeoutMs: number
  /** How long a run nobody is waiting for keeps going, in case it is asked for again. */
  orphanGraceMs: number
}

/**
 * The hedge has to sit above the runs worth waiting for, not below them.
 *
 * Measured over five question shapes: a price took 4.6 seconds, a person 6.4,
 * the day's news 6.4, a vague question about a year 10.4, and a list of papers
 * 16.4. A hedge at twelve seconds cut off the last two — and those are exactly
 * the questions where the desk's own answer is worth most, because they are
 * the ones a single canned answer handles worst. Cutting them off is what a
 * person experiences as "it searched and found nothing": the shallow answer
 * arrived on time and said little.
 *
 * Fifteen seconds keeps everything up to a hard list, and costs nothing on the
 * ordinary turn, which is finished in six. Nobody is sitting in silence
 * meanwhile: the holding line is spoken a second in, and the direct answer has
 * been waiting since the run started, so the moment the deadline passes it is
 * there.
 *
 * The budget is what a person will sit through before an answer stops being
 * worth having, and it only ever applies to a run the hedge could not rescue.
 */
export const DEFAULT_TIMING: ResearchTiming = {
  hedgeAfterMs: 15_000,
  budgetMs: 22_000,
  answerTimeoutMs: 9_000,
  orphanGraceMs: 4_000,
}

export interface ResearchSource {
  title: string
  url: string
  publishedDate?: string
  /** The page's own lead picture, when the search reported one. */
  image?: string
}

export type ResearchPath = 'agent' | 'answer' | 'cache' | 'none'

export interface ResearchResult {
  ok: boolean
  /** The brief for the speaking model: prose, with its sources named. */
  brief: string
  sources: ResearchSource[]
  /**
   * What the desk's data sources returned, exactly as they returned it: the
   * series and records a card copies its numbers and dates from.
   */
  materials: Material[]
  /** Bounded, content-free diagnostics; selection success is not browser-render proof. */
  visualizations?: VisualizationTrace[]
  via: ResearchPath
  model: string
  searches: number
  ms: number
}

export interface ResearchOptions {
  signal: AbortSignal
  /** So "this week" means the user's week. */
  timezone?: string
  /** `quick` unless the user asked to go deeper. */
  depth?: ResearchDepth
}

/** Reads one configuration value from whatever the host provides. */
export type EnvReader = (name: string) => string | undefined

/** Everything the researcher touches that a test needs to replace. */
export interface ResearchDeps {
  fetch: typeof fetch
  exaKey: string
  /** Null when OpenRouter is not configured; the direct answer still works. */
  openrouterHeaders: Record<string, string> | null
  model: string
  fallbackModel: string
  effort: ResearchEffort
  timing: ResearchTiming
  now: () => number
}

export function defaultDeps(env: EnvReader): ResearchDeps {
  const apiKey = env('OPENROUTER_API_KEY') ?? ''
  const effort = env('OPENROUTER_RESEARCH_EFFORT')
  return {
    // Resolved on each call rather than bound once, so whatever `fetch` the
    // host has installed by then is the one used.
    fetch: (input, init) => globalThis.fetch(input, init),
    exaKey: env('EXA_API_KEY') ?? '',
    openrouterHeaders: apiKey
      ? {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': env('OPENROUTER_SITE_URL') ?? 'http://localhost:3000',
          'X-Title': 'GIDEON Voice Companion',
        }
      : null,
    model: env('OPENROUTER_RESEARCH_MODEL') ?? RESEARCH_MODEL,
    fallbackModel: env('OPENROUTER_RESEARCH_FALLBACK_MODEL') ?? RESEARCH_FALLBACK_MODEL,
    effort:
      effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high'
        ? effort
        : RESEARCH_EFFORT,
    timing: DEFAULT_TIMING,
    now: Date.now,
  }
}

// -- Exa -------------------------------------------------------------------

interface ExaResult {
  title?: string
  url?: string
  publishedDate?: string
  highlights?: string[]
  text?: string
  image?: string
}

type Recency = 'day' | 'week' | 'month' | 'year' | 'any'
const RECENCIES: Recency[] = ['day', 'week', 'month', 'year', 'any']

function sinceDate(recency: Recency, now: number): string | undefined {
  const days = { day: 1, week: 7, month: 31, year: 366, any: 0 }[recency]
  return days ? new Date(now - days * 86_400_000).toISOString() : undefined
}

function withTimeout(signal: AbortSignal, ms: number) {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)])
}

function exaHeaders(deps: ResearchDeps) {
  return { 'Content-Type': 'application/json', 'x-api-key': deps.exaKey }
}

async function exaSearch(
  deps: ResearchDeps,
  query: string,
  recency: Recency,
  signal: AbortSignal,
): Promise<ExaResult[]> {
  const since = sinceDate(recency, deps.now())
  const response = await deps.fetch(`${EXA_URL}/search`, {
    method: 'POST',
    headers: exaHeaders(deps),
    body: JSON.stringify({
      query,
      // Measured on 11 September 2026 over fourteen spoken questions: `fast`
      // answered in 0.34 seconds at the median and 0.84 at p90, against 1.8 at
      // p90 for `auto`, and graded the most accurate of Exa's and Parallel's
      // search modes (8.8 of 10, current in 92% of sets, against 8.4 and 85%).
      type: 'fast',
      numResults: RESULTS_PER_SEARCH,
      ...(since ? { startPublishedDate: since } : {}),
      // Highlights rather than page text: the passages that answer the query,
      // which is what a model deciding where to look next actually needs.
      contents: { highlights: { maxCharacters: HIGHLIGHT_CHARS, query } },
    }),
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`exa search ${response.status}`)
  const body = (await response.json()) as { results?: ExaResult[] }
  return body.results ?? []
}

/**
 * The address of a page that is actually safe to read.
 *
 * arXiv's /html/ pages are neither reliable nor cheap. Asked to read one
 * paper's HTML the reader was handed a different paper's text under the very
 * URL it asked for — 2608.30607 came back as UBASE rather than ByteX, and the
 * brief went on to describe the wrong system with full confidence — while two
 * others spent the entire read budget crawling and timed out. The abstract
 * page is cached, correct and quick, and /pdf/ carries the paper itself, so
 * /html/ is rewritten to the abstract. The version suffix goes with it: the
 * unversioned address is the one that is cached.
 */
export function readableUrl(raw: string): string {
  return raw.replace(
    /^(https?:\/\/(?:www\.)?arxiv\.org)\/html\/(\d{4}\.\d{4,5})(?:v\d+)?(?:[?#].*)?$/i,
    '$1/abs/$2',
  )
}

async function exaRead(deps: ResearchDeps, url: string, signal: AbortSignal): Promise<ExaResult | null> {
  const response = await deps.fetch(`${EXA_URL}/contents`, {
    method: 'POST',
    headers: exaHeaders(deps),
    body: JSON.stringify({
      urls: [readableUrl(url)],
      text: { maxCharacters: PAGE_CHARS, verbosity: 'compact' },
    }),
    signal: withTimeout(signal, READ_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`exa contents ${response.status}`)
  const body = (await response.json()) as { results?: ExaResult[] }
  return body.results?.[0] ?? null
}

/**
 * Exa's own answer endpoint: one call, no reasoning of ours in the loop.
 * Worse than the researcher and far better than knowing nothing, which is why
 * it is both the hedge against a slow run and the fallback for a dead one.
 */
async function exaAnswer(
  deps: ResearchDeps,
  question: string,
  signal: AbortSignal,
): Promise<{ answer: string; sources: ResearchSource[] }> {
  const response = await deps.fetch(`${EXA_URL}/answer`, {
    method: 'POST',
    headers: exaHeaders(deps),
    body: JSON.stringify({ query: question, model: 'exa-fast', text: false }),
    signal,
  })
  if (!response.ok) throw new Error(`exa answer ${response.status}`)
  const body = (await response.json()) as {
    answer?: unknown
    citations?: Array<{ title?: string; url?: string; publishedDate?: string }>
  }
  // Structured output is never requested, so anything but a string is no answer.
  const answer = typeof body.answer === 'string' ? body.answer : ''
  return { answer, sources: toSources(body.citations ?? []) }
}

function toSources(
  results: Array<{ title?: string; url?: string; publishedDate?: string; image?: string }>,
) {
  const seen = new Set<string>()
  const sources: ResearchSource[] = []
  for (const result of results) {
    const url = (result.url ?? '').trim()
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue
    seen.add(url)
    const image = typeof result.image === 'string' ? result.image.trim() : ''
    sources.push({
      title: (result.title ?? '').trim().slice(0, 120) || hostname(url),
      url,
      ...(result.publishedDate ? { publishedDate: result.publishedDate.slice(0, 10) } : {}),
      ...(image.startsWith('https://') ? { image } : {}),
    })
  }
  return sources
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// -- The researcher's tools, as the research model sees them ---------------

const RESEARCH_TOOLS = [
  VISUALIZATION_TOOL,
  {
    type: 'function' as const,
    function: {
      name: 'search',
      description:
        'Search the web. Returns titles, dates and the passages most relevant to the query. Issue several searches at once when a question has several parts or when you want to cross-check a claim.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A specific search query, not the whole question.' },
          recency: {
            type: 'string',
            enum: RECENCIES,
            description:
              'Only results published within this window. Use day or week for news and prices, any for facts that do not change.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read',
      description:
        'Read the full text of one page from a previous search result, when a passage is not enough to be sure of the answer. It reads PDFs as well as pages, so this is how you read a paper itself rather than what someone wrote about it: for an arXiv result, read its /abs/ page for the abstract or its /pdf/ link for the paper. Never read an arxiv.org/html/ link.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The exact URL from a search result.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'country_data',
      description: `Exact yearly World Bank figures for up to ${MAX_COUNTRIES} countries, or the world: population and its growth, share aged 65 and over, share in towns and cities, life expectancy, births per woman, GDP, GDP per person, GDP growth, inflation, unemployment, exports, military and health spending as shares of GDP, CO2 per person, internet use, access to electricity and the renewable share of energy. Returns every year since 1960 that has a figure, summarised, and draws the series on the user's screen as a chart. The latest figure is usually a year or two old.`,
      parameters: {
        type: 'object',
        properties: {
          countries: {
            type: 'array',
            items: { type: 'string' },
            description: `Three-letter ISO 3166-1 codes, such as JPN or KOR, or WLD for the world. At most ${MAX_COUNTRIES}.`,
          },
          indicator: { type: 'string', enum: INDICATOR_KEYS },
          since: { type: 'integer', description: 'The first year to include. Leave it out for everything from 1960.' },
        },
        required: ['countries', 'indicator'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'top_stories',
      description:
        "Today's most widely reported news stories, or a topic's, each with the publisher's headline, a passage saying what happened, its date and its link, grouped so the same event from several outlets is one story. They are laid out on the user's screen as a front page.",
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'What the news should be about, in a few words, such as "technology" or "the US Open". Leave it out for the day\'s headlines.',
          },
          since: { type: 'string', enum: ['day', 'week'], description: 'How far back to look. day unless the user asked about the week.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'entity_facts',
      description: `The structured Wikidata record of up to ${MAX_TITLES} particular people, countries, places, organisations or works: dates and places of birth and death, occupations, awards with their years, capital, population, area, founding date, founders, headquarters, chief executive, author, publication date. Its facts are shown on the user's screen as the card.`,
      parameters: {
        type: 'object',
        properties: {
          titles: {
            type: 'array',
            items: { type: 'string' },
            description: `The exact titles of their English Wikipedia articles, such as "Marie Curie" or "Lisbon". At most ${MAX_TITLES}.`,
          },
        },
        required: ['titles'],
      },
    },
  },
]

function researcherPrompt(now: number, timezone: string, depth: ResearchDepth = 'quick') {
  let today: string
  try {
    today = new Date(now).toLocaleDateString('en-GB', {
      timeZone: timezone || 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  } catch {
    today = new Date(now).toISOString().slice(0, 10)
  }

  const deep = depth === 'deep'
  const primarySource = deep
    ? ' The user explicitly asked to go deep on this, so read the primary source itself whenever there is one to read, not only what a search result says about it: an arXiv result’s /abs/ page gives you the abstract and its /pdf/ link gives you the paper, a filing’s own page gives you the filing.'
    : ' When the question is about one particular paper, filing or document, read that document itself rather than answering from what a search result says about it: reading handles PDFs, so an arXiv result’s /abs/ page gives you the abstract and its /pdf/ link gives you the paper.'
  const stopRule = deep
    ? ' This was asked for in full, so read enough to cover what it is, how it works or what led to it, and what it found or changed, before you stop; still, every extra round is silence for a person who is waiting, so stop once those are covered rather than reading everything that exists.'
    : ' Stop as soon as you are sure; every round is silence for a person who is waiting.'
  const briefLength = deep
    ? 'Under 450 words: the direct answer first, in one or two sentences, then what it is or what happened, how it works or what led to it, its key figures or findings with their dates, and why it matters, each claim grounded in what you read.'
    : 'Under 180 words for a question with one answer; up to 260 when the user asked for several things, such as papers, releases, events or names, in which case give each one its actual title and date rather than describing the group of them. First, the direct answer in one or two sentences, with the exact numbers, names and dates. Then only the further facts that matter, each with its date if currency matters.'

  return `You are the research desk for a spoken assistant. Today is ${today}. Your job is to find out the answer to a question about the world, accurately, and hand back a brief that another model will read aloud.

Method. Search before you answer, always, even when you think you know: you are here because the answer might have changed. Run several searches in one go when the question has parts or when one source is not enough to trust. Check publication dates when the question is about anything current, and prefer the primary source over a page that repeats it. Mind the calendar: anything dated before today has already happened, so it is never the next or upcoming one, and for the latest or newest of anything the most recently dated source wins over older pages that say otherwise. Read a page when a passage leaves the answer ambiguous.${primarySource} Never read an arxiv.org/html/ link.${stopRule}

Data. Three tools return exact figures, records and stories, and what they return is drawn on the user's screen. Use country_data whenever the question is about one of its measures for a country or the world, above all over time or between countries, and search as well for anything newer than its latest year. Use entity_facts whenever the question is about a particular named person, country, place, organisation or work, or compares a few of them. Use top_stories when the user asks for the news, the headlines, or what is happening today, in general or in a topic; brief the top two or three stories from it, and search only if a story needs checking. Call any of them in the same round as your first searches, never in a round of its own. Their numbers and dates are exact: use them as given, and prefer them to a passage that disagrees unless the passage is newer.

Visualization. When read returns captured table IDs and the question asks for statistics, a comparison, a trend or a timeline, use visualize_table to select the relevant table and columns before the brief. Its skills are ${VISUALIZATION_IDS.join(', ')}. The tool copies source cells; never send it invented values. First check the source's periods, units, definitions and footnotes for comparability. Select table for mixed or qualitative data. A fallback is a table, not a chart. This reuses the page already read and makes no network request. Do not search again merely to decorate an answer, and do not use show_images for data graphs. Only currently supported skills are available; do not promise a specialized visual that was not returned.

One round of searching is usually the whole job${deep ? ', though this one was asked for in full and may fairly take a few more' : ''}. When what came back answers the question, write the brief from it and stop: a second round costs a person several seconds of silence and almost never changes the answer. Search again only when the results genuinely do not answer what was asked, or disagree with each other about something that matters.

When they do not, never come back empty-handed from one wording. A search that returns nothing means that phrasing was wrong, not that the answer does not exist, so try again with different words before you conclude anything: the words the sources would use rather than the words the user used, the proper name of the thing, a wider or narrower date, the plain noun instead of the jargon. Go where that kind of answer actually lives, with a site: query when you know the place. Research papers and preprints are on arxiv.org, openreview.net, semanticscholar.org, pubmed.ncbi.nlm.nih.gov, biorxiv.org and the publishers; filings and statistics are on the agency's own site; releases and specifications are on the maker's. A question about a named month or year is a date range to bound the search with, not a phrase to search for. Only after several genuinely different attempts have all come back with nothing may you say that nothing was found, and even then say what you did find and how you looked.

Brief. Plain text, no markdown. ${briefLength} If sources disagree, say which says what. Never pad a thin result with hedging: say the specific thing you found, however little it is. Only if every search truly failed do you say so plainly rather than guessing, and then say what you did find and what you tried. End with a line beginning "Sources:" listing each source you relied on as its title followed by its URL. Never cite a page you did not see in a result.`
}

// -- The loop --------------------------------------------------------------

interface ToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}')
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function formatResults(results: ExaResult[]): string {
  if (!results.length) return 'No results.'
  return results
    .map((result, index) => {
      const date = result.publishedDate ? ` (${result.publishedDate.slice(0, 10)})` : ''
      const passages = (result.highlights ?? []).join(' … ').trim()
      return `${index + 1}. ${result.title ?? hostname(result.url ?? '')}${date}\n   ${result.url ?? ''}\n   ${passages || '(no passage)'}`
    })
    .join('\n')
}

/**
 * The sources the brief actually leaned on: those whose URL it names. Falls
 * back to everything seen, because a brief that forgot its Sources line still
 * came from somewhere and the ledger should say where.
 */
function citedSources(brief: string, seen: Map<string, ResearchSource>): ResearchSource[] {
  const cited: ResearchSource[] = []
  for (const [url, source] of seen) {
    if (brief.includes(url) || brief.includes(url.replace(/\/$/, ''))) cited.push(source)
  }
  return (cited.length ? cited : [...seen.values()]).slice(0, 6)
}

/**
 * A tool call written out as text in a model's own markup instead of being
 * made. Nemotron did this in every measured run when it wanted another search.
 */
const TOOL_MARKUP = /<\/?tool_call>|<\|tool_call|\[TOOL_CALLS\]|<function[=\s>]|"name"\s*:\s*"(search|read)"/i

const WRITE_NOW =
  'Write the brief now, in plain text, from the results above. Do not call any more tools.'

interface AgentBrief {
  brief: string
  sources: ResearchSource[]
  materials: Material[]
  searches: number
  model: string
  visualizations?: VisualizationTrace[]
}

/** The desk's data sources, whose answers are materials a card is drawn from. */
const DATA_TOOLS = new Set(['country_data', 'entity_facts', 'top_stories'])

/** The pages a material should be cited by: its source, or every story's own page. */
function citations(material: Material): Array<[url: string, title: string]> {
  if (material.kind === 'table') return [[material.source.url, material.source.title]]
  if (material.kind === 'stories') return material.items.map((story) => [story.url, `${story.headline} (${story.host})`])
  if (material.kind === 'series') return [[material.source.url, `${material.source.title}: ${material.name}`]]
  if (material.kind === 'weather') return [[material.source.url, `${material.source.title}: ${material.place.name}`]]
  return [[material.source.url, `${material.source.title}: ${material.subject}`]]
}

/** Strings from a model's array argument, or a single string it gave instead of an array. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

async function runAgent(
  question: string,
  options: ResearchOptions,
  deps: ResearchDeps,
  signal: AbortSignal,
  /**
   * Where the run's materials are kept, by id, so a subject looked up twice is
   * one material. Owned by the caller, so what was fetched survives a run that
   * does not finish.
   */
  materials: Map<string, Material> = new Map(),
  visualizations: VisualizationTrace[] = [],
): Promise<AgentBrief> {
  if (!deps.openrouterHeaders) throw new Error('openrouter not configured')

  const maxRounds = options.depth === 'deep' ? MAX_ROUNDS_DEEP : MAX_ROUNDS
  const history: ChatMessage[] = [
    { role: 'system', content: researcherPrompt(deps.now(), options.timezone ?? 'UTC', options.depth) },
    { role: 'user', content: question },
  ]
  const seen = new Map<string, ResearchSource>()
  const tables = new Map<string, CapturedTable>()
  let pagesRead = 0
  const track = (trace: VisualizationTrace) => { if (visualizations.length < 16) visualizations.push(trace) }
  let searches = 0
  let modelUsed = deps.model
  let writing = false

  // One round past the cap, for a model that has to be told to write.
  for (let round = 0; round <= maxRounds + 1; round += 1) {
    const last = writing || round >= maxRounds
    const response = await deps.fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: deps.openrouterHeaders,
      body: JSON.stringify({
        model: deps.model,
        models: [deps.fallbackModel],
        messages: history,
        // The final round is for writing, so it is offered nothing to call.
        ...(last ? {} : { tools: RESEARCH_TOOLS, tool_choice: round === 0 ? 'required' : 'auto' }),
        provider: { sort: 'latency', allow_fallbacks: true },
        reasoning: { effort: deps.effort, exclude: true },
        temperature: 0.2,
      }),
      signal,
    })
    if (!response.ok) {
      void response.body?.cancel()
      throw new Error(`research model ${response.status}`)
    }

    const body = (await response.json()) as {
      model?: string
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>
    }
    if (typeof body.model === 'string' && body.model) modelUsed = body.model
    const message = body.choices?.[0]?.message
    const calls = (message?.tool_calls ?? []).filter((call) => call?.function?.name)
    const content = typeof message?.content === 'string' ? message.content.trim() : ''

    if (!calls.length || last) {
      const looked = searches > 0 || seen.size > 0
      if (content && looked && !TOOL_MARKUP.test(content)) {
        return {
          brief: content,
          sources: citedSources(content, seen),
          materials: [...materials.values()],
          ...(visualizations.length ? { visualizations: [...visualizations] } : {}),
          searches,
          model: modelUsed,
        }
      }
      // Two things are not a brief: an answer given before any lookup, which is
      // the model's memory and exactly what this desk exists to replace, and a
      // tool call written out as text, which read aloud is noise. A model that
      // looked gets one round to write properly; one that never looked is given
      // up on, and the direct answer stands in.
      if (writing || !looked) throw new Error('research model produced no grounded brief')
      writing = true
      history.push({ role: 'user', content: WRITE_NOW })
      continue
    }

    history.push({ role: 'assistant', content, tool_calls: calls })

    // Every call in a round runs at once. The model was told to issue several
    // searches together precisely so the user does not wait for them in series.
    const outcomes = await Promise.all(
      calls.map(async (call): Promise<string> => {
        const args = parseArgs(call.function.arguments)
        try {
          if (call.function.name === 'search') {
            const query = typeof args.query === 'string' ? args.query.trim() : ''
            if (!query) return 'The search had no query.'
            const recency = RECENCIES.includes(args.recency as Recency) ? (args.recency as Recency) : 'any'
            searches += 1
            const results = await exaSearch(deps, query, recency, signal)
            for (const source of toSources(results)) seen.set(source.url, source)
            return formatResults(results)
          }
          if (call.function.name === 'read') {
            const url = typeof args.url === 'string' ? args.url.trim() : ''
            if (!/^https?:\/\//.test(url)) return 'That is not a URL from a result.'
            const page = await exaRead(deps, url, signal)
            if (!page?.text) return 'The page could not be read.'
            for (const source of toSources([page])) seen.set(source.url, source)
            const captured = captureTables(page.text, { title: page.title ?? hostname(url), url: page.url || url, fetchedAt: new Date(deps.now()).toISOString() }, `page${++pagesRead}`)
            const accepted = captured.slice(0, Math.max(0, 8 - tables.size))
            for (const table of accepted) tables.set(table.id, table)
            track({ stage: 'capture', outcome: accepted.length ? 'ready' : 'unavailable', reason: accepted.length ? 'ready' : 'no_table', rows: accepted.reduce((count, table) => count + table.rows.length, 0) })
            const catalog = accepted.map((table) => `${table.id}: ${table.rows.length} rows; ${table.headers.map((header, index) => `${index}=${header}`).join(', ')}`).join('\n')
            return `${page.title ?? hostname(url)}\n${page.text}${catalog ? `\nCaptured source tables (use visualize_table without another fetch):\n${catalog}` : ''}`
          }
          if (call.function.name === 'visualize_table') {
            const result = mediateTable(tables.get(typeof args.table_id === 'string' ? args.table_id : ''), args)
            if (result.material && args.replace_existing !== true && !materials.has(result.material.id) && [...materials.values()].filter(m => m.kind === 'table').length >= 4) {
              track({ ...result.trace, outcome: 'unavailable', reason: 'too_many_rows' })
              return 'Four selected visualizations are already retained. This selection was not added. Use replace_existing=true only to deliberately replace the existing selection.'
            }
            track(result.trace)
            if (result.material && !signal.aborted) {
              if (args.replace_existing === true) for (const [id, material] of materials) if (material.kind === 'table') materials.delete(id)
              materials.set(result.material.id, result.material)
              seen.set(result.material.source.url, { title: result.material.source.title, url: result.material.source.url })
            }
            return result.message
          }
          if (DATA_TOOLS.has(call.function.name)) {
            const lookup: DeskLookup<Material> =
              call.function.name === 'country_data'
                ? await countryData(
                    {
                      countries: strings(args.countries ?? args.country),
                      indicator: typeof args.indicator === 'string' ? args.indicator : '',
                      since: typeof args.since === 'number' ? args.since : undefined,
                    },
                    deps,
                    signal,
                  )
                : call.function.name === 'entity_facts'
                  ? await entityFacts({ titles: strings(args.titles ?? args.title) }, deps, signal)
                  : await topStories(
                      { topic: typeof args.topic === 'string' ? args.topic : '', since: args.since === 'week' ? 'week' : 'day' },
                      deps,
                      signal,
                    )
            if (!lookup.ok) return lookup.text
            const cite = new Map<string, string>()
            for (const material of lookup.materials) {
              materials.set(material.id, material)
              for (const [url, title] of citations(material)) {
                cite.set(url, title)
                seen.set(url, { title, url })
              }
            }
            const sources = [...cite].map(([url, title]) => `${title} ${url}`).join('\n')
            return `${lookup.text}\nCite as:\n${sources}`
          }
          return `There is no tool called ${call.function.name}.`
        } catch (error) {
          if (signal.aborted) throw error
          return 'That lookup failed. Try a different query or answer from what you have.'
        }
      }),
    )

    for (const [index, call] of calls.entries()) {
      history.push({ role: 'tool', tool_call_id: call.id, content: outcomes[index] })
    }
  }

  throw new Error('research loop overran')
}

// -- One run: the researcher, hedged ----------------------------------------

type Outcome = Omit<ResearchResult, 'ms'>

const UNAVAILABLE =
  'The research could not be completed right now, so you have no live answer. Say so in one sentence rather than guessing.'

function failed(signal: AbortSignal): Outcome {
  return {
    ok: false,
    brief: signal.aborted ? 'Cancelled.' : UNAVAILABLE,
    sources: [],
    materials: [],
    via: 'none',
    model: '',
    searches: 0,
  }
}

/** Never rejects: a failed direct answer is an outcome like any other. */
async function directAnswer(deps: ResearchDeps, question: string, signal: AbortSignal): Promise<Outcome> {
  try {
    const { answer, sources } = await exaAnswer(deps, question, signal)
    if (!answer.trim()) return failed(signal)
    const cited = sources.map((source) => `${source.title} ${source.url}`).join('; ')
    return {
      ok: true,
      brief: cited ? `${answer}\nSources: ${cited}` : answer,
      sources,
      materials: [],
      via: 'answer',
      model: 'exa',
      searches: 1,
    }
  } catch {
    return failed(signal)
  }
}

const never = new Promise<never>(() => undefined)

/**
 * The researcher, with a direct answer held in reserve.
 *
 * Past `hedgeAfterMs` a direct answer races the research model, and whichever
 * produces a usable answer first is kept. A hedge that fails is ignored rather
 * than reported, and the research model gets until the budget. This is the
 * tail-latency trick from distributed systems, applied to a person waiting for
 * an answer: the slowest runs stop being the ones the user remembers.
 *
 * The direct answer is asked for at the start, not at the deadline, so that
 * when a hedge is needed it is already there. Asked for only at the deadline it
 * arrived about 1.8 seconds later, which is silence on exactly the turns that
 * were already slow. It still cannot win before `hedgeAfterMs`: on the same
 * questions it was graded below the research model, 7.1 against 7.4.
 */
/**
 * How much longer "deep" is allowed before the hedge or the budget cuts it
 * off. Asked for on purpose, so the person waiting knows why: reading a paper
 * itself takes longer than reading what a search result says about it.
 */
const DEEP_TIMING_SCALE = 1.8

async function hedgedRun(
  question: string,
  options: ResearchOptions,
  deps: ResearchDeps,
  signal: AbortSignal,
): Promise<ResearchResult> {
  const startedAt = deps.now()
  const finish = (outcome: Outcome): ResearchResult => ({ ...outcome, ms: deps.now() - startedAt })
  const timing =
    options.depth === 'deep'
      ? { ...deps.timing, hedgeAfterMs: Math.round(deps.timing.hedgeAfterMs * DEEP_TIMING_SCALE), budgetMs: Math.round(deps.timing.budgetMs * DEEP_TIMING_SCALE) }
      : deps.timing
  const { hedgeAfterMs, budgetMs, answerTimeoutMs } = timing

  const agentStop = new AbortController()
  const hedgeStop = new AbortController()

  const hedge = directAnswer(
    deps,
    question,
    AbortSignal.any([signal, hedgeStop.signal, AbortSignal.timeout(hedgeAfterMs + answerTimeoutMs)]),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const hedgeDue = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, hedgeAfterMs)
  })

  // What the research model's data lookups returned, kept even if its run
  // loses: the figures came from the source, whoever writes the brief.
  const collected = new Map<string, Material>()
  const visualizationTrace: VisualizationTrace[] = []
  const agent = runAgent(
    question,
    options,
    deps,
    AbortSignal.any([signal, agentStop.signal, AbortSignal.timeout(budgetMs)]),
    collected,
    visualizationTrace,
  ).then(
    (brief): Outcome => ({ ok: true, via: 'agent', ...brief }),
    () => null,
  )
  // Only a usable hedge competes; a failed one leaves the research model to finish.
  const hedgeWin = hedgeDue.then(() => hedge).then((outcome) => (outcome.ok ? outcome : never))
  /**
   * A direct answer that wins still comes with whatever the research model had
   * already looked up. Measured on 14 September 2026, one comparison of two
   * countries' GDP ran past the hedge at 16 seconds, and the World Bank series
   * it had fetched in its first three went with it, leaving a card of words
   * where a chart was ready.
   */
  const withCollected = (outcome: Outcome): Outcome =>
    outcome.ok ? { ...outcome, ...(collected.size ? { materials: [...collected.values()] } : {}), ...(visualizationTrace.length ? { visualizations: [...visualizationTrace] } : {}) } : outcome

  try {
    const first = await Promise.race([agent, hedgeWin])
    if (first?.via === 'agent') {
      hedgeStop.abort()
      return finish(first)
    }
    if (first?.via === 'answer') {
      agentStop.abort()
      return finish(withCollected(first))
    }
    // The research model failed or ran out of time. Whatever the direct
    // answer produces is now the answer, and it may already be on its way.
    if (signal.aborted) return finish(failed(signal))
    return finish(withCollected(await hedge))
  } finally {
    clearTimeout(timer)
  }
}

// -- Sharing runs ----------------------------------------------------------

/**
 * One research run, shared by everyone asking the same question.
 *
 * Callers join rather than own it. A caller that stops waiting — a
 * speculative turn discarded because the final transcript said "what is" where
 * the partial said "what's" — leaves, but the run keeps going for a short
 * grace period, because the real turn is about to ask the same thing and would
 * otherwise start again from nothing. Only a run nobody has joined by the end
 * of the grace period is stopped.
 */
export class SharedRun {
  readonly promise: Promise<ResearchResult>
  private readonly stop = new AbortController()
  private waiting = 0
  private settled = false
  private grace: ReturnType<typeof setTimeout> | null = null

  constructor(
    start: (signal: AbortSignal) => Promise<ResearchResult>,
    private readonly graceMs: number,
  ) {
    this.promise = start(this.stop.signal).finally(() => {
      this.settled = true
      if (this.grace) clearTimeout(this.grace)
    })
    this.promise.catch(() => undefined)
  }

  /** The result, or null if `signal` gave up waiting first. */
  join(signal: AbortSignal): Promise<ResearchResult | null> {
    this.waiting += 1
    if (this.grace) {
      clearTimeout(this.grace)
      this.grace = null
    }

    return new Promise((resolve) => {
      let done = false
      const leave = (value: ResearchResult | null) => {
        if (done) return
        done = true
        signal.removeEventListener('abort', onAbort)
        this.waiting -= 1
        if (value === null) this.orphaned()
        resolve(value)
      }
      const onAbort = () => leave(null)

      if (signal.aborted) {
        leave(null)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.promise.then(leave, () => leave(null))
    })
  }

  private orphaned() {
    if (this.settled || this.waiting > 0) return
    this.grace = setTimeout(() => {
      if (!this.settled && this.waiting === 0) this.stop.abort()
    }, this.graceMs)
  }
}

// -- Cache -----------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60_000
const CACHE_LIMIT = 64
/** Formatting only: entities, word order, dates, signs and numbers are content. */
function questionKey(text: string): string {
  return text.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ')
}

interface CacheEntry {
  key: string
  at: number
  run: SharedRun
}

/**
 * How a brief says it came back with nothing, in the shapes it actually says
 * it. The words are rarely adjacent — "no specific AI research papers from
 * August 2026 could be found" puts four of them between "no" and "papers" —
 * so each pattern leaves room for the sentence in between, stopping at the
 * full stop so it never reads across into the next one.
 */
const EMPTY_HANDED = [
  /\b(could not|couldn't|cannot|can't|was unable|were unable|unable to|failed to find|did not (find|turn up|return)|didn't (find|turn up|return))\b/i,
  /\bno\b[^.!?]{0,48}?\b(results?|papers?|information|details?|data|sources?|records?|listings?|articles?|studies|milestones?|announcements?)\b/i,
  /\b(nothing|none)\b[^.!?]{0,24}\b(found|available|turned up)\b/i,
  /\bnot (publicly |currently |readily )?available\b/i,
]

/**
 * A run that searched and came back with nothing to say.
 *
 * This is the difference between "the web does not have it" and "that run did
 * not find it", and only the second one is true often enough to matter. Left
 * in the cache, one such brief answered every rephrasing of the question for
 * ten minutes: asking again in different words is exactly what a person does
 * when the first answer was a shrug, and it returned the same shrug instantly
 * without searching. A brief with no source behind it is the same thing said
 * more confidently.
 */
export function foundNothing(result: ResearchResult): boolean {
  if (!result.sources.length) return true
  // Only the answer itself, not the trailing list of sources, which can name a
  // page like "Nothing found in the archive" without the brief being empty.
  const answer = result.brief.split(/(^|\n)\s*Sources?:/i)[0]
  return EMPTY_HANDED.some((pattern) => pattern.test(answer))
}

/** Recent research, shared only for the same normalized question. */
export class ResearchCache {
  private entries: CacheEntry[] = []

  constructor(private readonly now: () => number = Date.now) {}

  lookup(question: string): SharedRun | null {
    const key = questionKey(question)
    const cutoff = this.now() - CACHE_TTL_MS
    this.entries = this.entries.filter((entry) => entry.at >= cutoff)
    return this.entries.find((entry) => entry.key === key)?.run ?? null
  }

  store(question: string, run: SharedRun) {
    this.entries.push({ key: questionKey(question), at: this.now(), run })
    if (this.entries.length > CACHE_LIMIT) this.entries.shift()
    // A run that failed, or came back empty-handed, is not an answer worth
    // repeating for ten minutes.
    void run.promise.then(
      (value) => {
        if (!value.ok || foundNothing(value)) this.forget(run)
      },
      () => this.forget(run),
    )
  }

  private forget(run: SharedRun) {
    this.entries = this.entries.filter((entry) => entry.run !== run)
  }

  get size() {
    return this.entries.length
  }
}

/** One cache for the process, shared across sessions: news is news for everyone. */
export const sharedCache = new ResearchCache()

// -- Entry point -----------------------------------------------------------

/**
 * Answers `question` from the live web, or says precisely why it could not.
 *
 * Never rejects: a research failure is a fact the speaking model needs to hear
 * about in one sentence, not an exception that ends the turn.
 */
export async function research(
  question: string,
  options: ResearchOptions,
  deps: ResearchDeps,
  cache: ResearchCache | null = sharedCache,
): Promise<ResearchResult> {
  const startedAt = deps.now()
  const elapsed = () => deps.now() - startedAt
  const cancelled = (): ResearchResult => ({ ...failed(options.signal), brief: 'Cancelled.', ms: elapsed() })

  const trimmed = question.trim()
  if (!trimmed) {
    return { ok: false, brief: 'No question was given.', sources: [], materials: [], via: 'none', model: '', searches: 0, ms: 0 }
  }
  if (!deps.exaKey) {
    return {
      ok: false,
      brief:
        'Research is not configured on this server, so you have no live information. Say so plainly and answer only from what you already know, making clear it may be out of date.',
      sources: [],
      materials: [],
      via: 'none',
      model: '',
      searches: 0,
      ms: 0,
    }
  }

  // Keyed apart from the ordinary question: a deep run answers differently, and
  // neither should ever hand its brief to the other.
  const cacheKey = options.depth === 'deep' ? `deep: ${trimmed}` : trimmed
  const existing = cache?.lookup(cacheKey)
  if (existing) {
    const joined = await existing.join(options.signal)
    if (!joined) return cancelled()
    if (joined.ok) return { ...joined, via: 'cache', ms: elapsed() }
    // A failed run is not worth repeating; fall through and try properly.
  }
  if (options.signal.aborted) return cancelled()

  const run = new SharedRun(
    (signal) => hedgedRun(trimmed, options, deps, signal),
    deps.timing.orphanGraceMs,
  )
  cache?.store(cacheKey, run)
  const result = await run.join(options.signal)
  return result ? { ...result, ms: elapsed() } : cancelled()
}
