# Stage 01: Baseline, repository map, and truthful legacy receipts

Status: LOCAL_VERIFIED
Implementation commit or working-tree identifier: Stage 01 changes in the current worktree after `db4f6b4a4c8b958d2210fdd4659183a38ecee791`
Date: 2026-09-21
Environment: Windows 10.0.19045 x64, Node v22.13.0, npm 11.0.0, Vitest 4.1.5; local synthetic data only

## Prerequisite evidence

- No prior memory-runtime handoff was required by the Stage 01 entry gate.
- Read and followed `docs/memory/implementation/00-COMMON-INSTRUCTIONS.md`, `docs/memory/FOUNDATION-2026-09-21.md`, `docs/memory/implementation/00-PROGRESS.md`, the acceptance coverage map, and the complete Stage 01 prompt.
- Confirmed the feature branch and `master` both pointed to pushed `db4f6b4` before implementation. The pre-stage visualization work and memory prompt pack were already tested, committed as Haseeb Arshad, pushed to the feature branch, fast-forwarded into `master`, and pushed.

## Implemented behavior

- A new memory is reported as stored only if it survives admission into the returned corpus.
- When 400 existing records all have `uses > 0`, a new zero-use record is rejected with `ok: false`; the old corpus remains intact and no success action is emitted.
- An insertion at 399 records succeeds and reaches exactly 400 records.
- Formatting-equivalent statements still merge. Exact destructive matching remains unchanged.
- New text longer than 240 characters is rejected rather than silently truncated.
- `MemoryStore.save()` rejection becomes a failed memory tool receipt with a truthful action summary. It no longer escapes as an unhandled tool failure.
- The baseline adapter compares current lexical memory selection with a controlled profile/session-summary fixture. The latter is labeled `supplied-summary-fixture`; it is not a configured summarizer or a production quality claim.
- The fixture runner loads all 36 supplied seed cases. C26 executes against the actual legacy tool path; C33 and all out-of-stage cases remain explicit `NOT_IMPLEMENTED` records.

## Source and schema map

- `src/lib/tools/memory.ts`: admission result/rejection semantics and non-truncating validation.
- `src/lib/tools/registry.ts`: failed capacity, validation, and storage outcomes; action-ledger summaries.
- `src/lib/tools/memory.test.ts`: pure admission and validation regressions.
- `src/lib/tools/memory-tools.test.ts`: C26 and storage-save rejection tests.
- `src/lib/agent-core.test.ts`: action-ledger failure test.
- `src/lib/memory-baseline.ts`: read-only legacy and supplied-summary baseline adapters and metadata measurements.
- `src/lib/memory-baseline.test.ts`: baseline adapter tests.
- `src/lib/memory-baseline-runner.ts`: schema-backed fixture runner and report writer.
- `scripts/memory-baseline.test.ts`: executable runner entrypoint; `npm run memory:baseline` invokes it.
- `package.json`: adds the local `memory:baseline` script.
- `docs/memory/implementation-map.md`: actual runtime ownership, source layout, reserved flags, and boundaries.
- `docs/memory/reports/stage-01-baseline.json`: generated evidence report.
- `docs/memory/implementation/00-PROGRESS.md`: Stage 01 status updated to `LOCAL_VERIFIED`.

No database schema, PostgreSQL table, migration, provider adapter, vector index, automatic learning path, or production route was added.

## Decisions and deviations

