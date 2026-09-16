# GIDEON Cloudflare Worker

The root TanStack Start frontend and HTTP APIs are served by one Worker.
`GideonSession` provides WebSockets and a serialized memory authority per
verified account. HTTP fallback uses that same authority.

## Local Worker run

Run from the repository root:

```powershell
Copy-Item backend/worker/.dev.vars.example .dev.vars
# Fill in OPENROUTER_API_KEY and a random BETTER_AUTH_SECRET (32+ characters).
npx wrangler d1 migrations apply DB --local
npm run dev:cloudflare
```

Wrangler loads `.dev.vars` beside the root `wrangler.jsonc`, not inside this
backend folder. Leave optional Supabase values empty for local Durable Object
storage. Apply migrations again whenever a new one is added.

## Deploy

Provision the database before the first deployment:

```powershell
npx wrangler login
npx wrangler d1 create chat-gideon
```

Copy the returned `database_id` into the `DB` binding in `wrangler.jsonc`.
Configure production secrets with `wrangler secret put`, never in Git:

- `BETTER_AUTH_SECRET`: random, at least 32 characters.
- `OPENROUTER_API_KEY`.
- Optional `EXA_API_KEY`, `MAPBOX_PUBLIC_TOKEN`, `MAPBOX_SERVER_TOKEN`.
- Optional `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (both required).

```powershell
npm run deploy:cloudflare
```

Deployment builds and typechecks, applies remote D1 migrations, and only then
publishes the Worker. A migration failure prevents publication. Use additive,
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

## Optional Supabase backend

Apply `supabase/migrations/001_gideon_memories.sql` before enabling both bindings.
The service-role key stays server-side and RLS protects the table from anon-key
access. Supabase is an **alternative backend, not a mirror**: switching it on or
off does not copy existing data. Back up and explicitly migrate owner rows
before switching; use a maintenance window to prevent concurrent writes.

All application writes go through the owner's Durable Object authority, including
HTTP fallback. Failed reads never become writable empty memory, and failed
writes are reported rather than claimed successful. External writers bypassing
this authority are not supported.
