# Stage 12 handoff: inspector, user controls, corrections, forgetting, and export

Status: LOCAL_VERIFIED
Implementation commits:
- `2544617`: controls API and enforcement
- `f1c8909`: inspector page
- `c424cd2`: cross-bundle store repair
- `c2bbcf4`: inspector fixes found in the browser
- the commit that adds this handoff

Date: 2026-09-24
Environment:
- Windows 10.0.19045 x64, Node v22.13.0, Vitest 4.1.5.
- Disposable local PostgreSQL 17 clusters: the test harness, plus a scratch cluster for the browser check that was deleted afterwards.
- Vite dev server in the in-app browser.
- Two real conversational turns were sent to OpenRouter with every model setting pinned to `openai/gpt-6-luna`; they cost $0.00075. Nothing else called a provider.

## Prerequisite evidence

- **Stages 10 and 11:** `handoffs/10-background-learning.md` and `handoffs/11-jev-experiment.md` are LOCAL_VERIFIED. Stage 12 uses these existing contracts unchanged:
  - the command, deletion, projection and receipt contracts from Stages 04–07;
  - the learning decision log from Stage 10.
- **Gap found before starting:** the app path never provisioned a user's memory scope. Stage 09 said it "does not migrate or provision accounts", so every enabled flag still failed as unauthorized for a new owner. Stage 12 makes provisioning an explicit user action ("Turn on memory"). No automatic account creation was added.

## Implemented behavior

- **Authenticated inspector API** (`GET/POST /api/memory`, Node host).
  - **Identity:** only the signed `gideon-owner` cookie identifies the caller. Scope, principal and grants come from the server session. Body or query fields such as `scopeId` or `owner` are ignored; a live test sends them and checks the other user's row is untouched.
  - **Ids:** item ids are lookups inside the owner's scope. An id from another scope returns the same `not_found` as a missing one.
  - **Writes:** only same-origin JSON POSTs, under their own rate limit (`memory`).
  - **Responses:** always `no-store` and `nosniff`.
- **Curated overview** (`view=overview`). A few bounded sections:
  - preferences and constraints, with user-authored items first;
  - facts, decisions and ongoing topics;
  - proposed items (candidates, with their reason code explained);
  - recent changes (a forgotten item shows as "a memory that was since forgotten");
  - counts;
  - settings.
- **Browsing** (`view=items`). Filters, search, and keyset pagination with an opaque cursor; a forged cursor is refused.
- **Item fields.** Each item carries:
  - accepted text and kind;
  - basis: you said / corrected / learned / inferred / imported / tool;
  - scope label: everywhere, one task only, topic condition, or until a date;
  - status, freshness and valid time;
  - sources, with conflict and revision counts.

  Only the user's own words are quoted. Other source kinds are listed by kind only. Imported items say they have no conversation citation; no citation is invented.
- **Item detail** (`view=item`). Full history with its meaning ("corrected — the earlier wording was wrong" vs "changed from … — the earlier wording was true before"), sources, and learning-decision reason codes.
- **Versioned edit** (`op=edit`). This goes through the existing command API.
  - **Mistake:** a correction.
  - **Real change:** a transition with a valid-from date. The user's calendar day and IANA time zone are recorded.
  - **Contextual:** a new item conditioned on `topic = <context>`. The general item is untouched, and both are returned.
  - Each edit needs the revision the user saw; a stale tab gets `409` with the current revision.
  - The response is the accepted item read back from the authority, never the text that was typed.
  - Proposed items cannot be edited into accepted ones.
  - Request ids make retries idempotent.
- **Exact forget** (`op=forget`). It needs the current revision and goes through Stage 05 `executeForgetCommand` on the exact target.
  - The response separates the logical block (immediate) from physical purge (`pending` / `complete` / `failed`, readable via `view=deletion`) and says externally held copies are `not_controlled`.
  - Proposed items can be dismissed the same way.
- **Settings** (`op=settings`). They are versioned, and a stale tab gets `409`. Each is enforced on the server:
  - **Learning off:** the maintenance tick closes queued and new interpretation jobs as `learning_disabled`. Nothing is deleted, and explicit "remember this" still works.
  - **Temporary conversation** (24 h by default, 72 h at most, can be turned off):
    - turns are not captured, so no durable evidence exists;
    - `remember`, `correct` and `recall` refuse with a clear message;
    - retrieval returns `unavailable: temporary`, and the model is told memory is off;
    - `forget` still works;
    - existing memories are not deleted.
  - **Evidence retention** (30 / 90 / 365 days, or until deleted): conversation turns that no memory cites are deleted through the Stage 05 machinery. That covers suppression, deletion-epoch bump, dead jobs, revoked leases, control-ledger rows for restore replay and purge tasks (migration 009 allows target-less `retention` operations). Cited evidence is kept.
