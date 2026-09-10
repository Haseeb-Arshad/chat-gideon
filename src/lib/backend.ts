import { REALTIME_PATH } from './protocol'

const SESSION_KEY = 'gideon-session'
const ACCESS_KEY = 'gideon-access'

function configuredHttpBase() {
  return (
    (import.meta.env.VITE_GIDEON_BACKEND_URL as string | undefined)?.trim().replace(/\/$/, '') ||
    ''
  )
}

function configuredWebSocketBase() {
  return (import.meta.env.VITE_GIDEON_BACKEND_WS_URL as string | undefined)?.trim() || ''
}

/** A stable, browser-local conversation id used to select durable memory. */
export function sessionId() {
  try {
    const existing = localStorage.getItem(SESSION_KEY)
    if (existing) return existing

    const created =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(SESSION_KEY, created)
    return created
  } catch {
    return 'anonymous'
  }
}

export function accessCode() {
  try {
    return localStorage.getItem(ACCESS_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function backendUrl(path: string) {
  const base = configuredHttpBase()
  return base ? `${base}${path}` : path
}

export function backendHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Gideon-Session': sessionId(),
  }
  if (contentType) headers['Content-Type'] = contentType
  const access = accessCode()
  if (access) headers['X-Gideon-Access'] = access
  return headers
}

export function backendWebSocketUrl() {
  const explicit = configuredWebSocketBase()
  const httpBase = configuredHttpBase()
  const origin = explicit || httpBase || window.location.origin
  const url = new URL(origin, window.location.href)
  if (url.pathname !== REALTIME_PATH) url.pathname = REALTIME_PATH
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  url.searchParams.set('session', sessionId())
  return url.toString()
}
