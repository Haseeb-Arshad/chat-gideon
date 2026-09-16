# GIDEON Cloudflare Worker

This folder contains the Cloudflare backend adapter. The root TanStack Start
frontend is served by the same Worker through `src/server.ts`.

The backend owns:

- `/api/chat`, `/api/voice`, `/api/transcribe`, `/api/config`, `/api/account`,
  and `/api/healthz`
- `/api/realtime`, backed by one `GideonSession` Durable Object per owner: the
  account when there is one, otherwise the browser's own id
- accounts, through Better Auth on D1
- OpenRouter and Exa secrets, which stay in Worker bindings
- durable memory in Durable Object SQLite storage, with an optional Supabase
  mirror for the production database

## Local Worker run

Copy `.dev.vars.example` to `.dev.vars`, put in the keys you want to test, and
run from the repository root:

```powershell
npx wrangler d1 migrations apply DB --local
npm run dev:cloudflare
```

The migration only needs running once, and again whenever a new one is added.

Use the URL printed by Wrangler. The normal `npm run dev` remains the local
Node server with the existing Vite WebSocket host.

## Deploy

Authenticate once, then deploy the full-stack Worker from the repository root:

```powershell
npx wrangler login
npm run deploy:cloudflare
```

The deploy script applies D1 migrations after `wrangler deploy`. On the first
deploy, Wrangler also creates the `chat-gideon` database and writes its id
into `wrangler.jsonc`; commit that change.

Set production secrets with Wrangler. Do not put them in `wrangler.jsonc`:

```powershell
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put EXA_API_KEY
npx wrangler secret put MAPBOX_PUBLIC_TOKEN
npx wrangler secret put MAPBOX_SERVER_TOKEN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

`SUPABASE_URL` is not sensitive, but storing it as a Worker secret keeps the
first deployment command sequence simple. It can instead be a plain `vars`
entry in `wrangler.jsonc`.

Non-secret model and URL values can be added to the `vars` section of
`wrangler.jsonc` once the deployment URL is known.

## Supabase memory table

Apply `supabase/migrations/001_gideon_memories.sql` in the Supabase SQL editor.
The Worker talks to it through the REST endpoint using the service-role key,
which is server-only. RLS remains enabled so the public anon key cannot read
the table.

## Accounts

Memory belongs to an account, not a browser. On its first load a page calls
`POST /api/account`, which gives the visitor an anonymous Better Auth account
and a session cookie without asking them to sign up. The Worker checks that
cookie on every socket and turn, and names the memory `user/<id>`. A browser's
own id cannot contain a slash, so no browser can claim an account's memory.

A new account takes over what the browser's id already remembered, so memory
from before accounts is not lost. Only an account that remembers nothing yet
takes anything, and the browser's id keeps its copy.

Accounts need the `DB` binding and a `BETTER_AUTH_SECRET` of at least 32
characters (`openssl rand -base64 32`). Without either, memory stays keyed by
the browser's id, which is an opaque local identifier and not authentication.

Anonymous sessions last a year from the last visit. There is no sign-in yet,
so clearing site data still loses the account. Adding one is how memory will
follow a person onto another device.