- **Receipts in the existing ledger.** The Resources panel shows each memory action's receipt state: saved, saved and searchable, received but not yet a memory, waiting for your choice, not saved. The context-pack instruction now tells the model to apply preferences naturally and not narrate them.
- **Export** (`view=export`). JSON format `chatgideon.memory-export` v1, carrying:
  - items with sources, history, basis and time semantics;
  - a scope fingerprint and base watermark;
  - provenance gaps;
  - a SHA-256 of the items;
  - the notice that downloaded copies are outside ChatGideon's control.

  `format=md` gives a readable Markdown projection; day-precision dates appear in the user's zone.
- **Controlled import** (`op=import`, ≤ 512 KiB, ≤ 500 items).
  - **Refused whole:** unknown format or version, or another account's file (fingerprint mismatch).
  - **Refused per item:**
    - traversal-shaped or absolute ids;
    - bad conditions or oversized text;
    - proposed or disputed items, which are never imported as accepted;
    - anything forgotten, whether the item or any cited source;
    - anything changed since the export (`stale`).
  - Accepted items are written as attributable `imported_legacy` events with basis `imported_legacy` and producer `memory-import`. Replaying the same file writes nothing new.
  - Import reads a JSON body, never a filesystem path, so there is no traversal or symlink surface. File-based import (for example a Markdown vault) is left to Stage 16.
- **Inspector page** (`/memory`).
  - **States:** loading; unavailable ("this does not mean anything was forgotten"); memory off (with "Turn on memory"); ready.
  - **Actions:** edit form (mistake / changed since date / topic-only), forget confirmation, a Removals panel that follows physical cleanup, settings with their effect text, and export/import.
  - **Announcements and alerts:** a live region announces results; errors use `role="alert"`.
  - **Styling:** the app's dark glass style; single column on phones with no horizontal scroll.
  - **Entry point:** a Memory corner button on the main page, shown only when the server offers controls.
- **Repair: the store is now recognised across bundles.** The Node host loads the SSR and realtime bundles into one process, each with its own `PostgresMemoryStore` class, sharing one store through a global. Whichever bundle created it first broke every `instanceof` check in the other. The browser check found it: opening the voice page before `/memory` made memory report "unavailable". Commands, deletion, retrieval, projections and controls now use a registered brand (`isPostgresMemoryStore`).

## Source and schema map

| Concern | Paths |
|---|---|
| Edge contract: views, export format, import parser, Markdown | `src/lib/memory/controls.ts` |
| Server controls | `backend/memory/src/controls.ts` |
| Retention deletion | `backend/memory/src/deletion.ts` (`executeEvidenceRetention`); forget status now filters `operation_kind = 'forget'` |
| Import provenance | `backend/memory/src/commands.ts` (`ExplicitCommandOptions.origin`) |
| Enforcement | `backend/memory/src/background.ts` (retention step, `scopesWithoutLearning`), `src/server/node-memory-integration.ts` (temporary mode in capture, recall and tools; `createRuntime` and `postgresStore` exported), `src/lib/memory/turn-runtime.ts` (`temporary` reason), `src/lib/agent-core.ts` (temporary-mode and do-not-narrate instructions) |
| HTTP | `src/server/memory-controls.ts`, `src/server/memory-controls.worker.ts` (Cloudflare stub), `src/routes/api.memory.ts`, `vite.config.ts` (Worker boundary now covers both Node modules), `src/lib/guard.ts` (`memory` limit) |
| UI | `src/components/MemoryInspector.tsx`, `src/routes/memory.tsx`, `src/styles/memory.css`, `src/components/ResourcesPanel.tsx` (receipt labels), `src/components/AgentPage.tsx` (Memory entry point) |
| Cross-bundle repair | `backend/memory/src/postgres.ts` (`isPostgresMemoryStore`), `commands.ts`, `deletion.ts`, `projections.ts`, `retrieval.ts` |
| Migration | `backend/memory/migrations/009-memory-controls.sql`: `memory_settings` (versioned); target-less `retention` deletion plans and operations; an events index. Additive. Applied only to disposable clusters |
| Flag | `GIDEON_MEMORY_CONTROLS_ENABLED=1` via `memoryControlsEnabled()` in `src/lib/memory/rollout.ts`. It uses the same owner rules, rollout cohort and production cutover gate as other memory flags, and is off by default |
| Tests | `src/lib/memory/controls.test.ts` (4), `src/components/MemoryInspector.test.tsx` (5), `backend/memory/src/store-brand.test.ts` (1), five Stage 12 cases in `backend/memory/src/postgres.live.test.ts` |

