import type { MemoryTurnRuntime } from '../lib/memory/turn-runtime'
import { resolveNodeMemorySession } from './node-memory-session'

/**
 * Cloudflare build stand-in for the Node PostgreSQL memory adapter.
 *
 * The Worker keeps its own account/Durable Object memory authority and must
 * not bundle the `pg` driver. `vite.config.ts` resolves the Node adapter to
 * this module in Cloudflare mode, so any framework route that reaches it runs
 * without a canonical memory runtime, exactly as when every flag is off.
 */
export function resolveNodeMemoryIntegration(
  _request: { headers: { get(name: string): string | null } },
  _channel: 'http' | 'websocket',
): MemoryTurnRuntime | undefined {
  return undefined
}

/** Worker stand-in: the request's own session and no canonical runtime, as with every flag off. */
export async function resolveNodeMemoryForTurn(
  request: { headers: { get(name: string): string | null } },
  channel: 'http' | 'websocket',
): Promise<{ memorySession: ReturnType<typeof resolveNodeMemorySession>; memoryRuntime: MemoryTurnRuntime | undefined }> {
  return { memorySession: resolveNodeMemorySession(request, channel), memoryRuntime: undefined }
}
