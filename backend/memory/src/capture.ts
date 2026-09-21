import type { EventEnvelope, MemoryReceipt, MemorySession } from '../../../src/lib/memory/contracts.ts'
import { PostgresMemoryStore, type CaptureOptions } from './postgres.ts'

/** Server-only capture seam. The session supplies identity, scope, grants, and policy epoch. */
export function captureCommittedEvent(
  store: PostgresMemoryStore,
  session: Pick<MemorySession, 'trust' | 'principal' | 'scope' | 'grants' | 'policyEpoch'>,
  event: EventEnvelope,
  options?: CaptureOptions,
): Promise<MemoryReceipt> {
  return store.captureEvent(session, event, options)
}
