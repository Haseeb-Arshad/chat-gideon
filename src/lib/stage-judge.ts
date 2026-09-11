/**
 * Keeps the screen in step with the conversation.
 *
 * Cards stay on screen while the talk is about them, step aside when it moves
 * on, and come back when their topic does. Deciding that is a judgement about
 * topics, which is a model's job rather than a keyword match: "how old was he
 * when he died" is still about Einstein, and "this is so good" after a gallery
 * of cakes is still about the cakes.
 *
 * It runs beside the reply, never in front of it. The page says what it is
 * showing when a turn starts, one small model call decides whether that should
 * change, and the answer goes out as a `stage` frame whenever it is ready. A
 * slow or failed judgement leaves the screen exactly as it was.
 */

import type { ChatMessageInput } from './openrouter'
import { defaultDeps, type EnvReader } from './tools/research'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
export const JUDGE_MODEL = 'openai/gpt-4.1-mini'

const JUDGE_TIMEOUT_MS = 5_000
const MAX_CARDS = 12
/** Enough of the conversation to know what "he" and "that" refer to. */
const CONTEXT_MESSAGES = 6

export interface ScreenCard {
  id: string
  title: string
  query: string
  kind: string
}

export interface ScreenState {
  /** A card is in front of the user, as opposed to everything put away. */
  open: boolean
  front: string | null
  /** Oldest first. */
  cards: ScreenCard[]
}

export type StageMove = { op: 'tuck' } | { op: 'show'; card: string }

export interface JudgeDeps {
  fetch: typeof fetch
  openrouterHeaders: Record<string, string> | null
  model: string
  /** Sees the model's raw answer, for the live check to report what it said. */
  trace?: (content: string) => void
}

export function judgeDeps(env: EnvReader): JudgeDeps {
  const research = defaultDeps(env)
  return {
    fetch: research.fetch,
    openrouterHeaders: research.openrouterHeaders,
    model: env('OPENROUTER_JUDGE_MODEL') ?? JUDGE_MODEL,
  }
}

function clip(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
}

/** What the page says it is showing. It comes from the browser, so nothing is taken on trust. */
export function readScreen(value: unknown): ScreenState | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const cards: ScreenCard[] = []
  for (const item of Array.isArray(input.cards) ? input.cards.slice(-MAX_CARDS) : []) {
    if (!item || typeof item !== 'object') continue
    const card = item as Record<string, unknown>
    const id = clip(card.id, 120)
    const title = clip(card.title, 120)
    if (!id || !title || cards.some((existing) => existing.id === id)) continue
    cards.push({ id, title, query: clip(card.query, 240), kind: clip(card.kind, 16) })
  }
  if (!cards.length) return null
  const front = clip(input.front, 120)
  const open = input.open === true && cards.some((card) => card.id === front)
  return { open, front: open ? front : null, cards }
}

const KIND_WORDS: Record<string, string> = {
  entity: 'about a person, place or thing',
  figure: 'a number',
  news: 'a news story',
  gallery: 'pictures',
  answer: 'an answer',
}

/** The screen in words, with short labels the model can answer in. */
export function describeScreen(screen: ScreenState, labels: string[]): string {
  const lines = screen.cards.map(
    (card, index) =>
      `${labels[index]}: "${card.title}", ${KIND_WORDS[card.kind] ?? 'an answer'}, from "${card.query || card.title}"`,
  )
  const front = screen.cards.findIndex((card) => card.id === screen.front)
  const state =
    screen.open && front >= 0
      ? `${labels[front]} is open in front of the user.`
      : 'The cards are put away at the side of the screen, and none is open.'
  return `${lines.join('\n')}\n\n${state}`
}

/**
 * The model is asked what the message is about, never what the screen should
 * do. Asked for the move directly, with "when unsure, keep", it kept the cards
 * put away even when the talk came straight back to them: two of six live
 * cases wrong, and both of them the returns. What is on screen follows from
 * the answer in `decideMove`, where it cannot be got wrong in a new way.
 */
