import { createHash } from 'node:crypto'
import type {
  AssertionVersion,
  ClaimSubject,
  EventEnvelope,
  RevisionId,
} from '../../../src/lib/memory/contracts.ts'

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, ordered(item)]))
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(ordered(value))
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')
}

export function eventContentHash(scopeId: string, event: EventEnvelope): string {
  // Event sequence is a server-allocated ordering field, not source content.
  // Excluding it lets a retried capture keep one idempotency key while the
  // transaction assigns the next available per-scope sequence exactly once.
  const { id: _id, receivedAt: _receivedAt, sequence: _sequence, ...semantic } = event
  return sha256({ scopeId, event: semantic })
}

export function assertionVersionHash(assertion: AssertionVersion): string {
  return sha256(assertion)
}

export function subjectKey(subject: ClaimSubject): string {
  return subject.kind === 'known' ? `known:${subject.subjectId}` : `unresolved:${subject.label ?? ''}`
}

export function revisionId(assertionId: string, revision: number): RevisionId {
  return `revision/${assertionId}/${revision}` as RevisionId
}

export function isoNow(): string {
  return new Date().toISOString()
}
