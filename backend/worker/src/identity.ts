import { callerKey } from '../../../src/lib/guard'

const SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * The browser stores this as an opaque local identifier. It selects memory,
 * but it is not authentication and must never be treated as an identity claim.
 */
export function sessionIdFromRequest(request: Request): string {
  const header = request.headers.get('x-gideon-session')
  const query = new URL(request.url).searchParams.get('session')
  const candidate = header || query || ''
  return SESSION_PATTERN.test(candidate) ? candidate : 'anonymous'
}

export function callerFromRequest(request: Request) {
  return callerKey(request.headers, 'cloudflare')
}

