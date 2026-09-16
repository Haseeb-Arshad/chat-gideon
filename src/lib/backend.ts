import { REALTIME_PATH } from './protocol'

const SESSION_KEY = 'gideon-session'

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

/** Longest the socket waits on an account before opening under the browser's id. */
const ACCOUNT_WAIT_MS = 2_000

let account: Promise<void> | null = null

/**
 * Makes sure this browser belongs to an account before memory is chosen.
 *
 * Memory follows the account cookie, and a socket's memory is fixed as it
 * opens, so the link waits for this first. Never for long: a server without
 * accounts answers 404 at once, and a slow one leaves memory on the browser's
 * id as before rather than holding up the voice.
 */
export function ensureAccount(): Promise<void> {
  if (account) return account

  // A backend on another origin is sent no cookies, so an account made there
  // would be created on every load and never seen again.
  if (typeof window === 'undefined' || configuredHttpBase() || configuredWebSocketBase()) {
    account = Promise.resolve()
    return account
  }

  const request = fetch('/api/account', { method: 'POST', headers: backendHeaders() })
    .then((response) => response.body?.cancel())
    .catch(() => undefined)
  const giveUp = new Promise<void>((resolve) => setTimeout(resolve, ACCOUNT_WAIT_MS))
  account = Promise.race([request, giveUp]).then(() => undefined)
  return account
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
