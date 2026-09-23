import type { ConversationState } from '../conversation-state'
import type { Condition, ValidTime } from './contracts'
import {
  MAX_RETRIEVAL_RECENT_TURN_CHARS,
  MAX_RETRIEVAL_RECENT_TURNS,
  type RetrievalActivity,
  type RetrievalRecentTurn,
  type RetrievalRequestInput,
  type RetrievalTaskOverride,
} from './retrieval'

/**
 * Deterministic bridge from the bounded conversation state to Stage 08
 * retrieval inputs and to explicit memory command shapes.
 *
 * Nothing here interprets free text. Topic, recent turns and local
 * instructions come only from committed conversation events; the activity kind
 * stays unknown until an interpreter supplies it, so activity-conditioned
 * constraints remain conditional rather than guessed.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u
const TRUNCATED = ' …[truncated]'
const MAX_TASK_OVERRIDES = 8

type RecallFields = Pick<RetrievalRequestInput, 'resolved' | 'activity' | 'recentSpan' | 'taskOverrides'>

function safeId(value: string | null | undefined): string | null {
  return value && ID.test(value) ? value : null
}

function bounded(text: string, max: number): string {
  const clean = text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - TRUNCATED.length).trimEnd()}${TRUNCATED}`
}

function sameText(left: string, right: string): boolean {
  return left.normalize('NFKC').replace(/\s+/gu, ' ').trim() === right.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

export function recallFieldsFromConversation(state: ConversationState | null, latestUserText: string): RecallFields {
  const topic = state?.activeTopic ?? null
  const topicId = safeId(topic?.topicId)
  const topicLabel = topic ? bounded(topic.label, 160) || null : null
  const activity: RetrievalActivity = { kind: null, topicId, topicLabel, projectId: null, format: null, attributes: {} }
  const resolved: RecallFields['resolved'] = { topicId, topicLabel, entities: [], assertionIds: [], artifactIds: [], unknownReferents: [] }
  if (!state) return { resolved, activity, recentSpan: [], taskOverrides: [] }

  // The newest user turn is the query itself; the span is what came just before it.
  const turns = [...state.recentTurns].sort((left, right) => left.sequence - right.sequence)
  const last = turns[turns.length - 1]
  const prior = last && last.role === 'user' && sameText(last.text, latestUserText) ? turns.slice(0, -1) : turns
  const recentSpan: RetrievalRecentTurn[] = prior.slice(-MAX_RETRIEVAL_RECENT_TURNS).flatMap((turn) => {
    const said = turn.delivery === 'interrupted' ? turn.heardText ?? '' : turn.text
    const text = bounded(said, MAX_RETRIEVAL_RECENT_TURN_CHARS)
    return text ? [{ role: turn.role, text, topicId, sequence: turn.sequence, committed: true as const, relevance: 'current_task' as const }] : []
  })

  const taskOverrides: RetrievalTaskOverride[] = state.localConstraints
    .filter((item) => item.status === 'active' && (!item.topicId || item.topicId === topic?.topicId) && safeId(item.constraintId))
    .slice(-MAX_TASK_OVERRIDES)
    .map((item) => ({
      id: item.constraintId,
      kind: 'constraint' as const,
      text: bounded(item.text, 1_024),
      supersedesAssertionIds: [],
      conditions: [],
      authority: 'current_user_explicit' as const,
    }))

  return { resolved, activity, recentSpan, taskOverrides }
}

/** Midnight of a calendar date in the user's zone, as a UTC instant. */
function zonedMidnight(date: string, timeZone: string): string | null {
  const [year, month, day] = date.split('-').map(Number)
  const guess = Date.UTC(year!, month! - 1, day!)
  if (!Number.isFinite(guess)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(guess))
      .reduce<Record<string, number>>((all, part) => (part.type === 'literal' ? all : { ...all, [part.type]: Number(part.value) }), {})
    const asZoned = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!)
    return new Date(guess - (asZoned - guess)).toISOString()
  } catch {
    return null
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u

function validZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return 'UTC'
  }
}

export type MemoryShapeResult<T> = { ok: true; value: T } | { ok: false; message: string }

export interface RememberShape {
  conditions: Condition[]
  relation?: 'temporary_exception'
  validTime?: ValidTime
}

/**
 * `appliesTo: 'this_topic'` scopes a preference to the active topic;
 * `until` (a calendar date) makes it a temporary exception that expires at the
 * end of that day in the user's zone. Neither rewrites a general preference.
 */
export function rememberShape(args: Record<string, unknown>, state: ConversationState | null, timezone: string, now: Date): MemoryShapeResult<RememberShape> {
  const conditions: Condition[] = []
  if (args.appliesTo === 'this_topic') {
    const topicId = safeId(state?.activeTopic?.topicId)
    if (!topicId) return { ok: false, message: 'There is no active topic to scope that memory to.' }
    conditions.push({ key: 'topic', operator: 'equals', value: topicId })
  }
  const until = typeof args.until === 'string' ? args.until.trim() : ''
  if (!until) return { ok: true, value: { conditions } }
  if (!DATE.test(until)) return { ok: false, message: 'An expiry must be a calendar date such as 2026-10-01.' }
  const zone = validZone(timezone)
  const nextDay = new Date(Date.parse(`${until}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)
  const end = zonedMidnight(nextDay, zone)
  if (!end || Date.parse(end) <= now.getTime()) return { ok: false, message: 'That expiry date has already passed.' }
  return {
    ok: true,
    value: {
      conditions,
      relation: 'temporary_exception',
      validTime: { from: now.toISOString(), until: end, precision: 'second', sourceTimeZone: zone },
    },
  }
}

export interface CorrectShape {
  relation: 'correction' | 'transition'
  validTime?: ValidTime
}

/**
 * `change: 'mistake'` (default) says the stored value was never right;
 * `change: 'changed'` says it was right and the world moved on. A transition
 * needs a start, so without a stated date it is recorded as changed as of the
 * day the user reported it, at day precision in their zone.
 */
export function correctShape(args: Record<string, unknown>, timezone: string, now: Date): MemoryShapeResult<CorrectShape> {
  if (args.change !== 'changed') return { ok: true, value: { relation: 'correction' } }
  const zone = validZone(timezone)
  const stated = typeof args.since === 'string' ? args.since.trim() : ''
  const since = stated || new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  if (!DATE.test(since)) return { ok: false, message: 'A change date must be a calendar date such as 2026-06-01.' }
  const from = zonedMidnight(since, zone)
  if (!from) return { ok: false, message: 'That change date could not be read.' }
  return { ok: true, value: { relation: 'transition', validTime: { from, until: null, precision: 'day', sourceTimeZone: zone } } }
}
