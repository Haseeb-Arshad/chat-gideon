/// <reference types="@cloudflare/workers-types" />

/** Bindings used by the Cloudflare deployment. Secrets are never bundled. */
export interface Env {
  GIDEON_SESSION: DurableObjectNamespace

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
  GIDEON_RESEARCH_EFFORT?: string
  GIDEON_ACCESS_CODE?: string
  GIDEON_ALLOWED_ORIGINS?: string
  GIDEON_RATE_LIMIT?: string

  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void
}
