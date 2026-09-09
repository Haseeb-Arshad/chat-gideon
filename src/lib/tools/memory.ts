/**
 * What GIDEON still knows tomorrow.
 *
 * The conversation itself is capped at a couple of dozen messages before it is
 * sent upstream, which is the right call for latency and the wrong one for
 * feeling like anybody is there: an agent that forgets your dog's name between
 * sessions is a search box with a voice. So durable facts are lifted out of the
 * conversation and kept separately, and a handful of the relevant ones are put
 * back in front of the model at the start of each turn.
 *
 * Retrieval is lexical rather than vector-based, and that is a deliberate
 * trade. An embedding index would rank better, but it costs an API round trip
 * on the critical path of every single turn — in a voice loop where the whole
 * budget to first sound is a few hundred milliseconds, that is the most
 * expensive possible place to spend one. Inverse document frequency over a few
 * hundred short facts runs in microseconds and, at this corpus size, ranks
 * close enough to be indistinguishable in practice.
 */

export type MemoryKind = 'fact' | 'preference' | 'plan' | 'person'

export interface Memory {
  id: string
  kind: MemoryKind
  /** One self-contained statement. Never a whole conversation turn. */
  text: string
  createdAt: string
  /** Last time this was retrieved, so live knowledge outranks stale knowledge. */
  usedAt: string
  uses: number
}

export interface MemoryStore {
  all: () => Promise<Memory[]>
  save: (memories: Memory[]) => Promise<void>
  /**
   * Read, transform and write as one indivisible step.
   *
   * Every caller computes a *whole replacement list* from what it read, so an
   * unguarded read-modify-write does not merely interleave — it silently drops
   * the other writer's work entirely. And this is not a rare race: memory is
   * touched on every single turn to record which facts were useful, so two
   * turns finishing near each other is the normal case rather than the corner
   * one. Serialising the whole cycle, not just the file write, is the only
   * thing that actually makes it safe.
   */
  mutate: <T>(change: (memories: Memory[]) => { memories: Memory[]; result: T }) => Promise<T>
}

/**
 * Shared serialisation for the stores below.
 *
 * The queue is a plain promise chain. It is deliberately kept alive across a
 * failed mutation, so one bad change cannot wedge every later one behind a
 * rejected promise.
 */
abstract class SerialisedStore implements MemoryStore {
  private queue: Promise<unknown> = Promise.resolve()

  abstract all(): Promise<Memory[]>
  abstract save(memories: Memory[]): Promise<void>

  mutate<T>(change: (memories: Memory[]) => { memories: Memory[]; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await this.all()
      const { memories, result } = change(current)
      await this.save(memories)
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}

/** Words too common to tell two facts apart. */
const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'not',
  'of', 'on', 'or', 'she', 'so', 'that', 'the', 'their', 'them', 'they', 'this', 'to', 'was',
  'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'you', 'your',
])

/**
 * Light suffix stripping, so a question does not have to use the same
 * inflection as the fact it is asking about.
 *
 * Without this the store is close to useless in practice: "what do I play"
 * fails to match "the user plays the cello" on a bare token match, and that is
 * the ordinary case rather than an edge one. It is nowhere near a full stemmer
 * and does not need to be — over a few hundred short facts the only job is to
 * collapse plurals, possessives and the common verb endings.
 */
