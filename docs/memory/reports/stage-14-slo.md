# Stage 14 service levels (measured, local)

Source: `docs/memory/reports/stage-14-slo.json`, produced by
`npm run memory:postgres:load` (`scripts/memory-load.live.test.ts`).

These numbers come from one machine: a 2013 laptop CPU (i7-4800MQ, 8
threads, 12 GB, Windows 10), a disposable PostgreSQL 17 with default
settings, and pool 8 at concurrency 8. The data is synthetic. They bound this
workload on this machine; they are not production capacity. Production
hardware must be measured again before rollout.

## Workload

- 18 owners: 6 each with 20, 150 and 400 explicit memories (4,560 seeded
  through the app's own tool path).
- 180 captured turns, 90 corrections, 432 recall lookups (before and after
  warm rebuild).
- 36 lookups where every memory of a large corpus matches.
- 30 turn-to-retrievable-memory samples.
- A learning backlog of 1,800 queued interpretations across 12 more owners,
  with lookups, remembers and captures running during it.
- 400 pack compositions over 40 candidates.

## Final run (ms)

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Capture a turn | 22 | 65 | 171 |
| Capture during 1,800-job backlog | 49 | 337 | 438 |
| Explicit remember (400-memory owner) | 91 | 135 | 201 |
| Explicit remember (20-memory owner, while seeding) | 116 | 503 | 742 |
| Remember during backlog | 54 | 139 | 439 |
| Edit (correction with history) | 87 | 165 | 280 |
| Recall lookup, 20 memories | 118 | 170 | 183 |
| Recall lookup, 150 memories | 212 | 270 | 348 |
| Recall lookup, 400 memories | 210 | 444 | 458 |
| Recall lookup, every memory matches (400) | 233 | 332 | 341 |
| Recall lookup during backlog | 144 | 217 | 223 |
| Pack composition alone (CPU) | 0.8 | 2.5 | 4.2 |
| Turn to retrievable learned memory (processing only) | 159 | 676 | 723 |

- Learning drain: 53 jobs/s with one runner (1,896 jobs in 36 s).
- Extra prefill per turn: the pack is at most 2,880 bytes, about 680
  estimated tokens on average. No provider prompt cache is used by the memory
  path, so there is no cache-renewal traffic to count.
- Errors: 0. Recall deadline misses (1.5 s): 0 of 432. Dead jobs: 0. Lost
  acknowledged commands: 0.

**Variance.** Across the three final runs the same workload gave lookup p99
between 0.46 s and 1.50 s. One run had 1 deadline miss in 432 (0.23%). The
earlier runs also showed capture p99 up to 0.40 s and remember-while-seeding p99 up to
0.92 s. The machine was otherwise idle but thermally limited. Read the table
as typical and the variance as real.

**Before the Stage 14 fixes** the same workload produced:
- 256 failed lookups: every 150- and 400-memory owner ran into the 1.5 s
  deadline, because source evidence took 13 s for one owner;
- 126 dead snapshot jobs (learned memories failed snapshot validation).

## Chosen service levels

| Service level | Target | Measured | Status |
|---|---|---|---|
| Acknowledged write lost | 0 | 0 (plus the contention and killed-connection suites) | met in suite |
| Unauthorized disclosure / resurrection | 0 | 0 (canary sweep, deletion race, restore drill) | met in suite |
| Recall lookup p95 | ≤ 600 ms | ≤ 444 ms (final), ≤ 844 ms (worst run) | met on final run, not every run |
| Recall lookup p99 | ≤ 1,000 ms | 458 ms final; 1,504 ms worst run | **not met on every run** |
| Recall deadline misses at 1.5 s | ≤ 0.5% | 0% final; 0.23% worst run | met |
| Capture p95 | ≤ 250 ms | 65–228 ms | met |
| Explicit remember / edit p95 | ≤ 750 ms | ≤ 656 ms worst run | met |
| Turn to retrievable (processing) p95 | ≤ 1 s, plus the configured 15 s settle and runner interval | 445–676 ms | met |
| Learning drain | ≥ 25 jobs/s per runner | 48–62 jobs/s | met |
| Deletion physically purged | ≤ 1 h (alert `purge_overdue`) | purge completes in the next tick | met in suite |

The p99 target is not met reliably on this hardware, so a wide rollout stays
blocked until production hardware is measured. Two measures would cut tail
latency without new infrastructure:
- The 5 s private snapshot lease makes the warm path almost never usable:
  lookups after a rebuild were as slow as cold ones. Either refresh snapshots
  ahead of use, or recall with `authoritative` consistency and skip the
  warm-read attempt.
- A shorter recall deadline with a clean "unavailable" is better for voice
  than a late pack.

## Not measured

- First substantive audio: needs the realtime voice provider and a real
  client.
- Multi-host behavior: one Node process was used; the multi-process
  contention suite covers correctness across processes, not throughput.
