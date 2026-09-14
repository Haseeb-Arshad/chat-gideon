/**
 * The day's stories, for a front page.
 *
 * A front page is only as honest as its headlines, so no model writes them:
 * each headline is the publisher's own title and the deck under it is the
 * story's own passage saying what happened, from Exa's news search. What
 * happens here is cleaning and ordering. The publisher's name comes off a title
 * only when it matches the site the story is on, a section's name only when it
 * is set apart as one, a wire dateline comes off the start of a passage, and
 * stories about the same event from several outlets are one story, which is
 * how the lead is chosen: the story the most outlets are carrying.
 */

import type { StoriesMaterial, Story } from '../../cards/materials'
import { TimedCache } from './cache'
import type { DeskLookup } from './world-bank'

const EXA_URL = 'https://api.exa.ai'
const TIMEOUT_MS = 8_000
/** A lead and up to five more; the page shows as many of them as the stage has room for. */
export const FRONT_PAGE_STORIES = 6
const RESULTS = 12
/** A day in the user's timezone can have begun up to fourteen hours before UTC's. */
const WINDOWS = { day: 36, week: 7 * 24 } as const

export interface NewsDeps {
  fetch: typeof fetch
  now: () => number
  exaKey: string
}

interface ExaResult {
  title?: string
  url?: string
  publishedDate?: string
  image?: string
  highlights?: string[]
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Letters only, lower case: "The Straits Times" and "straitstimes.com" meet at "straitstimes". */
function squashed(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The labels a domain ends in that name no one: "bbc.co.uk" is the BBC's, not the co's. */
const SUFFIXES = new Set(['com', 'org', 'net', 'co', 'uk', 'au', 'nz', 'in', 'jp', 'de', 'fr', 'es', 'it', 'ca', 'gov', 'ac', 'edu', 'int', 'io', 'sg', 'pk', 'za'])

/** The name a site goes by: the last label of its address before the suffixes. */
export function siteName(host: string): string {
  const labels = host.toLowerCase().split('.')
  while (labels.length > 1 && SUFFIXES.has(labels[labels.length - 1])) labels.pop()
  return labels[labels.length - 1] ?? host
}

/** The words a name is joined with, which its initials leave out: the "of" in "Massachusetts Institute of Technology". */
const JOINING = new Set(['the', 'of', 'and', 'for', 'in', 'on', 'at', '&'])

/** Text without the characters that take up no room: one inside a word stops it matching, and no one reading can see it. */
function visible(text: string): string {
  return text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
}

/**
 * A title segment that is the publisher's name: it and the site's name contain
 * one another ("The Straits Times" at straitstimes.com), or the site's name is
 * its initials ("Financial Times" at ft.com, "Massachusetts Institute of
 * Technology" at mit.edu), or its initials and last word ("The New York Times"
 * at nytimes.com).
 */
function isPublisher(segment: string, host: string): boolean {
  const name = squashed(siteName(host))
  const words = squashed(segment)
  const parts = segment
    .split(/\s+/)
    .map((word) => (word === '&' ? word : squashed(word)))
    .filter((word) => word && !JOINING.has(word))
  if (words.length < 2 || parts.length > 5) return false
  if (words.includes(name) || name.includes(words.replace(/^the/, '')) || words.replace(/news$/, '') === name) return true
  const initials = parts.map((word) => word[0]).join('')
  const initialsAndLast = parts.slice(0, -1).map((word) => word[0]).join('') + (parts[parts.length - 1] ?? '')
  return parts.length > 1 && (initials === name || initialsAndLast === name)
}

/**
 * A segment after a bar at the end of a title that names a section or a site
 * rather than saying anything: "| Saudi Arabia", "| World news", "| MIT News".
 * Every word is capitalised but the words names are joined with, and a
 * section may end in "news". A headline that goes on after a bar ("| What
 * changes for taxpayers") has its words in lower case, and keeps them.
 */
function isSection(segment: string): boolean {
  const words = segment.trim().split(/\s+/)
  if (words.length > 5 || /[?!:;,.\d]/.test(segment)) return false
  return words.every((word, index) => /^\p{Lu}/u.test(word) || JOINING.has(word) || (index === words.length - 1 && word === 'news'))
}

/**
 * A publisher's title as a headline. "Germany's Alexander Zverev wins US Open |
 * DW" loses its "| DW", and "... supply fears | Saudi Arabia" its section;
 * "Ukraine - Russia talks resume" keeps both halves, because neither is the
 * site it is on.
 */
export function cleanHeadline(title: string, host: string): string {
  let headline = visible(title).replace(/\s+/g, ' ').trim()
  // Cut at the separators themselves, so the ones inside the headline stay as they were.
  const TRAILING = /^(.*\S)\s+([|–—-])\s+([^|–—]+)$/
  for (let match = headline.match(TRAILING); match && (isPublisher(match[3], host) || (match[2] === '|' && isSection(match[3]))); match = headline.match(TRAILING)) {
    headline = match[1]
  }
  for (let match = headline.match(/^([^|–—]+?)\s+[|–—-]\s+(\S.*)$/); match && isPublisher(match[1], host); match = headline.match(/^([^|–—]+?)\s+[|–—-]\s+(\S.*)$/)) {
    headline = match[2]
  }
  return headline
}

/** Abbreviations a sentence does not end at: "U.S. President", "Sept. 13", "Mr. Smith". */
const NOT_AN_END = /(?:\b[A-Z]|\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|No|vs|Gen|Gov|Sen|Rep|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec))\.$/

/** Whole sentences, in order: a sentence ends at a stop followed by a capital, unless the stop ends an abbreviation. */
function sentencesOf(text: string): string[] {
  const pieces = text.split(/(?<=[.!?]["'”’]?)\s+(?=["'“‘]?[A-Z0-9])/)
  const sentences: string[] = []
  for (const piece of pieces) {
    const previous = sentences[sentences.length - 1]
    if (previous !== undefined && NOT_AN_END.test(previous)) sentences[sentences.length - 1] = `${previous} ${piece}`
    else sentences.push(piece)
  }
  // The last piece of a passage is often cut off mid-sentence, and is not a sentence.
  return sentences.filter((sentence) => /[.!?]["'”’]?$/.test(sentence))
}

/**
 * What happened, in the story's own words: the first passage the search chose
 * that is prose rather than a fragment of an address, without the wire
 * dateline in front of it, cut at a sentence, at most thirty words.
 */
export function deckFrom(highlights: string[], headline: string): string {
  for (const highlight of highlights) {
    for (const chunk of highlight.split(/\s*(?:\.\.\.|…)\s*/)) {
      let text = visible(chunk).replace(/\s+/g, ' ').trim()
      if (!/^["'“‘A-Z]/.test(text) || text.includes('://')) continue
      // "ADEN, Yemen (AP) — ", "ABOARD AIR FORCE ONE, Sept 13 (Reuters) - ", "KYIV (UKRAINE) - "
      text = text.replace(/^[^.!?]{2,80}?(?:\((?:AP|AFP|Reuters|UPI|dpa)\)|[A-Z]{3,}[A-Z /,()'.-]*)\s+[–—-]\s+/, '')
      let deck = ''
      for (const sentence of sentencesOf(text)) {
        const next = `${deck} ${sentence}`.trim()
        if (next.split(/\s+/).length > 30) break
        deck = next
      }
      if (deck.split(/\s+/).length < 6) continue
      // A passage that is only the headline again says nothing more.
      if (squashed(deck).length <= squashed(headline).length + 12 && squashed(deck).startsWith(squashed(headline).slice(0, 40))) continue
      return deck
    }
  }
  return ''
}

const COMMON = new Set([
  'about', 'after', 'against', 'amid', 'over', 'says', 'said', 'will', 'with', 'from', 'into', 'that', 'this', 'their',
  'more', 'than', 'first', 'last', 'week', 'year', 'years', 'news', 'live', 'latest', 'update', 'report', 'reports',
])

function keyWords(headline: string): Set<string> {
  return new Set(
    headline
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !COMMON.has(word)),
  )
}

/** Two headlines about the same event share at least two of the words that name it. */
function sameStory(a: Set<string>, b: Set<string>): boolean {
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared >= 2
}

/** Stories grouped by event, the most widely carried first, each told by its best-illustrated telling. */
export function frontPage(results: ExaResult[]): Story[] {
  const tellings: Array<Story & { words: Set<string> }> = []
  for (const result of results) {
    const url = (result.url ?? '').trim()
    const host = hostOf(url)
    if (!/^https:\/\//.test(url) || !host || !result.title) continue
    const headline = cleanHeadline(result.title, host)
    const deck = deckFrom(result.highlights ?? [], headline)
    const image = typeof result.image === 'string' && result.image.startsWith('https://') ? result.image : undefined
    tellings.push({
      headline,
      deck,
      url,
      host,
      published: result.publishedDate ?? '',
      ...(image ? { image } : {}),
      outlets: 1,
      words: keyWords(headline),
    })
  }

  // A telling that matches several groups joins them into one: the same event
  // told three ways can arrive in an order where the first two share no words
  // with each other, only with the third.
  let groups: Array<Array<(typeof tellings)[number]>> = []
  for (const telling of tellings) {
    const matched = groups.filter((each) => each.some((other) => sameStory(other.words, telling.words)))
    groups = [...groups.filter((each) => !matched.includes(each)), [...matched.flat(), telling]]
  }

  return groups
    .map((group) => {
      // The telling with a picture and a deck, then whichever came first.
      const best = [...group].sort((a, b) => Number(Boolean(b.image && b.deck)) - Number(Boolean(a.image && a.deck)))[0]
      const { words: _words, ...story } = best
      return { ...story, outlets: new Set(group.map((each) => each.host)).size }
    })
    .filter((story) => story.deck)
    .sort((a, b) => b.outlets - a.outlets)
    .slice(0, FRONT_PAGE_STORIES)
}

const cache = new TimedCache<Story[]>(10 * 60_000)

export interface TopStoriesArgs {
  topic?: string
  since?: 'day' | 'week'
}

/** Each story's headline, outlet, date and deck; the desk lists their links after them to cite by. */
function describeStories(stories: Story[]): string {
  return stories
    .map((story, index) => `${index + 1}. ${story.headline} (${story.host}${story.published ? `, ${story.published.slice(0, 10)}` : ''})\n   ${story.deck}`)
    .join('\n')
}

/** The stories for a front page, and the words to brief with. Never rejects but on abort. */
export async function topStories(args: TopStoriesArgs, deps: NewsDeps, signal: AbortSignal): Promise<DeskLookup<StoriesMaterial>> {
  if (!deps.exaKey) return { ok: false, text: 'News search is not configured here.' }
  const topic = typeof args.topic === 'string' ? args.topic.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  const since = args.since === 'week' ? 'week' : 'day'
  const now = deps.now()

  const load = async (): Promise<Story[]> => {
    const response = await deps.fetch(`${EXA_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': deps.exaKey },
      body: JSON.stringify({
        query: topic ? `${topic} news` : 'top news stories today',
        type: 'fast',
        category: 'news',
        numResults: RESULTS,
        startPublishedDate: new Date(now - WINDOWS[since] * 3_600_000).toISOString(),
        contents: { highlights: { maxCharacters: 600, query: 'what happened' } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      void response.body?.cancel()
      throw new Error(`exa news ${response.status}`)
    }
    const body = (await response.json()) as { results?: ExaResult[] }
    return frontPage(body.results ?? [])
  }

  let stories: Story[]
  try {
    stories = await Promise.race([
      cache.get(`${topic.toLowerCase()}|${since}`, load, (found) => found.length > 0),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ])
  } catch (error) {
    if (signal.aborted) throw error
    return { ok: false, text: 'The news search did not answer just now. Search instead.' }
  }
  if (stories.length < 3) {
    return { ok: false, text: `Too few stories${topic ? ` about ${topic}` : ''} were found for a front page. Search instead.` }
  }

  const material: StoriesMaterial = {
    id: `news:${squashed(topic) || 'headlines'}:${since}`,
    kind: 'stories',
    topic,
    since,
    items: stories,
    source: { title: 'News', url: stories[0].url, fetchedAt: new Date(now).toISOString() },
  }
  return {
    ok: true,
    materials: [material],
    text: `Stories${topic ? ` about ${topic}` : ''}, the most widely reported first:\n${describeStories(stories)}\nThese are shown on the user's screen as a front page. Brief the top two or three in a sentence each, in your own words, with their dates.`,
  }
}

/** For tests: forget every search. */
export function forgetNews() {
  cache.clear()
}
