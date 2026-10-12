import handler from '@tanstack/react-start/server-entry'
import { withLocation } from '../../../src/lib/location'
import { REALTIME_PATH } from '../../../src/lib/protocol'
import { setRuntimeEnv } from '../../../src/lib/runtime-env'
import { ownerOf, withOwner } from './accounts'
import { handleApi, isApiPath } from './api'
import type { Env, WorkerContext } from './types'
import { dispatchMemoryMaintenance, maintainMemoryScope, type MemoryMaintenanceMessage } from './memory-maintenance.ts'

export { GideonSession } from './realtime'

/**
 * The single Cloudflare entrypoint.
 *
 * API and WebSocket traffic is handled by the Worker backend in this folder.
 * Everything else is passed to TanStack Start, which serves the existing
 * frontend and SSR shell from the same origin.
 */
export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: WorkerContext) {
    ctx.waitUntil(dispatchMemoryMaintenance(env))
  },
  async queue(batch: MessageBatch<MemoryMaintenanceMessage>, env: Env) {
    for (const message of batch.messages) {
      try { await maintainMemoryScope(env, message.body); message.ack() }
      catch { message.retry({ delaySeconds: 60 }); console.warn(JSON.stringify({ event: 'memory_maintenance_retry', attempt: message.attempts })) }
    }
  },
  async fetch(request: Request, env: Env, ctx: WorkerContext) {
    setRuntimeEnv(env)
    const url = new URL(request.url)

    if (
      url.pathname === REALTIME_PATH &&
      request.method === 'GET' &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      if (!env.GIDEON_SESSION) {
        return new Response('The realtime Durable Object is not configured.', { status: 503 })
      }
      // One object per owner, so every tab and device on an account meets the same memory.
      let owner: string
      try { owner = await ownerOf(request, env) }
      catch { return new Response('Account verification is temporarily unavailable.', { status: 503 }) }
      const id = env.GIDEON_SESSION.idFromName(owner)
      // The object cannot see Cloudflare's lookup of where the request came from, so it is handed over.
      const located = withLocation(request, (request as { cf?: unknown }).cf)
      return env.GIDEON_SESSION.get(id).fetch(withOwner(located, owner))
    }

    if (isApiPath(url.pathname)) {
      const apiResponse = await handleApi(request, env)
      if (apiResponse) return apiResponse
    }

    // `ctx` is part of the Worker contract and is intentionally kept available
    // for future background work. The framework handler owns the UI response.
    void ctx
    return handler.fetch(request)
  },
}

