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

export type AccountState = 'pending' | 'ready' | 'unavailable' | 'error'
let account: Promise<AccountState> | null = null
let accountState: AccountState = 'pending'
const accountListeners = new Set<() => void>()

/** Success is a real identity transition, even after a caller stopped waiting. */
export function onAccountReady(listener: () => void): () => void {
  accountListeners.add(listener)
  return () => { accountListeners.delete(listener) }
}

function initializeAccount(): Promise<AccountState> {
  if (account && accountState !== 'error') return account
  accountState = 'pending'
  // External backends do not participate in same-origin account cookies.
  if (typeof window === 'undefined' || configuredHttpBase() || configuredWebSocketBase()) {
    accountState = 'unavailable'
    return (account = Promise.resolve(accountState))
  }
  account = Promise.resolve().then(() => fetch('/api/account', {
    method: 'POST', headers: backendHeaders(),
  })).then((response) => {
    // Do not wait for an unused body before observing the Set-Cookie transition.
    void response.body?.cancel().catch(() => undefined)
    accountState = response.ok ? 'ready' : response.status === 404 ? 'unavailable' : 'error'
    if (accountState === 'ready') {
      for (const listener of accountListeners) listener()
    }
    return accountState
  }, () => (accountState = 'error'))
  return account
}

/** Bounded wait; timing out does not discard the eventual identity transition. */
export function ensureAccount(waitMs = 2_000, signal?: AbortSignal): Promise<AccountState> {
  const initialized = initializeAccount()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (state?: AccountState) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (state) resolve(state)
      else reject(new DOMException('Aborted', 'AbortError'))
    }
    const abort = () => finish()
    const timer = setTimeout(() => finish(accountState), waitMs)
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    void initialized.then(finish)
  })
}

/** Never send memory-bearing HTTP work under an unresolved or failed identity. */
export async function awaitAccount(signal?: AbortSignal): Promise<void> {
  const state = await ensureAccount(8_000, signal)
  if (state === 'pending' || state === 'error') {
    throw new Error('The account is not ready. Please try again shortly.')
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
