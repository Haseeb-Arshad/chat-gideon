# Stage 03: Transactional PostgreSQL authority, outbox, and fenced worker

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Implement a real canonical backend with durable capture and retry-safe background job execution, initially isolated from production memory.

## Prerequisites and entry gate

- Completed [stage 02](02-contracts-and-identity.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Stage 02 contracts; existing Supabase transport only for compatibility context; foundation concurrency and storage rules.

## Implementation steps

1. Create a Node-only API/worker module and an isolated TypeScript/build entry point using the stage 01 map. Reuse core contracts without bundling database drivers into Cloudflare.

2. Write ordered SQL migrations for principals/scopes/grants or trusted references, events, records, versions, evidence edges, projections/members, jobs, policy epochs and deletion suppression. Include tenant/scope keys and foreign-key consistency.

3. Add database constraints for unique event idempotency within its trusted namespace, unique record revisions, valid job states and required source references. Choose a safe scalar-slot lock strategy that also serializes the first insert when no slot row yet exists.

4. Provide local database startup and migration instructions plus a test harness using a disposable PostgreSQL database. Never run migrations against a discovered production URL by default; require an explicit test environment marker.

5. Implement capture as one transaction: validate trusted context, check consent, insert or return the existing event, enqueue its job, commit, then return the durable receipt. Reusing an idempotency key with different content must conflict.

6. Implement job claims with bounded batches, leases, attempts and fencing tokens. Use database coordination across processes. An expired worker cannot commit merely because its model result eventually arrived.

7. Keep long model calls outside transactions. Worker completion reacquires a transaction and verifies input revisions/epochs plus the current lease fence before persisting output.

8. Add retry/backoff with an upper bound and dead-letter status. Distinguish transient provider errors, invalid payloads, revoked inputs and permanently invalid work. Expose queue lag without raw conversation logs.

9. Implement bounded graceful shutdown and crash recovery; a committed event without a processed job remains discoverable. Jobs can execute more than once but effects must be idempotent.

10. Create server-only credential handling, narrowly scoped database access and request authentication. If using Supabase hosting, do not use several independent REST inserts as a transaction or expose a service-role key to clients.

11. Add migrations/status scripts, health versus readiness checks, connection-pool bounds and configuration validation. Treat absent database connectivity as unavailable, not an empty memory store.

12. Run multi-process contention and injected crash tests on real PostgreSQL. Document what was actually exercised and keep the live app integration disabled.

## Verification and acceptance scenarios

Relevant seed IDs: **C20, C21, C25** from [acceptance scenarios](../acceptance-scenarios.json).

Kill or fail execution before event commit, after commit but before worker claim, during a job, and after lease expiration. Verify no lost acknowledged capture, no duplicate durable effects, no stale-fence commit, and no cross-tenant reads. In-memory tests do not satisfy this gate.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Executable migrations, server/worker entry points, PostgreSQL adapter, local environment instructions, real database integration tests and queue observability.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/03-postgres-and-jobs.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

Real PostgreSQL proves atomic event/job capture, idempotent retry and fenced completion. If PostgreSQL cannot run, implementation may be prepared but this verification gate remains blocked.

## Scope boundary

Do not cut over the existing app, provision paid infrastructure, or introduce graph/queue services without a measured need.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 04](04-commands-and-temporal-versions.md) as the next prompt.