const JUDGE_PROMPT = `You keep the screen of a voice assistant in step with the conversation. The screen holds cards about things the assistant looked up, and pictures it found. At most one card is open in front of the user; the others are put away at the side.

Read the user's latest message in the light of the conversation, and decide which card, if any, it is about.

A message is about a card when it asks about, comes back to, reacts to, or asks to see that card's subject. That includes follow-ups that say he, she, it, they, them or that; reactions such as "wow" or "these look great"; and "go back to", "back to", "what about" or "show me that again" with the card's subject. It counts just the same when the card is put away: naming a put-away card's subject is coming back to it.

A message is about no card when it moves on to anything else: a new subject, small talk, a joke, or advice. If you cannot tell whether it has moved on, it is about the open card.

Reply with one JSON object and nothing else: {"about": "<the card's title, exactly as listed>" or null, "close": true or false}
close is true only when the user asks to close, hide or clear the screen.`

/**
 * Which card an answer names.
 *
 * Measured, the model answers with a card's title far more readily than with
 * its label: asked for "c1", it wrote "Albert Einstein" in every one of six
 * live cases, and matching labels alone read all of those as naming nothing.
 * So titles come first, then a title it shortened ("Einstein"), then labels.
 */
function cardNamed(about: unknown, screen: ScreenState, labels: string[]): number {
  if (typeof about === 'number') return labels.indexOf(`c${about}`)
  if (typeof about !== 'string') return -1
  const text = about.trim().toLowerCase()
  if (!text) return -1
  const titled = screen.cards.findIndex((card) => card.title.toLowerCase() === text)
  if (titled >= 0) return titled
  const exact = labels.indexOf(text)
  if (exact >= 0) return exact
  const labelled = text.match(/\bc(\d+)\b/)
  if (labelled) return labels.indexOf(`c${labelled[1]}`)
  if (text.length < 3) return -1
  return screen.cards.findIndex((card) => {
    const title = card.title.toLowerCase()
    return title.includes(text) || text.includes(title)
  })
}

/**
 * What the screen does about the model's reading of the message: nothing when
 * it is about the open card, bring a card forward when it is about that card,
 * step everything aside when it is about none.
 */
export function decideMove(raw: unknown, screen: ScreenState, labels: string[]): StageMove | null {
  if (!raw || typeof raw !== 'object') return null
  const { about, close } = raw as { about?: unknown; close?: unknown }
  if (close === true || about === null) return screen.open ? { op: 'tuck' } : null
  const index = cardNamed(about, screen, labels)
  // An answer naming no card at all is not an answer; the screen stays put.
  if (index < 0) return null
  const id = screen.cards[index].id
  if (screen.open && screen.front === id) return null
  return { op: 'show', card: id }
}

/** Never rejects; anything short of a clear answer is no move at all. */
export async function judgeScreen(
  messages: ChatMessageInput[],
  screen: ScreenState,
  deps: JudgeDeps,
  signal: AbortSignal,
): Promise<StageMove | null> {
  if (!deps.openrouterHeaders || !screen.cards.length || !messages.length) return null
  const labels = screen.cards.map((_, index) => `c${index + 1}`)
  const talk = messages
    .slice(-CONTEXT_MESSAGES)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${clip(message.content, 400)}`)
    .join('\n')

  try {
    const response = await deps.fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: deps.openrouterHeaders,
      body: JSON.stringify({
        model: deps.model,
        messages: [
          { role: 'system', content: JUDGE_PROMPT },
          {
            role: 'user',
            content: `Cards, oldest first:\n${describeScreen(screen, labels)}\n\nConversation, latest last:\n${talk}`,
          },
        ],
        response_format: { type: 'json_object' },
        // A dozen tokens of output, so the first one is nearly the whole wait.
        provider: { sort: 'latency', allow_fallbacks: true },
        temperature: 0,
        max_tokens: 40,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(JUDGE_TIMEOUT_MS)]),
    })
    if (!response.ok) {
      void response.body?.cancel()
      return null
    }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string') return null
    deps.trace?.(content)
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    return decideMove(JSON.parse(content.slice(start, end + 1)), screen, labels)
  } catch {
    return null
  }
}
