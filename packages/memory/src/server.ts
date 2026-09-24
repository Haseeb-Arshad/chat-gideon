import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MemoryError, WIRE_PROTOCOL_VERSION, type Grant, type MemoryBackend } from './contract.ts'
import { openMemory, type ScopedMemory } from './core.ts'

/**
 * Local memory server: one JSON RPC per POST /v1/<operation>.
 *
 * Secure defaults: it listens on loopback only unless `allowRemote` is set
 * (then put it behind TLS); every request needs a bearer token, and the token
 * alone decides the scope, the principal and the grants. A request body that
 * names a scope or principal is refused, not ignored.
 */

export interface TokenIdentity { scopeId: string; principalId: string; grants?: readonly Grant[] }

export interface MemoryServerOptions {
  backend: MemoryBackend
  /** Token → identity. Store tokens outside exports and examples; compare only their hashes. */
  tokens: ReadonlyMap<string, TokenIdentity>
  host?: string
  port?: number
  allowRemote?: boolean
  maxBodyBytes?: number
}

const STATUS: Record<string, number> = {
  validation: 400, unauthorized: 403, not_found: 404, conflict: 409, suppressed: 410, quota: 413,
  unsupported: 422, cancelled: 499, unavailable: 503,
}
const FORBIDDEN_FIELDS = ['scopeId', 'principalId', 'scope', 'principal', 'owner', 'grants', 'tenant']
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

const hash = (value: string) => createHash('sha256').update(value).digest()

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-gideon-memory-protocol': String(WIRE_PROTOCOL_VERSION) })
  response.end(text)
}

function fail(response: ServerResponse, error: MemoryError): void {
  send(response, STATUS[error.code] ?? 500, { ok: false, protocol: WIRE_PROTOCOL_VERSION, error: { code: error.code, message: error.message, retryable: error.retryable } })
}

async function readBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) throw new MemoryError('validation', `The request body is larger than ${limit} bytes.`)
    chunks.push(chunk as Buffer)
  }
  if (!size) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new MemoryError('validation', 'The request body is not JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryError('validation', 'The request body must be a JSON object.')
  return value as Record<string, unknown>
}

type Operation = (memory: ScopedMemory, body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

const str = (value: unknown) => value as string
const num = (value: unknown) => value as number

const OPERATIONS: Record<string, Operation> = {
  capabilities: async (memory) => memory.capabilities,
  remember: (memory, body, signal) => memory.remember({ commandId: str(body.commandId), text: str(body.text), kind: body.kind as never, validFrom: body.validFrom as string | null | undefined }, { signal }),
  correct: (memory, body, signal) => memory.correct({ commandId: str(body.commandId), id: str(body.id), expectedRevision: num(body.expectedRevision), text: str(body.text), change: body.change as never, since: body.since as string | null | undefined }, { signal }),
  forget: (memory, body, signal) => memory.forget({ commandId: str(body.commandId), id: str(body.id), expectedRevision: num(body.expectedRevision) }, { signal }),
  get: (memory, body, signal) => memory.get(str(body.id), { signal }),
  'get-at': (memory, body, signal) => memory.getAt(str(body.id), str(body.validAt), { signal }),
  history: (memory, body, signal) => memory.history(str(body.id), { signal }),
  list: (memory, body, signal) => memory.list({ limit: body.limit as number | undefined, cursor: body.cursor as string | null | undefined }, { signal }),
  search: (memory, body, signal) => memory.search(str(body.query), body.limit as number | undefined, { signal }),
  capture: (memory, body, signal) => memory.capture({ idempotencyKey: str(body.idempotencyKey), text: str(body.text) }, { signal }),
  export: (memory, _body, signal) => memory.exportAll({ signal }),
  import: (memory, body, signal) => memory.importAll(body.document, { signal }),
}

export function createMemoryServer(options: MemoryServerOptions): { server: Server; listen(): Promise<{ url: string }>; close(): Promise<void> } {
  const host = options.host ?? '127.0.0.1'
  if (!LOOPBACK.has(host) && !options.allowRemote) throw new MemoryError('unsupported', 'Refusing to listen beyond loopback without allowRemote (and TLS in front).')
  const identities = [...options.tokens].map(([token, identity]) => ({ digest: hash(token), identity }))
  const limit = options.maxBodyBytes ?? 1_048_576

  const identify = (request: IncomingMessage): TokenIdentity | null => {
    const header = request.headers.authorization ?? ''
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/u.exec(header)
    if (!match) return null
    const digest = hash(match[1]!)
    let found: TokenIdentity | null = null
    for (const entry of identities) if (timingSafeEqual(entry.digest, digest)) found = entry.identity
    return found
  }

  const server = createServer(async (request, response) => {
    const aborted = new AbortController()
    // The client went away before the reply finished (a request's own 'close' also fires after its body is read).
    response.on('close', () => { if (!response.writableFinished) aborted.abort() })
    try {
      const match = /^\/v1\/([a-z-]+)$/u.exec(request.url ?? '')
      const operation = match ? OPERATIONS[match[1]!] : undefined
      if (!operation) return send(response, 404, { ok: false, protocol: WIRE_PROTOCOL_VERSION, error: { code: 'not_found', message: 'Unknown operation.', retryable: false } })
      const identity = identify(request)
      if (!identity) return send(response, 401, { ok: false, protocol: WIRE_PROTOCOL_VERSION, error: { code: 'unauthorized', message: 'A valid bearer token is required.', retryable: false } })
      if (request.method !== 'POST') return send(response, 405, { ok: false, protocol: WIRE_PROTOCOL_VERSION, error: { code: 'validation', message: 'Use POST.', retryable: false } })
      const asked = request.headers['x-gideon-memory-protocol']
      if (asked !== undefined && asked !== String(WIRE_PROTOCOL_VERSION)) throw new MemoryError('unsupported', `This server speaks protocol ${WIRE_PROTOCOL_VERSION}.`)
      const body = await readBody(request, limit)
      const named = FORBIDDEN_FIELDS.filter((field) => field in body)
      if (named.length) throw new MemoryError('validation', `Identity comes from the token; the request may not name ${named.join(', ')}.`)
      const memory = openMemory({ backend: options.backend, scopeId: identity.scopeId, principalId: identity.principalId, grants: identity.grants })
      const result = await operation(memory, body, aborted.signal)
      send(response, 200, { ok: true, protocol: WIRE_PROTOCOL_VERSION, result })
    } catch (error) {
      fail(response, error instanceof MemoryError ? error : new MemoryError('unavailable', 'The memory service failed.', true))
    }
  })

  return {
    server,
    listen: () => new Promise((resolve) => {
      server.listen(options.port ?? 0, host, () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : options.port
        resolve({ url: `http://${host.includes(':') ? `[${host}]` : host}:${port}` })
      })
    }),
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
