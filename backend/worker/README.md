# GIDEON Cloudflare Worker

This folder contains the Cloudflare backend adapter. The root TanStack Start
frontend is served by the same Worker through `src/server.ts`.

The backend owns:

- `/api/chat`, `/api/voice`, `/api/transcribe`, `/api/config`, and `/api/healthz`
- `/api/realtime`, backed by one `GideonSession` Durable Object per browser
  session
- OpenRouter and Exa secrets, which stay in Worker bindings
- durable memory in Durable Object SQLite storage, with an optional Supabase
  mirror for the production database

## Local Worker run

Copy `.dev.vars.example` to `.dev.vars`, put in the keys you want to test, and
run from the repository root:

```powershell
npm run dev:cloudflare
```

Use the URL printed by Wrangler. The normal `npm run dev` remains the local
Node server with the existing Vite WebSocket host.

## Deploy

Authenticate once, then deploy the full-stack Worker from the repository root:

```powershell
npx wrangler login
npm run deploy:cloudflare
```

Set production secrets with Wrangler. Do not put them in `wrangler.jsonc`:

```powershell
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put EXA_API_KEY
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

The browser session identifier is an opaque local identifier, not an account
or authentication mechanism. If GIDEON later gains sign-in, replace it with a
verified user id before exposing cross-device memory.
