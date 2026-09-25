# Stage 17 handoff: optional verified procedural memory

Status: LOCAL_VERIFIED (optional; advisory only; not wired into ChatGideon; automatic execution OFF)
Implementation commits:
- `62d5a6c`: procedure manifest, lifecycle, advisory recall, deletion propagation, inspector data
- `66cf022`: held-out comparison in a synthetic simulator; `adviceFromManifest`
- `2fb3acc`: read-only procedure inspection and advice on the local server
- the commit that adds this handoff

Date: 2026-09-25
Environment: Windows 10, Node 22.13 (`node:sqlite`). No provider calls, deployment or real-user data.

## Prerequisite evidence

Stage 16 (`handoffs/16-independent-framework.md`): the portable package,
its capability model and scoped identity. Procedures build on it, in the
same style: host-supplied scope, principal binding, and `BEGIN IMMEDIATE`
writes.

## Implemented behavior (`packages/memory/src/procedures.ts`)

- **Manifest v1** (`validateManifest`): kind `task` only. Fields: trigger,
  inputs, declarative preconditions (`eq`, `neq`, `gte`, `lte`, `present`,
  `absent` over host facts), steps (instructions, optionally naming a
  capability), stop conditions, observed-outcome verification, environment
  fingerprint, tool versions and requested capabilities. Refused with a
  named reason:
  - memory-management policy fields (identity, grants, retention, deletion,
    extraction, authorization) or any kind other than `task`;
  - credentials and temporary ids or paths;
  - shell or script text;
  - instructions to ignore rules or skip approval;
  - undeclared capabilities.
- **Evidence.** A candidate needs at least one source episode whose success a
  `tool_result` or `external_check` observed, with an evidence reference. The
  following cannot seed a candidate:
  - assistant claims;
  - user silence;
  - failures;
  - inconclusive outcomes.

  A source episode's specific output may not appear in the manifest.
- **Lifecycle:** candidate → reviewed (a reviewer other than the author) →
  verified. Promotion needs:
  - an observed pass on a held-out variant whose task is not one of the
    sources;
  - an observed pass on a negative-precondition case;
  - no failed check;
  - no answer key appearing in the manifest;
  - still-valid evidence.

  A claimed pass is stored as `inconclusive` and never counts. A newer
  verified version supersedes the old one, and `rollback` restores the old
  one.
- **Advice** (`advise`): verified versions only, always labelled advisory.
  At recall it checks:
  - environment: another platform is `incompatible`; another model needs
    reverification;
  - tool major versions;
  - preconditions: met, unmet or unknown;
  - capabilities: the ones the caller lacks are listed.

  `usable` is true only when everything passes. Capabilities are never
  granted, and nothing is executed.
- **Shadow mode** (`adviseShadow`): candidates and reviewed versions, for
  comparison only.
- **Model-upgrade review** (`reviewForEnvironment`): lists verified procedures
  that a new environment or model makes stale.
- **Deletion:** `deleteEpisode` removes the episode's content and invalidates
  every version it alone supported.
- **Inspector:** `inspect` returns versions, sources (with deleted flags),
  reviews, verifications (never answer keys) and adoption decisions.
  `recordAdoption` keeps the decision log. The local server exposes
  `procedures-inspect` and `procedures-advise`. Capabilities come from the
  host's token configuration, a request cannot add any, and there is no
  execution route.

## Held-out comparison

Source: `docs/memory/reports/stage-17-procedures-eval.json`. The environment
is a deterministic synthetic deploy simulator with 12 held-out variants:
6 must ship and 6 must stop.

| Arm | Verified success | Harmful shortcuts |
|---|---|---|
| Raw episode replay | 1/12 | 11/12 (replayed a stale provider; skipped checks) |
| Previous version (v1, old provider) | 6/12 (stopped safely as incompatible) | 0 |
| **Current verified version (v2)** | **12/12** | **0** |
| Unpromoted shortcut (v3, shadow) | 7/12 | 5/12 |

Adoption decision recorded: `adopt`, as advisory only; automatic execution
stays off.

The episodes were built to contain those traps, so these numbers show the
safeguards working on those cases. They are not a general estimate of
benefit, and no model or real deployment was measured.

## Verification

| Command | Result |
|---|---|
| `npx vitest run packages/memory` | 44 passed (procedures 12, comparison 1, server 2, earlier suites 29) |
| `npx vitest run` | see progress row (full suite re-run at the end of Stage 18) |

Seed cases:

| Case | Evidence |
|---|---|
| C15 | "C15: a claimed or silent success cannot seed a procedure…"; a claimed verification pass is stored as inconclusive |
| C29 | manifest injection and policy refusals; "C29: capabilities come from the host token…" (server) |
| C32 | "C32: a newer candidate runs only in shadow…" (the verified version is never replaced without review; rollback restores it) |

## Decisions and limits

- **SQLite only.** The PostgreSQL backend has no procedure tables. Procedures
  are a separate optional store, not part of the backend contract.
- **Not connected to ChatGideon.** Nothing in the app records episodes or
  shows procedures, and the ChatGideon inspector page is unchanged. Wiring it
  in needs its own scope: which tool results count as observations, and who
  reviews.
- **Deployment evidence.** The comparison is synthetic; real task benefit is
  unmeasured. Promoting procedures in a live product needs real observed
  episodes and independent checks.

## Disable or revert

Procedures are off unless a host constructs a `SqliteProcedureStore`. The
server only exposes them when given one. Reverting the three commits removes
the feature.

Next prompt: `docs/memory/implementation/18-multimodal-memory.md`.
