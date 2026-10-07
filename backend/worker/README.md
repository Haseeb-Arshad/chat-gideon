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

Deployment builds and typechecks, applies the Worker migrations and all 11
canonical memory migrations (each once, in its own transaction, recorded with
a checksum in `public.gideon_worker_migrations`), and only then publishes the
Worker. A migration failure prevents publication. `npm run db:status` lists
applied and pending migrations without changing anything.

The account, legacy-memory and audit tables sit in `public` with row level
security on and no grants to Supabase API roles. Raw chat traces and audio are
also revoked from `service_role`; only the database user in the Hyperdrive
config can read them.

When `GIDEON_AUDIT_ENABLED=1` and `GIDEON_AUDIT_REQUIRED=1`, the Worker saves
each submitted chat before provider work, then records model requests and
responses, token and cost usage when returned, tool calls and results, source
links, final answers and released cards/actions. `/api/transcribe` stores the
uploaded WAV bytes and its transcript; generated speech stores its MP3 bytes.
Audio is saved as `bytea` in `public.gideon_voice_assets` with a SHA-256 digest,
MIME type, byte count and provider/model metadata. If the audit database write
fails, the Worker withholds the answer or audio instead of claiming it was
saved. The audit tables group activity by a hash of the browser session key,
never the raw key.

A Worker cannot reuse a database socket across requests, so each account check
and each memory read or write opens a short-lived connection through
Hyperdrive and closes it; Hyperdrive keeps the real connections to Supabase
warm. Use additive,
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

Anonymous sessions last a year. Clearing the cookie loses access; cross-device
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
