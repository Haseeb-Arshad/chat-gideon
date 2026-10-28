# GIDEON Cloudflare Worker

The root TanStack Start frontend and HTTP APIs are served by one Worker.
`GideonSession` provides WebSockets and a serialized memory authority per
verified account. HTTP fallback uses that same authority.

## Local Worker run

Run from the repository root:

```powershell
Copy-Item backend/worker/.dev.vars.example .dev.vars
# Fill in OPENROUTER_API_KEY and a random BETTER_AUTH_SECRET (32+ characters).
npm run dev:cloudflare
```

Wrangler loads `.dev.vars` beside the root `wrangler.jsonc`, not inside this
backend folder. Without a database, callers get ephemeral memory. For local
accounts, run PostgreSQL, apply the migrations to it with `npm run db:migrate`
and give the `HYPERDRIVE` binding a `localConnectionString` (it must include a
password).

## Deploy

Accounts and account memory live in Supabase PostgreSQL, reached through
Hyperdrive. Set it up once:

1. In Supabase, copy the **direct connection** string (Project Settings →
   Database). Hyperdrive does its own pooling, so do not use the pooler.
2. Create the Hyperdrive config. The string contains the database password,
   so run this yourself:

   ```powershell
   npx wrangler hyperdrive create chat-gideon-db --connection-string="postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres"
   ```

3. Put the returned id in `wrangler.jsonc`:
   `"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id>" }]`.
4. Set secrets with `wrangler secret put`, never in Git:
   - `BETTER_AUTH_SECRET`: random, at least 32 characters. Without it there
     are no accounts and every visitor's memory is ephemeral.
   - `OPENROUTER_API_KEY`.
   - Optional `EXA_API_KEY`, `MAPBOX_PUBLIC_TOKEN`, `MAPBOX_SERVER_TOKEN`.

Then deploy, with the same direct connection string in your shell for the
migrations (it is never stored or printed):

```powershell
$env:GIDEON_DATABASE_URL = '<direct connection string>'
$env:GIDEON_DATABASE_MIGRATE = '1'
$env:GIDEON_DATABASE_ALLOW_REMOTE = '1'
npm run deploy:cloudflare
```

Deployment builds and typechecks, applies the Worker migrations and all 12
canonical memory migrations (each once, in its own transaction, recorded with
a checksum in `public.gideon_worker_migrations`), and only then publishes the
Worker. A migration failure prevents publication. `npm run db:status` lists
applied and pending migrations without changing anything.

The account, legacy-memory and audit tables sit in `public` with row level
security on and no grants to Supabase API roles. Raw chat traces and audio are
also revoked from `service_role`; only the database user in the Hyperdrive
config can read them.

### The conversation record

With `GIDEON_AUDIT_ENABLED=1` the Worker keeps a record of every conversation:
what was said and by whom, the recordings, and what it did to answer. It is
written behind the reply, never in front of it. Code on the path of a turn
leaves a note stamped with the Worker's clock and carries on; one writer per
connection drains the notes to PostgreSQL in the background, a batch per round
trip, kept alive with `waitUntil`. A write that fails is retried once and then
dropped and counted (`audit_records_dropped`): the record is lost, the answer
is not. `GIDEON_AUDIT_REQUIRED=1` now only refuses to start without storage
configured; it no longer holds a reply for a write.

It used to be the other way round. Measured against production on 13 October
2026, the finished transcript waited 570 ms for its recording to commit, each
turn 200 to 400 ms before the model was called, and each spoken chunk about
half a second more, on top of a memory lookup that waited out its 1.5 second
deadline for a remote embedding on every turn.

| Table | One row per | What it answers |
| --- | --- | --- |
| `gideon_conversations` | browser session of one owner | groups everything below; keyed by a hash of the browser session key, never the key |
| `gideon_turns` | assistant turn | the question and the answer, the model, tokens (prompt, completion, cached) and cost, model rounds, tool calls, searches, pages read, cards made and shown, spoken segments, and where the time went (`timings`, `first_token_ms`, `first_audio_ms`), plus the browser's own timeline of the turn in `client` |
| `gideon_speech_segments` | stretch of speech by either side | who spoke, from when to when, the words, and the recording (`asset_id`) |
| `gideon_voice_assets` | recording | the audio itself as `bytea` (the user's WAV, the assistant's MP3) with its SHA-256, MIME type and size |
| `gideon_interaction_events` | thing that happened | the detail behind a turn, in order: provider requests and responses with usage, each search and its results, tool calls and results, cards, memory capture and recall, cards shown or opened, playback interrupted. `occurred_at` is when it happened; `created_at` is when its batch was written |

