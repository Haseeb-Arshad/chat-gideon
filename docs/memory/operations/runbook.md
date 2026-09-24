# Memory runbook (PostgreSQL authority, Node host)

Scope: the Node host's memory runtime (`backend/memory`, `src/server/node-memory-integration.ts`).
The Cloudflare Worker build resolves memory to a stub and never touches this
database. Every command below prints counts and ids only, never memory text.

Environment:
- `GIDEON_MEMORY_DATABASE_URL`: the authority.
- Pool and timeouts: `GIDEON_MEMORY_POOL_MAX` (default 8), `_CONNECTION_TIMEOUT_MS`
  (3 s), `_IDLE_TIMEOUT_MS` (30 s), `_STATEMENT_TIMEOUT_MS` (10 s).
- Feature switches: `GIDEON_MEMORY_CAPTURE_ENABLED`, `_COMMAND_WRITES_ENABLED`,
  `_RECALL_ENABLED`, `_LEARNING_ENABLED`, `_BACKGROUND_ENABLED`, `_ROLLOUT_PERCENT`; in production also
  `GIDEON_MEMORY_STAGE15_CUTOVER`.

## Health, metrics and alerts

```
npm run memory:ops -- readiness     # exit 1 unless migrations are applied and no restore is blocked
npm run memory:ops -- metrics       # counts, ages and alerts; exit 2 on any critical alert
```

Run `metrics` every minute from the scheduler and ship its JSON to the metrics
system. Alerts come from `evaluateMemoryAlerts` (`backend/memory/src/operations.ts`):

| Alert | Severity | Fires when | First response |
|---|---|---|---|
| `lost_accepted_commands` | critical | an accepted explicit command's exact version is gone without a deletion | Stop writes (switches off), preserve the database, investigate. This must never happen |
| `restore_blocked` | critical | a restore guard is blocked | Finish the restore procedure below; memory stays unavailable until then, by design |
| `purge_failed` | critical | a physical purge task exhausted its attempts | `getDeletionStatus` on the deletion; fix the cause; the logical block still holds |
| `purge_overdue` | critical | a deletion's physical purge is older than 1 h | Check the background runner is up (`GIDEON_MEMORY_BACKGROUND_ENABLED=1`) and not failing |
| `learning_backlog_age` | warning > 15 min, critical > 1 h | oldest queued interpretation | Check the background runner; scale workers; learning is best effort, conversation is unaffected |
| `dead_jobs` | warning | jobs gave up | Inspect `last_failure_code` by kind; requeue after fixing the cause |
| `expired_leases` | warning | running jobs whose lease expired | A worker died; the next tick reclaims them with a new fence, so no action unless it persists |
| `uninterpreted_turns` | warning | turns kept but not queued (backlog cap reached) | Learning is behind for some owners; same as backlog |
| `stale_projections`, `stale_projection_age` | warning | warm views waiting for rebuild | Reads fall back to the authority, so correctness holds; check the runner |

Logs: the background runner logs only failure counts. No content, owner ids
or connection strings reach default logs or metrics.

## Startup

1. `npm run memory:postgres:migrate` with `GIDEON_MEMORY_MIGRATE=1` (remote
   databases also need `GIDEON_MEMORY_ALLOW_REMOTE=1`). Migrations are additive.
2. `npm run memory:ops -- readiness` must pass before the switches are turned on.
3. After any bulk load (legacy import, restore), run `ANALYZE` on the schema
   before opening traffic. With fresh statistics missing, the planner costs a
   new corpus as empty; in the Stage 14 profile the first lookup then ran into
   its deadline instead of taking a few hundred ms.

## Shutdown

Stop the host normally. The background runner requeues claimed jobs on abort.
Anything still leased is reclaimed after the lease expires, with a new fence,
so an old worker cannot complete it.

## Disabled-memory fallback

Set `GIDEON_MEMORY_RECALL_ENABLED=0` (and/or capture, command writes) and
restart. The app answers without memory. Explicit "remember" tells the user it
is not available instead of pretending. Nothing is deleted. Forgetting through
the Memory page keeps working as long as the database is up.

## Provider outage (model extractor or classifier)

Learning jobs fail into retry and then dead. Explicit commands, capture and
recall do not call a model and keep working. Once the provider is back,
requeue dead `interpret_event` jobs, or leave them: the turns remain available
as source evidence.

## Database outage or failover

Capture, commands and recall return typed `unavailable` receipts; nothing is
reported as saved or forgotten. A backend killed mid-transaction is discarded,
not reused (Stage 14 fix). Retrying an explicit command with the same command
id lands it exactly once.

## Exhausted quota

- Explicit memory: 1,000 accepted assertions per owner. `remember` answers that
  memory is full and saves nothing. Raise the owner's limit or ask them to
  review their memories.
- Queued learning: 500 per owner. Past it, turns are kept but not queued;
  `uninterpreted_turns` fires.

## Stalled jobs

`metrics` shows the queue age and expired leases. Leases expire on their own
and the next tick reclaims them. Dead jobs keep `last_failure_code`; after
fixing the cause, reset them to `pending` with `available_at = now()`. Never
reset jobs whose input event is suppressed; the claim query skips those anyway.

## Deletion ledger shipping (required before any backup is relied on)

The deletion ledger lives in the same database a backup restores, so a backup
taken before a forget does not contain the rows needed to replay it. After
every deletion, and at least every few minutes, ship new rows to storage that
restores do not roll back:

```
npm run memory:ops -- ledger-export watermarks.json > ledger-<time>.json
```

`watermarks.json` maps scope id → last shipped sequence. Keep shipped files at
least as long as the oldest backup.

## Restore from backup

1. Keep memory switches off; restore into a fresh database.
2. Combine every shipped ledger file since the backup was taken.
3. `GIDEON_MEMORY_RESTORE=1 npm run memory:ops -- restore-replay ledger.json`
   imports the ledger (refusing a diverged one), blocks every affected scope,
   replays suppressions, and reopens.
4. `ANALYZE`, then `npm run memory:ops -- readiness`, then turn switches back on.

The Stage 14 drill (real `pg_dump`/`pg_restore`) showed that skipping step 3
serves a forgotten memory while readiness reports ok. **Known limit:** replay
blocks forgotten content logically (not retrievable, exported or listed), but
the restored copy still physically holds those rows until they are purged.
Purge tasks need the original deletion operation, which the old backup lacks.
Until replay also purges, restore only backups inside the retention window,
and treat a restored copy as holding deleted data.

## SLOs

See `docs/memory/reports/stage-14-slo.md`.
