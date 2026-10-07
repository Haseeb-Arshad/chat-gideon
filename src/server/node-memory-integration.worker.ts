import type { MemoryTurnRuntime } from '../lib/memory/turn-runtime'
import { resolveNodeMemorySession } from './node-memory-session'

/**
 * Cloudflare build stand-in for the TanStack framework's Node memory adapter.
 *
 * `vite.config.ts` resolves Node framework imports to this module in
 * Cloudflare mode. The Worker API and Durable Object use their own canonical
 * Hyperdrive-backed adapter in `backend/worker/src/worker-memory.ts`.
 */
export function resolveNodeMemoryIntegration(
  _request: { headers: { get(name: string): string | null } },
  _channel: 'http' | 'websocket',
): MemoryTurnRuntime | undefined {
  return undefined
}

/** Framework-route stand-in; Worker HTTP and realtime turns use worker-memory.ts. */
export async function resolveNodeMemoryForTurn(
  request: { headers: { get(name: string): string | null } },
  channel: 'http' | 'websocket',
): Promise<{ memorySession: ReturnType<typeof resolveNodeMemorySession>; memoryRuntime: MemoryTurnRuntime | undefined }> {
  return { memorySession: resolveNodeMemorySession(request, channel), memoryRuntime: undefined }
}