`gideon_conversation_timeline` is a view over the segments: who spoke when.

```sql
-- The conversation as it was heard.
select at, ended_at, speaker, text, interrupted, asset_id
from public.gideon_conversation_timeline
where conversation_id = '<id>' order by at;

-- What each turn cost and where its time went.
select started_at, user_text, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd,
       tool_calls, searches, cards, cards_displayed, first_token_ms, first_audio_ms, timings, memory->'recall' as recall
from public.gideon_turns where conversation_id = '<id>' order by started_at;

-- Everything the Worker did for one turn, in order.
select occurred_at, event_type, payload
from public.gideon_interaction_events where turn_id = '<turn id>' order by sequence;
```

A user's speech is timed from the recording itself: it ends when the browser
handed it over and starts its own length before that. The assistant's segments
are timed by the browser as it plays them, so both sides of the timeline are on
the listener's clock; a segment cut off by the user is marked `interrupted`. A
speculative turn (a guess at an unfinished sentence) has `committed` null until
the browser says it was used. Captions, the throwaway reads of speech still
being spoken, are not kept. Recordings are about 32 KB per second of the
user's speech and a few tens of KB per spoken chunk, in the database, so its
size is worth watching.

A Worker cannot reuse a database socket across requests, so each account check
and each HTTP memory read or write opens a short-lived connection through
Hyperdrive and closes it; Hyperdrive keeps the real connections to Supabase
warm. The session object is the exception: it lives as long as its socket, so
it resolves an owner's memory once, keeps that runtime and its small pool for
the turns that follow, and opens the pool's connections when the socket opens
and again when speech arrives. A turn used to open a pool and ask which
authority its owner was on before every reply. Use additive,
backward-compatible migrations because the old Worker remains live while
migrations run. This change does not itself provision, migrate or deploy anything.

Set the complete HTTPS origins in `GIDEON_ALLOWED_ORIGINS`. Origin checking is a
browser boundary, not authentication of scripts. Rate limits are per isolate,
not a deployment-wide spending cap; use Cloudflare ingress controls/provider
budgets for public deployments requiring a global ceiling.

## Accounts and memory

`POST /api/account` issues an anonymous Better Auth session without a signup
screen. Cookies select the same `user/<id>` memory on HTTP and WebSockets.
Account verification outages return a retryable 503 rather than silently
changing the owner. Requests without a verified account use isolated ephemeral
memory, never a shared `anonymous` corpus or a client-selected persistent ID.

A page served from another site, such as chatgideon.com on Vercel in front of
this Worker, cannot use this host's cookies: they are third-party there. So it
keeps the signed session token in its own storage instead. HTTP requests send
it as `Authorization: Bearer`; the socket offers it as a second subprotocol,
`gideon-auth.<base64url token>`, beside `gideon`, which the Worker echoes, so
the token is never in a URL. A cross-site socket that arrives without a valid
token gets an anonymous account as it opens, and the token comes back in an
`account` frame before `ready`, so a first visit needs no separate request
before GIDEON can listen. `POST /api/account` returns `token` in its body only
to a cross-site page; a same-site page keeps its HttpOnly cookie. Tokens must
carry Better Auth's signature (`bearer({ requireSignature: true })`).

Anonymous sessions last a year. Clearing site data loses access; cross-device
sign-in/account recovery is not implemented. Configure Hyperdrive and
`BETTER_AUTH_SECRET` to enable durable account memory.

