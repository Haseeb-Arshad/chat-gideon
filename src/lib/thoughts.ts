/**
 * What GIDEON is thinking, for the small cloud beside its eyes.
 *
 * The one rule is that a thought is never invented. It is either the work
 * actually under way (a search, a look through memory, a guess at a sentence
 * still being spoken) or, when nothing is happening, something GIDEON really
 * is holding: a thing you told it, a topic left open, a card put away, a timer
 * running. A cloud of made-up musings would be charming for a day and a lie
 * after that, and every one of them would cost a model call. These cost
 * nothing: they are read off state the page already has.
 */

export type ThoughtIcon = 'dots' | 'search' | 'picture' | 'draw' | 'memory' | 'topic' | 'card' | 'timer'

export interface Thought {
  /** Stable for the same thought, so showing it again does not replay its entrance. */
  key: string
  /** Work is tied to what is happening now; an idle thought arrives by itself. */
  kind: 'work' | 'idle'
  icon: ThoughtIcon
  /** A few words at most. Empty for a thought that is only its icon. */
  text: string
}

/**
 * `private` keeps the cloud but never writes out something remembered about
 * the user, for a screen other people can see.
 */
export type ThoughtMode = 'on' | 'private' | 'off'
export const THOUGHT_MODES: ThoughtMode[] = ['on', 'private', 'off']

/** Long enough to say something, short enough to be read in a glance. */
const BRIEF = 30

/** Cuts at a word, never mid-word, and drops what a sentence trails off with. */
export function brief(text: string, max = BRIEF): string {
  const clean = text.replace(/\s+/gu, ' ').trim().replace(/[.!?,;:]+$/u, '')
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max + 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.5 ? cut.slice(0, space) : clean.slice(0, max)).replace(/[.!?,;:]+$/u, '')}…`
}

export interface WorkState {
  phase: string
  /** The tool call in progress, when there is one. */
  action: { name: string; detail: string } | null
  /** A reply has been started on a sentence the user has not finished. */
  guessing: boolean
}

const TOOLS: Record<string, { icon: ThoughtIcon; text: (detail: string) => string }> = {
  research: { icon: 'search', text: (detail) => brief(detail) || 'looking it up' },
  show_images: { icon: 'picture', text: (detail) => brief(detail) || 'finding pictures' },
  draw_illustration: { icon: 'draw', text: (detail) => brief(detail) || 'drawing' },
  recall: { icon: 'memory', text: () => 'what do I know…' },
  remember: { icon: 'memory', text: () => 'keeping that' },
  correct: { icon: 'memory', text: () => 'fixing that' },
  forget: { icon: 'memory', text: () => 'letting that go' },
}

/** The thought that goes with what is happening right now, or none. */
export function workThought(state: WorkState, mode: ThoughtMode): Thought | null {
  if (mode === 'off') return null
  if (state.action) {
    const tool = TOOLS[state.action.name]
    if (tool) return { key: `work:${state.action.name}:${state.action.detail}`, kind: 'work', icon: tool.icon, text: tool.text(state.action.detail) }
  }
  if (state.phase === 'thinking') return { key: 'work:thinking', kind: 'work', icon: 'dots', text: '' }
  // Already working on an answer while the sentence is still being said.
  if (state.guessing && state.phase === 'listening') return { key: 'work:guessing', kind: 'work', icon: 'dots', text: '' }
  return null
}

export interface IdleSources {
  /** Things the user has told GIDEON, as it stores them. */
  memories: readonly string[]
  /** Topics set aside and questions left open in this conversation. */
  topics: readonly string[]
  /** Titles of cards that have been put away. */
  cards: readonly string[]
  timers: readonly { label: string; fireAt: number }[]
  now: number
}

function remaining(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s left`
  // Rounded down: with four and a half minutes to go, there are not five left.
  const minutes = Math.floor(seconds / 60)
  if (minutes < 90) return `${minutes} min left`
  return `${Math.round(minutes / 60)} h left`
}

/** Everything GIDEON could truthfully be turning over while nothing is happening. */
export function idleThoughts(sources: IdleSources, mode: ThoughtMode): Thought[] {
  if (mode === 'off') return []
  const thoughts: Thought[] = []
  for (const timer of sources.timers) {
    if (timer.fireAt <= sources.now) continue
    const label = timer.label ? `${brief(timer.label, 16)} · ` : ''
    thoughts.push({ key: `idle:timer:${timer.fireAt}`, kind: 'idle', icon: 'timer', text: `${label}${remaining(timer.fireAt - sources.now)}` })
  }
  for (const topic of sources.topics) {
    const text = brief(topic)
    if (text) thoughts.push({ key: `idle:topic:${text}`, kind: 'idle', icon: 'topic', text })
  }
  for (const card of sources.cards) {
    const text = brief(card)
    if (text) thoughts.push({ key: `idle:card:${text}`, kind: 'idle', icon: 'card', text })
  }
  if (mode === 'private') {
    if (sources.memories.length) thoughts.push({ key: 'idle:memory:private', kind: 'idle', icon: 'memory', text: 'something you told me' })
  } else {
    for (const memory of sources.memories) {
      const text = brief(memory)
      if (text) thoughts.push({ key: `idle:memory:${text}`, kind: 'idle', icon: 'memory', text })
    }
  }
  return thoughts
}

/** One of them, and not the one it had last time if there is any other. */
export function pickIdle(thoughts: readonly Thought[], lastKey: string | null, random: () => number = Math.random): Thought | null {
  if (!thoughts.length) return null
  const fresh = thoughts.filter((thought) => thought.key !== lastKey)
  const pool = fresh.length ? fresh : thoughts
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]
}

/** A mind that wanders every few seconds is noise; this is the better part of a minute. */
export const IDLE_FIRST_MS = 22_000
export const IDLE_MIN_MS = 40_000
export const IDLE_SPAN_MS = 50_000
/** How long an idle thought stays before it drifts off. */
export const IDLE_HOLD_MS = 5_500

export function nextIdleDelay(first: boolean, random: () => number = Math.random): number {
  return first ? IDLE_FIRST_MS + random() * 10_000 : IDLE_MIN_MS + random() * IDLE_SPAN_MS
}

const MODE_KEY = 'gideon-thoughts'

export function readThoughtMode(): ThoughtMode {
  try {
    const stored = localStorage.getItem(MODE_KEY)
    return THOUGHT_MODES.includes(stored as ThoughtMode) ? (stored as ThoughtMode) : 'on'
  } catch {
    return 'on'
  }
}

export function saveThoughtMode(mode: ThoughtMode) {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // A blocked storage accessor only costs the preference its memory.
  }
}
