import { memoryControlsEnabled } from '../lib/memory/rollout'
import { nodeOwner } from './identity'
import { createServerMemorySession } from './memory-session'
import { postgresStore } from './node-memory-integration'
import { checkMemoryControlsRequest, handleMemoryControlsForSession } from './memory-controls-core'

/** Node host adapter for the shared memory inspector and controls. */
export async function handleMemoryControls(request: Request): Promise<Response> {
  const rejected = checkMemoryControlsRequest(request)
  if (rejected) return rejected
  const owner = nodeOwner(request.headers)
  if (!owner) {
    return Response.json({ ok: false, error: { code: 'unauthorized', message: 'Open GIDEON in this browser first so it can recognise you.', retryable: false } }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!memoryControlsEnabled(process.env, owner)) {
    return Response.json({ ok: false, error: { code: 'memory_controls_disabled', message: 'Memory controls are not available here.', retryable: false } }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  }

  try {
    const session = createServerMemorySession({ owner, store: postgresStore(), channel: 'http', authority: 'node_signed_cookie' })
    return await handleMemoryControlsForSession(request, session, true)
  } catch {
    return Response.json({ ok: false, error: { code: 'unavailable', message: 'Memory is not configured on this server.', retryable: false } }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
