import { nodeMemoryStore, nodeOwner } from './identity'
import { createServerMemorySession } from './memory-session'

/** Resolve the signed Node cookie before constructing a model-visible session. */
export function resolveNodeMemorySession(
  request: { headers: { get(name: string): string | null } },
  channel: 'http' | 'websocket' = 'http',
) {
  const owner = nodeOwner(request.headers)
  return createServerMemorySession({
    owner: owner ?? `ephemeral/${crypto.randomUUID()}`,
    store: nodeMemoryStore(request.headers),
    channel,
    authority: owner ? 'node_signed_cookie' : 'ephemeral_request',
  })
}
