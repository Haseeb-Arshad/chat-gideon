import handler from '@tanstack/react-start/server-entry'
import { REALTIME_PATH } from '../../../src/lib/protocol'
import { setRuntimeEnv } from '../../../src/lib/runtime-env'
import { handleApi, isApiPath } from './api'
import { sessionIdFromRequest } from './identity'
import type { Env, WorkerContext } from './types'

export { GideonSession } from './realtime'

/**
 * The single Cloudflare entrypoint.
 *
 * API and WebSocket traffic is handled by the Worker backend in this folder.
 * Everything else is passed to TanStack Start, which serves the existing
 * frontend and SSR shell from the same origin.
 */
export default {
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
      const id = env.GIDEON_SESSION.idFromName(sessionIdFromRequest(request))
      return env.GIDEON_SESSION.get(id).fetch(request)
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