## Decisions and deviations

- **Turning memory on is explicit.** It is the only way the app provisions a scope, bound to the signed owner. This is the consent step the rest of memory assumed but never had.
- **Temporary mode is account-wide with an expiry**, not per conversation. The server cannot bind a browser conversation id to authority, and a per-tab flag sent by the browser would be client-trusted. The UI states the scope ("this account's conversations").
- **Contextual edits add a conditioned item.** They do not use a `temporary_exception`, because that relation requires an expiry. Retrieval's condition matching (Stage 08) applies it by topic.
- **Retention covers uncited evidence only.** Removing a memory and the words it cites is what forget is for; the settings text says exactly that.
- **Candidates are shown but cannot be promoted from the UI.** Promotion stays with the Stage 10 policy or an explicit "remember that…". The inspector only dismisses them.
- **No raw debug traces are stored or exposed.** The inspector shows reason codes only.
- **Not in this stage:** cross-application sharing, and the Worker (Cloudflare) memory authority. Only a stub answers there.

## Verification

| Command/check | Environment | Result | Evidence |
|---|---|---|---|
| `npx tsc --noEmit` | Local | PASS | Exit 0 after final edits |
| `npx vitest run src/lib/memory/controls.test.ts src/components/MemoryInspector.test.tsx backend/memory/src/store-brand.test.ts` | Local, jsdom, no network | PASS: 4 + 5 + 1 | Import bounds, traversal ids, Markdown; UI states, stale-edit conflict, forget confirmation; cross-bundle brand |
| `npm run memory:postgres:test` | Fresh disposable PostgreSQL 17 | PASS 35/35 (final run) | Stage 12 cases below. An earlier run had one failure in the Stage 03 concurrent-claim test, which passed on two reruns; see Remaining gaps |
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` | Local offline suite | PASS: 102 files / 1052 tests, 1 skipped (phase-gated live eval) | Suite log |
| `npm run build:cloudflare` | Local | PASS; "Worker bundle is free of the Node PostgreSQL memory adapter." The Worker router contains the controls stub | Build output |
| `npm run build` | Local application and realtime | PASS | Build output |
| Browser: `/memory` on the dev server against a disposable PostgreSQL | In-app browser, desktop and 375 px | PASS, details below | Screenshots taken during the session |
| Real turn with temporary mode on, then off | Dev server, `openai/gpt-6-luna` only, $0.00075 | PASS: with temporary on, the recall tool was refused ("memory off") and there was no capture (5 events before and after). With it off, the next turn answered "You prefer detailed, formal replies" (the edited value), did not mention the forgotten allergy, and captured the turn (5 → 6 events) | Session transcript |

What the browser check covered:
- memory-off state, then "Turn on memory";
- real items with basis, scope, proposed status and reason;
- an "it changed since" edit, read back and shown in history as "changed from Sep 20, 2026" (stored `precision: day`, `sourceTimeZone: Asia/Karachi`);
- a stale list on the same page producing the conflict message with the current wording and nothing saved;
- sources and history panels;
- forget, then Removals going from "cleaning up" to "stored copies cleaned up" via the background runner;
- temporary-mode banner on and off;
- JSON and Markdown export, where the forgotten item is absent;
- file import through the page ("1 added, 3 already here, 1 proposed item(s) not imported");
- no horizontal scroll at 375 px.

The browser check found three defects, all fixed and committed:
- the cross-bundle store bug above;
- valid-from dates displayed as the UTC date;
- forget cleanup status vanishing on refresh.

Separately, the automation tree names checkboxes by their value. The markup uses `aria-labelledby`, and testing-library resolves the names.

### Seed-case coverage

| Case | Executable evidence |
|---|---|
| C04 | Live "C04/C05/C19: inspect, edit…": after an "it changed" edit, recall returns B now and A as of Sept 5. The browser history shows "changed from …" |
| C05 | Same test: a "mistake" edit is a `correction` in history (`[[1, 'ordinary'], [2, 'correction']]`) |
| C06 | Same test: a contextual edit adds a `topic`-conditioned item and returns the untouched general item |
| C19 | Same test: the next retrieval returns the edited revision immediately. Browser: the next real turn used the edited preference |
| C22 | Live "C22/C31: export, forget and edit, then import…" (a forgotten item and a forgotten source stay forgotten on import) and the E2E forget. Evidence retention in the settings test |
| C24 | Live "C24: another user cannot inspect, edit, forget or export…" plus the HTTP test's body-hijack check |
| C25 | Forget reports logical and physical state separately and `externalCopies: not_controlled`. An unavailable authority shows "this does not mean anything was forgotten" (UI test) |
| C31 | Import never turns proposed or disputed items into accepted ones. Candidates show as proposed with their reason, and recall never uses them |

Negative checks:
- stale edit and stale forget (`409`);
- foreign item ids (`404`, same as missing);
- forged cursor;
- cross-origin POST (`403`);
- non-JSON body (`415`);
- no cookie (`401`);
- flag off (`404`);
- oversize or unknown import;
- temporary mode leaves the event count unchanged;
- learning-off closes queued jobs;
- retention keeps cited evidence.

## Operational behavior

- **Enabling:** `GIDEON_MEMORY_CONTROLS_ENABLED=1` plus the rollout cohort; production also needs `GIDEON_MEMORY_STAGE15_CUTOVER=1`. Memory for an owner starts only when that owner presses "Turn on memory".
- **Enforcement points:**
  - retention and learning-off run in the Stage 10 background tick (`GIDEON_MEMORY_BACKGROUND_ENABLED=1`);
  - temporary mode is read once per request by the turn runtime.
  
  If the settings row cannot be read, temporary mode is treated as off. Capture and recall then fail or succeed with the authority itself, so there is no silent "empty memory".
- **Identity:** the Node host needs `GIDEON_IDENTITY_SECRET`. Without it, cookies are signed with a per-process secret and a restart gives every browser a new anonymous owner. This is Stage 01 behavior; the browser check pinned a dev-only secret.
- **Retention and deletion:** forget and retention use Stage 05 suppression, epochs, control ledger and purge tasks, so restore replay covers them. Exported files are outside the system's control, which the UI and the export itself say.
- **Disable or revert:**
  - Unset `GIDEON_MEMORY_CONTROLS_ENABLED`; the route answers `404`. Temporary mode and learning-off rows stay enforced while memory is on.
  - To stop them, set them from the UI or clear `memory_settings` for the scope. That deletes no memory.
  - Keep migration 009, because removing the relaxed constraint would reject existing retention operations.
  - Keep the cross-bundle repair in any revert; without it, memory breaks depending on which page opens first.

## Remaining gaps

- **No staging, production, deployment or real-user evidence.** The Worker (Cloudflare) host has no memory controls, only an honest stub.
- **Proposed items can only be dismissed from the inspector.** Keeping one needs a conversation ("remember that…").
- **Temporary mode is account-wide,** not per conversation (see Decisions).
- **The Stage 03 concurrent-claim test is intermittent** (about 1 run in 3 in this session, in code this stage did not touch). A follow-up task was suggested to fix the claim query.
- **The main system prompt's own style text can surface as a guess about the user.** With temporary mode on, the model said "you like short, everyday replies". That comes from the "short, everyday words" style line, not from memory. It is a prompt-quality issue outside this stage.
- **Import is JSON-body only.** A file or vault import with path confinement is Stage 16.

## Next stage contract

- Edge: the `InspectorItem`, `InspectorOverview`, `InspectorDetail`, `MemorySettingsView` and `MemoryExportDocument` types, plus `parseImportDocument`, `renderMemoryMarkdown`, `safeMemoryId`, `SETTING_EFFECTS` and `memoryControlsEnabled`.
- Node:
  - `memoryOverview`, `listMemoryItems`, `memoryItemDetail`;
  - `editMemoryItem`, `forgetMemoryItem`, `memoryDeletionStatus`;
  - `readMemorySettings`, `updateMemorySettings`, `readMemoryMode`;
  - `exportMemory`, `importMemory`;
  - `enableMemory`, `runEvidenceRetention`, `scopesWithoutLearning`;
  - `executeEvidenceRetention`, `isPostgresMemoryStore`, `handleMemoryControls`.
- Stage 13 can take held-out evaluation inputs from exports (same format), and should measure temporary-mode and learning-off behavior as controls.
- Next prompt: `docs/memory/implementation/13-comparative-evaluation.md`.
