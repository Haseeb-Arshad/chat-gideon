/// <reference types="@cloudflare/workers-types" />

import type { GideonSession } from './realtime'

/** Bindings used by the Cloudflare deployment. Secrets are never bundled. */
export interface Env {
  GIDEON_SESSION: DurableObjectNamespace<GideonSession>

  /** Accounts. Both are needed for verified durable ownership; otherwise memory is ephemeral. */
  DB?: D1Database
  BETTER_AUTH_SECRET?: string

  OPENROUTER_API_KEY?: string
  OPENROUTER_CHAT_MODEL?: string
  OPENROUTER_CHAT_FALLBACK_MODEL?: string
  OPENROUTER_VOICE_MODEL?: string
  OPENROUTER_VOICE?: string
  OPENROUTER_STT_MODEL?: string
  OPENROUTER_STT_FALLBACK_MODEL?: string
  OPENROUTER_RESEARCH_MODEL?: string
  OPENROUTER_RESEARCH_FALLBACK_MODEL?: string
  OPENROUTER_SITE_URL?: string

  EXA_API_KEY?: string
  /** Maps. The public token reaches the browser on every map card; the server token never leaves the Worker. */
  MAPBOX_PUBLIC_TOKEN?: string
  MAPBOX_SERVER_TOKEN?: string
  GIDEON_RESEARCH_EFFORT?: string
  GIDEON_ALLOWED_ORIGINS?: string
  GIDEON_RATE_LIMIT?: string

  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void
}