The Worker HTTP and WebSocket paths use the canonical `gideon_memory` authority
for capture, recall, explicit memory commands and the `/api/memory` inspector.
`public.gideon_memories` remains the guarded compatibility store during
cutover. An owner with no legacy items can move automatically on first use.
An owner with saved legacy items stays on that writer until an operator runs a
controlled migration; the Worker does not silently migrate non-empty accounts
while older code could still be writing.

After deploying the Worker code and confirming the previous version and other
legacy writers have drained, inspect owner states and cut over verified account
rows with the direct database URL:

```powershell
$env:GIDEON_DATABASE_URL = '<direct connection string>'
$env:GIDEON_DATABASE_MIGRATE = '1'
$env:GIDEON_DATABASE_ALLOW_REMOTE = '1'
npm run worker-memory:cutover -- status
$env:GIDEON_MEMORY_CUTOVER_WRITES_QUIESCED = '1'
npm run worker-memory:cutover -- cutover
```

The cutover command migrates only `user/<id>` rows, checks every imported
memory, and reports aggregate outcomes. It refuses to run until the database
migrations are complete and the operator explicitly confirms that legacy
writes have stopped. Browser-generated IDs are not adopted into accounts.

## Plan B memory maintenance

The checked-in configuration schedules a once-per-minute dispatcher. It runs
global purge and retention first, then leases up to 20 active owner scopes in
order of their previous dispatch. Queue messages contain only scope identifiers.
Each consumer performs bounded learning, projection rebuilds, embedding backfill
and candidate refinement. Failed consumers retry; embedding exclusions contain
only version/model metadata and stop secret or oversized text blocking backfill.
The Node runner also rediscovers unfinished indexing after source jobs finish.

Create both queues before deploying this configuration:

```powershell
npx wrangler queues create gideon-memory-maintenance
npx wrangler queues create gideon-memory-maintenance-dead
npm run build:cloudflare
npm run db:status
# With the direct migration connection and existing remote-migration switches:
npm run db:migrate
npx wrangler deploy
```

These instructions describe the deployment procedure; implementation tests do
not create queues, apply the production migration, or publish the Worker.
Migration 012 adds private derived traces, gaps, learned overlays, backfill
exclusions and dispatch leases. A policy/deletion epoch change immediately clears
those content derivatives. Evidence retention also cascades to source traces.

Remote embeddings and model learning require their separate environment switches
and the existing provider secret. Temporary mode blocks capture and learning;
turn tracing also skips sensitive or secret-like text. Reviewed overlays are
subordinate answer guidance, stored separately from facts. Refinement can produce
candidates automatically once per day within the per-owner budget, but candidates
never enter model context until independent held-out execution passes.

Use the existing owner's direct connection for operator inspection:

```powershell
npm run memory:plan-b -- status --owner=user/ACCOUNT_ID
npm run memory:plan-b -- gaps --owner=user/ACCOUNT_ID
npm run memory:plan-b -- overlays --owner=user/ACCOUNT_ID
# Paid commands require MEMORY_PLANB_LIVE=1; refinements have a bounded cap.
npm run memory:plan-b -- refine --owner=user/ACCOUNT_ID --cap=0.03
npm run memory:plan-b -- verify --owner=user/ACCOUNT_ID --id=overlay/ID --cases=heldout.json --cap=0.03
npm run memory:plan-b -- retire --owner=user/ACCOUNT_ID --id=overlay/ID
```

Verification cases contain `id`, `question`, `context`, `expected`, `forbidden`
and `negative`. At least five distinct cases including a negative are required;
source questions cannot be reused. Both original and overlay readers execute,
with expected labels hidden. Promotion requires a real improvement and no
regression. Owners can inspect gaps and retire rules through “Review learning”
in the existing memory inspector.

`GIDEON_MEMORY_CANONICAL_ONLY=1` keeps active owners on the canonical runtime;
non-empty legacy owners must complete the existing controlled cutover. They
receive a paused receipt instead of writing silently through a fallback. Keep
the compatibility implementation for migration and rollback. Portable memory,
procedures and multimodal packages remain optional/offline and are not wired
into this turn path.

Implementation evidence and outstanding quality/production gates are recorded
in `docs/memory/PLAN-B-IMPLEMENTATION.md`. The 9.5 target is not a production
rating until all registered gates pass.
