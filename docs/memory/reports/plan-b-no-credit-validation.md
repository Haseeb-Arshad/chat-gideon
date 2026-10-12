# Plan B local validation without provider credits

12 October 2026. OpenRouter/provider spend for this run: **$0.00**.
No remote model or embedding calls were made.

| Check | Result |
|---|---|
| Memory, host/runtime, agent and inspector unit tests | 210 passed across 24 files |
| Disposable PostgreSQL authority, 36 safety scenarios, Plan B lifecycle/privacy, cutover and operational checks | 99 passed across six files |
| Internal 320-query replay | Complete; zero explicit-ingestion failures; no model answers generated |
| Cloudflare production build | Passed |
| TypeScript | Passed |
| Worker/browser bundle and credential boundaries | Passed |
| Guard probes | External fetch and direct socket connections both blocked before connecting |
| External requests during actual checks | Zero |

The test processes remove provider credentials, disable paid evaluation flags,
and preload a guard that blocks non-loopback fetch/socket connections. Local
PostgreSQL runs in a temporary owned cluster and is stopped after each suite.
Provider protocol tests use synthetic/mock responses. The 320-query report has
its own output directory and empty response cache, preserving the earlier paid
diagnostic and preventing old model answers from being mistaken for new proof.

An additional adversarial test reproduced an incorrect relationship: a model
hint could attach “I like coffee” as support for an existing “I like tea” memory.
The reconciler now checks matching content before trusting a corroboration hint.
Unrelated statements go through normal addition/reconciliation instead of
supporting or disputing the wrong target. Matching claims still corroborate;
matching claims with opposite polarity still raise a dispute. New unit tests
and a PostgreSQL test verify that no false support edge is persisted. The
broader suites and build passed after the fix.

This verifies local behavior and safety. It provides no new real-provider answer
quality, multilingual embedding quality, hosted Supabase/Queue execution, or
production latency measurement, and does not establish a 9.5 rating.

Repeat from the repository root:

```powershell
node scripts/memory-no-credit-checks.mjs
```

Machine-readable results: `output/memory-no-credit/results.json`. Individual
logs and the offline replay live in the same directory. Source changes for the
regression are in `src/lib/memory/learning.ts`, its unit tests, and
`backend/memory/src/plan-b.live.test.ts`.
