import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { MemoryError } from '../../src/contract.ts'
import { openMemory } from '../../src/core.ts'
import { SqliteMemoryBackend } from '../../src/sqlite.ts'

/**
 * A second host with nothing from ChatGideon: a small site where each
 * visitor keeps private notes and can ask about the owner's published notes.
 *
 * - A visitor is whoever holds a cookie this server signed; the memory scope
 *   comes from that verified cookie, never from the request.
 * - The owner's published notes are shared with visitors through an explicit
 *   read-only grant. Visitors cannot write them, and visitors never see each
 *   other. There is no account linking by email or name.
 */

export interface VisitorNotesOptions { dataFile: string; secret: string; port?: number }

const COOKIE = 'visitor'
const PUBLISHED_SCOPE = 'site-owner'

export function createVisitorNotesApp(options: VisitorNotesOptions) {
  if (options.secret.length < 32) throw new Error('The session secret must be at least 32 characters.')
  const backend = new SqliteMemoryBackend({ path: options.dataFile })
  const sign = (value: string) => createHmac('sha256', options.secret).update(value).digest('base64url')
  const published = openMemory({ backend, scopeId: PUBLISHED_SCOPE, principalId: PUBLISHED_SCOPE, grants: ['read'] })
  const owner = openMemory({ backend, scopeId: PUBLISHED_SCOPE, principalId: PUBLISHED_SCOPE, grants: ['read', 'write', 'forget'] })

  const visitorOf = (request: IncomingMessage): string | null => {
    const raw = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))
    const match = raw ? /^visitor=v1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/u.exec(raw) : null
    if (!match) return null
    const expected = Buffer.from(sign(`v1.${match[1]}`))
    const given = Buffer.from(match[2]!)
    return expected.length === given.length && timingSafeEqual(expected, given) ? `visitor-${match[1]}` : null
  }

  const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
    response.end(JSON.stringify(body))
  }

  const body = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    let text = ''
    for await (const chunk of request) {
      text += chunk
      if (text.length > 16_384) throw new MemoryError('validation', 'Too large.')
    }
    try {
      return text ? JSON.parse(text) as Record<string, unknown> : {}
    } catch {
      throw new MemoryError('validation', 'Send JSON.')
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'POST' && url.pathname === '/session') {
        const id = Buffer.from(randomBytes(16)).toString('hex')
        return json(response, 200, { ok: true }, { 'set-cookie': `${COOKIE}=v1.${id}.${sign(`v1.${id}`)}; HttpOnly; SameSite=Lax; Path=/` })
      }
      const visitor = visitorOf(request)
      if (!visitor) return json(response, 401, { ok: false, error: 'Start a session first.' })
      const mine = openMemory({ backend, scopeId: visitor, principalId: visitor, grants: ['read', 'write', 'forget'] })
      if (request.method === 'POST' && url.pathname === '/notes') {
        const input = await body(request)
        const requestId = typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : Buffer.from(randomBytes(8)).toString('hex')
        return json(response, 200, { ok: true, result: await mine.remember({ commandId: `note/${requestId}`, text: input.text as string }) })
      }
      if (request.method === 'GET' && url.pathname === '/notes') return json(response, 200, { ok: true, result: await mine.list({ limit: 50 }) })
      if (request.method === 'GET' && url.pathname === '/ask') {
        const query = url.searchParams.get('q') ?? ''
        return json(response, 200, { ok: true, result: { mine: await mine.search(query, 5), site: await published.search(query, 5) } })
      }
      const forget = /^\/notes\/([A-Za-z0-9_]+)$/u.exec(url.pathname)
      if (request.method === 'DELETE' && forget) {
        return json(response, 200, { ok: true, result: await mine.forget({ commandId: `forget/${Buffer.from(randomBytes(8)).toString('hex')}`, id: forget[1]!, expectedRevision: Number(url.searchParams.get('revision')) }) })
      }
      return json(response, 404, { ok: false, error: 'Not found.' })
    } catch (error) {
      const failure = error instanceof MemoryError ? error : new MemoryError('unavailable', 'Something went wrong.')
      return json(response, failure.code === 'validation' ? 400 : failure.code === 'not_found' ? 404 : failure.code === 'conflict' ? 409 : 500, { ok: false, error: `${failure.code}: ${failure.message}` })
    }
  })

  return {
    /** Owner-side publishing; deliberately not reachable over HTTP. */
    publish: (text: string, id: string) => owner.remember({ commandId: `publish/${id}`, text }),
    listen: () => new Promise<string>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : options.port}`)
    })),
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
      await backend.close()
    },
  }
}
