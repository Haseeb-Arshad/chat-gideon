import type {
  AssertionCommit,
  AssertionVersion,
  DependencyRef,
  EventEnvelope,
  EventId,
  ExactVersionRef,
  MemoryFailure,
  MemoryStorageCapabilities,
  MemoryStorageTransaction,
  OutboxLease,
  ScopeId,
  ScopedCandidateQuery,
} from './contracts'

/**
 * Test-only adapter for policy and reducer conformance.
 *
 * This deliberately is not exported from the edge entry point and is not a
 * production persistence implementation. It supplies deterministic storage
 * capabilities to pure tests until Stage 03 provides the transactional
 * PostgreSQL authority.
 */
export class TestMemoryAdapter implements MemoryStorageCapabilities {
  private readonly events = new Map<string, EventEnvelope>()
  private readonly assertions = new Map<string, AssertionVersion>()
  private readonly suppressed = new Set<string>()
  private readonly dependencies = new Map<string, DependencyRef[]>()
  private readonly leases: OutboxLease[] = []
  private readonly locks = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()

  transaction<T>(work: (transaction: MemoryStorageTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => work(this.transactionView()))
    this.queue = run.catch(() => undefined)
    return run
  }

  suppress(reference: ExactVersionRef | { eventId: EventId }) {
    this.suppressed.add('eventId' in reference ? `event:${reference.eventId}` : `assertion:${reference.assertionId}:${reference.revision}`)
  }

  seedAssertion(assertion: AssertionVersion) {
    this.assertions.set(`${assertion.id}:${assertion.revision}`, structuredClone(assertion))
    this.dependencies.set(`${assertion.id}:${assertion.revision}`, [...assertion.dependencies])
  }

  private transactionView(): MemoryStorageTransaction {
    const adapter = this
    return {
      async findEventByIdempotency(idempotencyKey) {
        return structuredClone([...adapter.events.values()].find((event) => event.idempotencyKey === idempotencyKey) ?? null)
      },
      async insertEvent(event) {
        const existing = [...adapter.events.values()].find((candidate) => candidate.idempotencyKey === event.idempotencyKey)
        if (existing) return 'duplicate'
        adapter.events.set(event.id, structuredClone(event))
        return 'inserted'
      },
      async exactVersion(reference) {
        return structuredClone(adapter.assertions.get(`${reference.assertionId}:${reference.revision}`) ?? null)
      },
      async scopedCandidates(query: ScopedCandidateQuery) {
        const values = [...adapter.assertions.values()]
          .filter((candidate) => candidate.scopeId === query.scopeId && candidate.status !== 'deleted')
          .slice(0, query.limit)
        return structuredClone(values)
      },
      async withSlotLock<T>(scopeId: ScopeId, slot: { slotId: string }, work: () => Promise<T>) {
        const key = `${scopeId}:${slot.slotId}`
        if (adapter.locks.has(key)) throw new Error('test slot lock contention')
        adapter.locks.add(key)
        try {
          return await work()
        } finally {
          adapter.locks.delete(key)
        }
      },
      async commitAssertion(input: AssertionCommit) {
        const current = [...adapter.assertions.values()]
          .filter((candidate) => candidate.id === input.assertion.id)
          .sort((left, right) => right.revision - left.revision)[0]
        if (current?.status === 'deleted' || adapter.suppressed.has(`assertion:${input.assertion.id}:${current?.revision}`)) {
          return { ok: false, failure: { code: 'suppressed', message: 'The assertion is suppressed.', retryable: false } satisfies MemoryFailure }
        }
        if ((current?.revision ?? null) !== input.expectedRevision) {
          return { ok: false, failure: { code: 'conflict', message: 'The assertion revision changed.', retryable: true } satisfies MemoryFailure }
        }
        adapter.assertions.set(`${input.assertion.id}:${input.assertion.revision}`, structuredClone(input.assertion))
        adapter.dependencies.set(`${input.assertion.id}:${input.assertion.revision}`, [...input.assertion.dependencies])
        return { ok: true, revision: input.assertion.revision }
      },
      async leaseOutbox(limit, now, leaseMs) {
        const until = new Date(Date.parse(now) + leaseMs).toISOString()
        return adapter.leases.slice(0, limit).map((lease) => ({ ...lease, leasedUntil: until }))
      },
      async isSuppressed(target) {
        return 'eventId' in target
          ? adapter.suppressed.has(`event:${target.eventId}`)
          : adapter.suppressed.has(`assertion:${target.assertionId}:${target.revision}`)
      },
      async dependenciesFor(reference) {
        return structuredClone(adapter.dependencies.get(`${reference.assertionId}:${reference.revision}`) ?? [])
      },
    }
  }
}
