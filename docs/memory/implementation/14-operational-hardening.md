# Stage 14: Concurrency, security boundaries, load, recovery, and operational budgets

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Prove the memory runtime behaves honestly under failure and realistic load before any production cutover.

## Prerequisites and entry gate

- Completed [stage 13](13-comparative-evaluation.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Backend/worker deployment configuration, database migrations, identity/session policy, provider adapters, telemetry and stage 13 performance results.

## Implementation steps

1. Build a bounded synthetic workload varying users, corpus sizes, active sessions, write contention, cold/warm caches and extraction backlog. Record workload definition and environment.

2. Exercise concurrent writes on a small shared key set across multiple processes. Verify each successful receipt against final/version history, including first-slot insert races and retries.

3. Inject worker crashes, expired fences, duplicate deliveries, slow models, database loss, malformed responses and out-of-order invalidations. Verify typed failure and recovery without silent empty writes.

4. Measure p50/p95/p99 for capture, edit, event-to-ready, lookup, pack composition and first substantive audio. Count extra prefill and cache-renewal traffic; do not use filler audio to satisfy latency targets.

5. Implement per-user queue fairness, bounded concurrency, pool limits, input/result bounds, token budgets, backpressure and quota receipts. Prioritize explicit corrections/deletion over automatic maintenance.

6. Verify isolation at every ingress/read/hydration/export/debug endpoint. Attempt client tenant spoofing, forged assistant segments, cross-scope edges and memory prompt injection without real private data.

7. Review network/auth boundaries between Cloudflare and the canonical service. Recheck session revocation versus snapshot leases, token audience/client binding, and worker credentials.

8. Run full deletion during active retrieval/extraction and backup restore drills on disposable databases. Prevent readiness until ledger replay completes; verify derived data and source spans.

9. Implement model/index migration safeguards: shadow indexes, version compatibility checks, bounded rebuilds and rollback that preserves corrections/deletion.

10. Establish operational health/readiness, queue-age/error metrics, redacted logs and alerts for lost receipts, stale projection accumulation and purge failures. No raw personal text in default metrics.

11. Run affected full non-live tests, Node/realtime build and Cloudflare build. Inspect bundles for Node-only dependencies and server secrets. Record known unrelated failures without hiding them.

12. Write a runbook for startup, shutdown, provider outage, exhausted quota, stalled jobs, restore and disabled-memory fallback. Set realistic SLOs from measurements and document unresolved limits.

## Verification and acceptance scenarios

Relevant seed IDs: **C17, C18, C20, C21, C22, C23, C24, C25, C29, C30, C32, C33** from [acceptance scenarios](../acceptance-scenarios.json).

Real PostgreSQL and actual application transport are required for operational gates. A zero-failure finite suite is evidence for the exercised workload, not universal proof. Include canary data with deterministic forbidden-disclosure assertions.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Load/fault/security conformance suite, measured SLO report, operational budgets, dashboards/alerts configuration and recovery runbook.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/14-operational-hardening.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

No observed lost acknowledged writes, unauthorized disclosure, speculative persistence or resurrection in the defined suite; latency/backlog meet explicitly chosen limits or rollout remains blocked.

## Scope boundary

No unbounded load against customer production, destructive real-data restore, or disabling security controls to make tests pass.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 15](15-migration-and-rollout.md) as the next prompt.
