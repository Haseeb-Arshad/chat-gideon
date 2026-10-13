/// <reference types="@cloudflare/workers-types" />

import type { GideonSession } from './realtime'

/** Bindings used by the Cloudflare deployment. Secrets are never bundled. */
export interface Env {
  GIDEON_SESSION: DurableObjectNamespace<GideonSession>

  /**
   * The Supabase PostgreSQL database, reached through Hyperdrive: accounts and
   * account memory. Preferred over `DB` when both are bound.
   */
  HYPERDRIVE?: Hyperdrive
  /** Accounts on D1, for a deployment without PostgreSQL. */
  DB?: D1Database
  /** Needed with a database for verified durable ownership; otherwise memory is ephemeral. */
  BETTER_AUTH_SECRET?: string

  OPENROUTER_API_KEY?: string
  OPENROUTER_CHAT_MODEL?: string
  OPENROUTER_CHAT_FALLBACK_MODEL?: string
  OPENROUTER_VOICE_MODEL?: string
  OPENROUTER_VOICE?: string
  OPENROUTER_STT_MODEL?: string
  OPENROUTER_STT_FALLBACK_MODEL?: string
  OPENROUTER_RESEARCH_MODEL?: string
  OPENROUTER_ILLUSTRATION_MODEL?: string
  OPENROUTER_RESEARCH_FALLBACK_MODEL?: string
  OPENROUTER_SITE_URL?: string

  EXA_API_KEY?: string
  /** Maps. The public token reaches the browser on every map card; the server token never leaves the Worker. */
  MAPBOX_PUBLIC_TOKEN?: string
  MAPBOX_SERVER_TOKEN?: string
  GIDEON_RESEARCH_EFFORT?: string
  GIDEON_ALLOWED_ORIGINS?: string
  GIDEON_RATE_LIMIT?: string
  GIDEON_AUDIT_ENABLED?: string
  GIDEON_AUDIT_REQUIRED?: string
  GIDEON_MEMORY_ROLLOUT_PERCENT?: string
  GIDEON_MEMORY_CAPTURE_ENABLED?: string
  GIDEON_MEMORY_COMMAND_WRITES_ENABLED?: string
  GIDEON_MEMORY_RECALL_ENABLED?: string
  GIDEON_MEMORY_CONTROLS_ENABLED?: string
  GIDEON_MEMORY_CUTOVER_ENABLED?: string
  GIDEON_MEMORY_STAGE15_CUTOVER?: string
  MEMORY_MAINTENANCE?: Queue<import('./memory-maintenance.ts').MemoryMaintenanceMessage>
  GIDEON_MEMORY_BACKGROUND_ENABLED?: string
  GIDEON_MEMORY_LEARNING_ENABLED?: string
  GIDEON_MEMORY_EXTRACTOR?: string
  GIDEON_MEMORY_EXTRACTOR_MODEL?: string
  GIDEON_MEMORY_EXTRACTOR_REMOTE_ALLOWED?: string
  GIDEON_MEMORY_EMBEDDINGS_REMOTE_ALLOWED?: string
  GIDEON_MEMORY_EMBEDDING_MODEL?: string
  GIDEON_MEMORY_EMBEDDING_DIMENSIONS?: string
  /** How long a reply's memory lookup goes on waiting for the query embedding once its other branches have answered. */
  GIDEON_MEMORY_SEMANTIC_GRACE_MS?: string
  GIDEON_MEMORY_REFINEMENT_ENABLED?: string
  GIDEON_MEMORY_CANONICAL_ONLY?: string
  GIDEON_MEMORY_REFINER_REMOTE_ALLOWED?: string
  ENVIRONMENT?: string

  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void
}
