import { callerKey } from '../../../src/lib/guard'

/** Legacy browser identifiers are not proof of ownership and are never used. */
export function sessionIdFromRequest(_request: Request): string {
  return `ephemeral/${crypto.randomUUID()}`
}

export function callerFromRequest(request: Request) {
  // Only the Cloudflare ingress adapter may trust this platform-owned header.
  return callerKey(request.headers, 'unknown', 'cloudflare')
}
