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

Deployment builds and typechecks, applies the migrations in
`supabase/migrations` (each once, in its own transaction, recorded with a
checksum in `public.gideon_worker_migrations`), and only then publishes the
Worker. A migration failure prevents publication. `npm run db:status` lists
applied and pending migrations without changing anything.

The tables sit in `public` with row level security on and no grants to
Supabase's `anon` and `authenticated` roles, so the Supabase REST API cannot
reach sessions, tokens or memories. Only the database user in the Hyperdrive
config can.

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
sign-in/account recovery is not implemented. Configure `DB` and
`BETTER_AUTH_SECRET` to enable durable account memory.

**Legacy memory is not automatically imported.** A browser-provided ID is not
proof of ownership. Existing data is left intact; any migration needs separately
verified ownership. This avoids copying another person's legacy facts into a
new account. Account issuance no longer depends on an adoption copy succeeding.

## Memory backends

With `HYPERDRIVE` bound, account memory is the owner's row in
`public.gideon_memories`, read and written over SQL. Without it, the older
choices still work: `SUPABASE_URL` with `SUPABASE_SERVICE_ROLE_KEY` (the same
table over Supabase's REST API), or Durable Object storage. Hyperdrive wins
when both are configured. The REST store and the Hyperdrive store share one
table, so switching between them keeps the data.

Each backend is an **alternative, not a mirror**: switching between Durable
Object storage and the table does not copy existing data. Back up and explicitly migrate owner rows
before switching; use a maintenance window to prevent concurrent writes.

All application writes go through the owner's Durable Object authority, including
HTTP fallback. Failed reads never become writable empty memory, and failed
writes are reported rather than claimed successful. External writers bypassing
this authority are not supported.
