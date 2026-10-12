import { memoryControlsEnabled } from '../../../src/lib/memory/rollout'
import { handleMemoryControlsForSession, checkMemoryControlsRequest } from '../../../src/server/memory-controls-core'
import { memoryStoreForHttp } from './memory'
import { ownerOf, OwnerUnavailable } from './accounts'
import { resolveWorkerMemoryForTurn } from './worker-memory'
import type { Env } from './types'

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function problem(status: number, code: string, message: string, retryable = false): Response {
  return Response.json({ ok: false, error: { code, message, retryable } }, { status, headers: HEADERS })
}

/** Worker adapter: Better Auth selects the owner and the same Hyperdrive runtime backs memory controls. */
export async function handleWorkerMemoryControls(request: Request, env: Env): Promise<Response> {
  const rejected = checkMemoryControlsRequest(request)
  if (rejected) return rejected

  let owner: string
  try {
    owner = await ownerOf(request, env)
  } catch (error) {
    if (error instanceof OwnerUnavailable) return problem(503, 'account_unavailable', 'Account verification is temporarily unavailable.', true)
    return problem(503, 'unavailable', 'Memory is temporarily unavailable.', true)
  }

  const production = env.ENVIRONMENT !== 'development' && env.ENVIRONMENT !== 'test'
  if (!memoryControlsEnabled({
    NODE_ENV: production ? 'production' : 'development',
    GIDEON_MEMORY_STAGE15_CUTOVER: env.GIDEON_MEMORY_STAGE15_CUTOVER,
    GIDEON_MEMORY_ROLLOUT_PERCENT: env.GIDEON_MEMORY_ROLLOUT_PERCENT,
    GIDEON_MEMORY_CONTROLS_ENABLED: env.GIDEON_MEMORY_CONTROLS_ENABLED,
  }, owner)) {
    return problem(404, 'memory_controls_disabled', 'Memory controls are not available here.')
  }

  let context: Awaited<ReturnType<typeof resolveWorkerMemoryForTurn>> | null = null
  try {
    const legacyStore = memoryStoreForHttp(env, owner, env.GIDEON_SESSION)
    context = await resolveWorkerMemoryForTurn({ env, owner, channel: 'worker_http', legacyStore })
    if (!context.controlSession) {
      return problem(503, 'memory_migration_pending', 'Saved memory is not ready in the new memory store yet. Try again after the account migration completes.', true)
    }
    return await handleMemoryControlsForSession(request, context.controlSession, true)
  } catch {
    return problem(503, 'unavailable', 'Memory is temporarily unavailable.', true)
  } finally {
    await context?.close().catch(() => undefined)
  }
}