export function stem(word: string): string {
  let value = word.replace(/'s$/, '')
  if (value.length <= 3) return value

  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`
  if (value.endsWith('sses')) return value.slice(0, -2)
  if (value.endsWith('s') && !value.endsWith('ss') && !value.endsWith('us')) {
    value = value.slice(0, -1)
  }

  for (const suffix of ['ing', 'ed'] as const) {
    if (!value.endsWith(suffix)) continue
    const root = value.slice(0, -suffix.length)
    if (root.length < 3) continue
    // "running" leaves "runn"; undoubling gets back to the actual root.
    return /([^aeiou])\1$/.test(root) ? root.slice(0, -1) : root
  }

  return value
}

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP.has(word))
    .map(stem)
    .filter((word) => word.length > 1)
}

export const MAX_MEMORIES = 400
export const MAX_MEMORY_LENGTH = 240

function normaliseText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, MAX_MEMORY_LENGTH)
}

/** Near-duplicate detection, so "likes tea" is not stored eleven times. */
export function similarity(a: string, b: string): number {
  const left = new Set(tokenise(a))
  const right = new Set(tokenise(b))
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / Math.max(left.size, right.size)
}

const DUPLICATE_THRESHOLD = 0.72

export interface ScoredMemory {
  memory: Memory
  score: number
}

/**
 * Rank memories against a query.
 *
 * Rare words carry the signal, so each term is weighted by inverse document
 * frequency across the store. Recency of *use* then breaks ties, which matters
 * because a fact that keeps coming up is more likely to be wanted again than
 * one recorded at the same time and never touched since.
 */
export function rank(memories: Memory[], query: string, now = Date.now()): ScoredMemory[] {
  const terms = tokenise(query)
  if (!terms.length || !memories.length) return []

  const documents = memories.map((memory) => new Set(tokenise(memory.text)))
  const frequency = new Map<string, number>()
  for (const document of documents) {
    for (const word of document) frequency.set(word, (frequency.get(word) ?? 0) + 1)
  }

  const scored: ScoredMemory[] = []
  for (let index = 0; index < memories.length; index += 1) {
    const document = documents[index]
    let score = 0
    for (const term of terms) {
      if (!document.has(term)) continue
      const seen = frequency.get(term) ?? 1
      score += Math.log(1 + memories.length / seen)
    }
    if (score <= 0) continue

    // A gentle recency bonus: enough to order equals, never enough to promote
    // an irrelevant fact over a relevant one.
    const ageDays = (now - Date.parse(memories[index].usedAt)) / 86_400_000
    scored.push({ memory: memories[index], score: score * (1 + 0.12 / (1 + ageDays)) })
  }

  return scored.sort((a, b) => b.score - a.score)
}

export interface RememberResult {
  status: 'stored' | 'merged'
  memory: Memory
}

/**
 * Adds a fact, folding it into a near-identical one rather than duplicating.
 *
 * Returns the whole list because the caller owns persistence; keeping the pure
 * transformation separate from the write is what makes this testable without a
 * filesystem.
 */
export function remember(
  memories: Memory[],
  kind: MemoryKind,
  rawText: string,
  now = new Date(),
): { memories: Memory[]; result: RememberResult } {
  const text = normaliseText(rawText)
  const stamp = now.toISOString()

  const existing = memories.find((memory) => similarity(memory.text, text) >= DUPLICATE_THRESHOLD)
  if (existing) {
    // The newer phrasing wins: a fact restated has usually been refined.
    const merged: Memory = { ...existing, text, kind, usedAt: stamp, uses: existing.uses + 1 }
    return {
      memories: memories.map((memory) => (memory === existing ? merged : memory)),
      result: { status: 'merged', memory: merged },
    }
  }

  const memory: Memory = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    text,
    createdAt: stamp,
    usedAt: stamp,
    uses: 0,
  }

  const next = [...memories, memory]
  if (next.length <= MAX_MEMORIES) return { memories: next, result: { status: 'stored', memory } }

  // Over the cap, drop what has gone longest without being useful rather than
  // simply the oldest: the oldest fact is often the most important one.
  const ordered = [...next].sort(
    (a, b) => a.uses - b.uses || Date.parse(a.usedAt) - Date.parse(b.usedAt),
  )
  const doomed = new Set(ordered.slice(0, next.length - MAX_MEMORIES))
  return {
    memories: next.filter((candidate) => !doomed.has(candidate)),
    result: { status: 'stored', memory },
  }
}

/** Marks the retrieved memories as used, so ranking learns from what helped. */
export function touch(memories: Memory[], used: Memory[], now = new Date()): Memory[] {
  if (!used.length) return memories
  const ids = new Set(used.map((memory) => memory.id))
  const stamp = now.toISOString()
  return memories.map((memory) =>
    ids.has(memory.id) ? { ...memory, usedAt: stamp, uses: memory.uses + 1 } : memory,
  )
}

export function isMemory(value: unknown): value is Memory {
  if (!value || typeof value !== 'object') return false
  const memory = value as Partial<Memory>
  return (
    typeof memory.id === 'string' &&
    typeof memory.text === 'string' &&
    typeof memory.createdAt === 'string' &&
    typeof memory.usedAt === 'string' &&
    typeof memory.uses === 'number' &&
    (memory.kind === 'fact' ||
      memory.kind === 'preference' ||
      memory.kind === 'plan' ||
      memory.kind === 'person')
  )
}

/**
 * An in-process store, which is all a single long-lived server needs.
 *
 * Writes are serialised through one promise chain rather than fired off in
 * parallel: two turns finishing together would otherwise race on the same file
 * and the loser's fact would vanish.
 */
export class JsonMemoryStore extends SerialisedStore {
  private cache: Memory[] | null = null

  constructor(private readonly path: string) {
    super()
  }

  async all(): Promise<Memory[]> {
    if (this.cache) return this.cache
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      this.cache = Array.isArray(parsed) ? parsed.filter(isMemory) : []
    } catch {
      // No file yet, unreadable, or not ours: start empty rather than fail a turn.
      this.cache = []
    }
    return this.cache
  }

  async save(memories: Memory[]): Promise<void> {
    this.cache = memories
    try {
      const { mkdir, writeFile, rename } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(this.path), { recursive: true })
      // Written aside and renamed so a crash mid-write cannot leave a
      // truncated file where the whole memory used to be. The temporary name
      // carries the process id because a second process sharing this file
      // would otherwise rename the same path out from under us.
      const temporary = `${this.path}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(memories, null, 2), 'utf8')
      await rename(temporary, this.path)
    } catch {
      // A read-only or ephemeral filesystem costs persistence, not the turn:
      // the in-process cache still serves this session.
    }
  }
}

/** Nothing is kept, and nothing fails. For a host with no writable disk. */
export class EphemeralMemoryStore extends SerialisedStore {
  private memories: Memory[] = []

  async all() {
    return this.memories
  }

  async save(memories: Memory[]) {
    this.memories = memories
  }
}
