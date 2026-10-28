import { REALTIME_PATH, SOCKET_AUTH_PREFIX, SOCKET_PROTOCOL } from './protocol'

const SESSION_KEY = 'gideon-session'
/**
 * The account token, kept by a page whose backend is on another site. That
 * backend's cookies would be third-party here, and browsers drop or partition
 * those, so without this every visit met a GIDEON that remembered nothing.
 */
const TOKEN_KEY = 'gideon-account-token'

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

/** Whether the backend is on another site, so identity travels as a token rather than a cookie. */
export function externalBackend() {
  return Boolean(configuredHttpBase() || configuredWebSocketBase())
}

export function accountToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

const tokenListeners = new Set<() => void>()

/** Keeps a token the backend issued, so this browser is the same person next time. */
export function storeAccountToken(token: string) {
  if (!/^[!-~]{1,512}$/.test(token)) return
  try { localStorage.setItem(TOKEN_KEY, token) } catch { /* Kept for this page only. */ }
  memoryToken = token
  account = Promise.resolve((accountState = 'ready'))
  for (const listener of tokenListeners) listener()
}

/** Set if storage is blocked, so the token still lasts the life of the page. */
let memoryToken: string | null = null
function currentToken() {
  return accountToken() ?? memoryToken
}

export type AccountState = 'pending' | 'ready' | 'unavailable' | 'error'
let account: Promise<AccountState> | null = null
let accountState: AccountState = 'pending'
const accountListeners = new Set<() => void>()
/** A socket that opened without a token is about to be handed one; HTTP waits for it rather than make a second account. */
let socketIssuing: Promise<void> | null = null

/** Marks a socket that may bring an account back; resolved when it does, or when it no longer can. */
export function expectSocketAccount(): () => void {
  let done = () => {}
  const waiting = new Promise<void>((resolve) => {
    const finish = () => { tokenListeners.delete(finish); resolve() }
    tokenListeners.add(finish)
    done = finish
  })
  socketIssuing = waiting
  void waiting.then(() => { if (socketIssuing === waiting) socketIssuing = null })
  return done
}

/** Success is a real identity transition, even after a caller stopped waiting. */
export function onAccountReady(listener: () => void): () => void {
  accountListeners.add(listener)
  return () => { accountListeners.delete(listener) }
}

/** An account on a backend on another site: the token this browser keeps, or a new one. */
async function externalAccount(): Promise<AccountState> {
  if (currentToken()) return 'ready'
  // A socket opening without a token is bringing one; a second account made
  // here would split this visit's memory between the two.
  if (socketIssuing) {
    await Promise.race([socketIssuing, new Promise((resolve) => setTimeout(resolve, 4_000))])
    if (currentToken()) return 'ready'
  }
  const response = await fetch(backendUrl('/api/account'), { method: 'POST', headers: backendHeaders() })
  if (response.status === 404) return 'unavailable'
  if (!response.ok) return 'error'
  const body = await response.json().catch(() => null) as { token?: unknown } | null
  if (typeof body?.token === 'string') storeAccountToken(body.token)
  return currentToken() ? 'ready' : 'error'
}

function initializeAccount(): Promise<AccountState> {
  if (account && accountState !== 'error') return account
  accountState = 'pending'
  if (typeof window === 'undefined') {
    accountState = 'unavailable'
    return (account = Promise.resolve(accountState))
  }
  if (externalBackend()) {
    if (currentToken()) return (account = Promise.resolve((accountState = 'ready')))
    account = externalAccount().then((state) => {
      accountState = state
      if (state === 'ready') for (const listener of accountListeners) listener()
      return state
    }, () => (accountState = 'error'))
    return account
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
  const token = externalBackend() ? currentToken() : null
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * Subprotocols for the socket to a backend on another site: the one it
 * answers with, and the account token, which a browser cannot send as a
 * header on a WebSocket. Undefined for a same-site backend, which has cookies.
 */
export function backendWebSocketProtocols(): string[] | undefined {
  if (!externalBackend()) return undefined
  const token = currentToken()
  if (!token) return [SOCKET_PROTOCOL]
  const encoded = btoa(token).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return [SOCKET_PROTOCOL, `${SOCKET_AUTH_PREFIX}${encoded}`]
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