- The existing memory architecture remains authoritative for this stage. No new mirror or persistence authority was introduced.
- The pure function reports capacity rejection before the tool writes, and the tool restores the original input list when a replacement candidate is rejected. This prevents a failed new fact from deleting the older fact it was intended to replace.
- Storage error text is intentionally generic. Provider/filesystem details are not sent to the model or action ledger.
- The supplied-summary comparison uses controlled synthetic summaries and a four-characters-per-token estimate. It is labeled as a fixture and is not a real summarizer benchmark.
- The baseline runner measures local selection and local JSON persistence only. It does not claim voice, deployment, PostgreSQL, provider, or production proof.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npm test -- src/lib/tools/memory.test.ts src/lib/tools/memory-tools.test.ts src/lib/memory-baseline.test.ts scripts/memory-baseline.test.ts src/lib/agent-core.test.ts` | Local Node/Vitest | PASS, 5 files / 50 tests | Test output; focused regression suite |
| `npm run memory:baseline` | Local Node/Vitest, synthetic fixtures | PASS, 36 records: 1 PASS, 0 FAIL, 35 NOT_IMPLEMENTED | `docs/memory/reports/stage-01-baseline.json` |
| `npx tsc --noEmit` | Local TypeScript | PASS | Command exit 0 |
| `npm test -- src/lib/tools/memory.test.ts src/lib/tools/memory-tools.test.ts backend/worker/src/memory.test.ts backend/worker/src/accounts.test.ts` | Local Node/Vitest | PASS, 4 files / 48 tests | Pre-stage and post-change focused Worker evidence |
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` | Local offline suite | PASS, 79 files / 905 tests | Local command output; no live tests included |
| `npm run build` | Local application and realtime build | PASS | Local build output |
| `npm run build:cloudflare` | Local Cloudflare build/typecheck | PASS | Local Cloudflare build output; this stage did not deploy |

Seed-case coverage:

- C26: executable `scripts/memory-baseline.test.ts`, capacity fixture through `runServerTool('remember')`, PASS.
- C33: executable runner record with `durable-quota-receipt`, `NOT_IMPLEMENTED`, because the legacy store has no quota contract.
- C01-C25 and C27-C32/C34-C36: retained in the runner denominator as `NOT_IMPLEMENTED` because they belong to later stages or are outside Stage 01.

Forbidden outcomes checked:

- A full hot cache cannot return `ok: true` for a record absent from the returned corpus.
- A failing `save()` cannot produce an `ok: true` remembered result.
- Overlength text is not silently truncated.
- A failed replacement admission cannot remove the prior record.
- The action ledger receives `ok: false` and a failure summary for capacity rejection.

## Operational behavior

- Legacy startup, signed-cookie ownership, Worker account resolution, Durable Object routing, and existing stores remain unchanged.
- Capacity and validation rejection do not call `save()` because no new durable list is valid; the original list is returned.
- A storage exception is caught at the memory tool boundary and returned as a failed receipt. The existing serialized store queue remains usable after a rejected mutation.
- The baseline runner uses a temporary local directory for its JSON persistence measurement and removes only that generated temporary directory in a `finally` block. It records no raw user text and does not use credentials or providers.
- To disable Stage 01 behavior, stop using the new `memory:baseline` script and revert only the Stage 01 commit. The legacy storage contract remains available; no deletion or migration is involved.

## Remaining gaps

- `NOT_IMPLEMENTED`: per-user durable quotas (C33), PostgreSQL authority, outbox, identity contracts, correction history, deletion suppression, conversation state, retrieval composition, extraction, Jev, inspector, migration, and production rollout.
- No staging or production verification was requested or performed. No PostgreSQL, provider, deployment, customer data, or voice transport was used.
- The local performance report is diagnostic only. It does not establish the foundation's p95 targets or end-to-end voice latency.
- `JsonMemoryStore` remains the existing Node/local adapter; Stage 01 does not make it a PostgreSQL-backed durable authority.

## Next stage contract

Stage 02 may rely on:

- `RememberResult` statuses `stored`, `merged`, and `rejected`, with rejection reasons `empty`, `too_long`, and `capacity`.
- `runServerTool('remember' | 'recall' | 'forget', args, context)` returning `ToolOutcome.ok === false` plus a safe summary when storage rejects a request.
- `src/lib/memory-baseline.ts` read-only adapter shape and `docs/memory/reports/stage-01-baseline.json` report boundary.
- `docs/memory/implementation-map.md` for the owner path and reserved source layout.

Next prompt: `docs/memory/implementation/02-contracts-and-identity.md`. Do not treat any `NOT_IMPLEMENTED` case in this handoff as passed.
