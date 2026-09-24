import {
  editMemoryItem,
  enableMemory,
  exportMemory,
  forgetMemoryItem,
  importMemory,
  listMemoryItems,
  memoryControlsStatus,
  memoryDeletionStatus,
  memoryItemDetail,
  memoryOverview,
  readMemorySettings,
  updateMemorySettings,
  type ControlsResult,
  type PostgresMemoryStore,
} from '../../backend/memory/src/index.ts'
import { gate, originAllowed } from '../lib/guard'
import { MAX_IMPORT_BYTES, renderMemoryMarkdown, type InspectorFilter } from '../lib/memory/controls'
import type { MemoryFailure, MemorySession } from '../lib/memory/contracts'
import { memoryControlsEnabled } from '../lib/memory/rollout'
import { nodeOwner } from './identity'
import { createServerMemorySession } from './memory-session'
import { postgresStore } from './node-memory-integration'

/**
 * `/api/memory`: the Stage 12 inspector and controls on the Node host.
 *
 * Identity is the signed owner cookie only. Nothing in a query string or
 * body names a scope, principal or grant; item ids are looked up inside the
 * owner's scope and read as missing otherwise. Writes need a same-origin
 * JSON POST. Responses are never cached.
 */

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const FILTERS: readonly InspectorFilter[] = ['all', 'preferences', 'facts', 'decisions', 'proposed', 'topics']

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } })
}

function problem(status: number, code: string, message: string, retryable = false, details?: unknown): Response {
  return json({ ok: false, error: { code, message, retryable, ...(details ? { details } : {}) } }, status)
}

const STATUS: Partial<Record<MemoryFailure['code'], number>> = {
  validation: 400,
  unauthorized: 403,
  not_found: 404,
  conflict: 409,
  ambiguous: 409,
  suppressed: 410,
  budget_exhausted: 429,
  unavailable: 503,
}

function reply<T>(result: ControlsResult<T>, shape: (value: T) => unknown = (value) => value): Response {
  if (result.ok) return json({ ok: true, ...(shape(result.value) as object) })
  return problem(STATUS[result.failure.code] ?? 500, result.failure.code, result.failure.message, result.failure.retryable, result.failure.details)
}

function sessionFor(owner: string, store: PostgresMemoryStore): MemorySession<PostgresMemoryStore> {
  return createServerMemorySession({ owner, store, channel: 'http', authority: 'node_signed_cookie' })
}

async function readJsonBody(request: Request): Promise<{ body: Record<string, unknown>; bytes: number } | Response> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return problem(415, 'unsupported_media_type', 'Send JSON.')
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_IMPORT_BYTES + 8_192) return problem(413, 'too_large', 'That request is too large.')
  const text = await request.text()
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_IMPORT_BYTES + 8_192) return problem(413, 'too_large', 'That request is too large.')
  try {
    const body = JSON.parse(text) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return problem(400, 'validation', 'Send a JSON object.')
    return { body: body as Record<string, unknown>, bytes }
  } catch {
    return problem(400, 'validation', 'That is not valid JSON.')
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export async function handleMemoryControls(request: Request): Promise<Response> {
  const post = request.method === 'POST'
  if (!post && request.method !== 'GET') return problem(405, 'method_not_allowed', 'Use GET or POST.')
  if (post && !originAllowed(request.headers.get('origin'), request.url, true)) return problem(403, 'origin_rejected', 'Origin not allowed.')
  const decision = gate(request, 'memory')
  if (!decision.ok) return problem(decision.status, decision.code, decision.message, decision.status === 429)

  const owner = nodeOwner(request.headers)
  if (!owner) return problem(401, 'unauthorized', 'Open GIDEON in this browser first so it can recognise you.')
  if (!memoryControlsEnabled(process.env, owner)) return problem(404, 'memory_controls_disabled', 'Memory controls are not available here.')

  let store: PostgresMemoryStore
  try {
    store = postgresStore()
  } catch {
    return problem(503, 'unavailable', 'Memory is not configured on this server.', false)
  }
  const session = sessionFor(owner, store)
  const url = new URL(request.url)

  if (!post) {
    const view = url.searchParams.get('view') ?? 'overview'
    if (view === 'status') {
      const status = await memoryControlsStatus(session)
      if (!status.enabled) return json({ ok: true, enabled: false })
      return reply(await readMemorySettings(session), (settings) => ({ enabled: true, settings }))
    }
    if (view === 'overview') return reply(await memoryOverview(session), (overview) => ({ overview }))
    if (view === 'items') {
      const filter = (url.searchParams.get('filter') ?? 'all') as InspectorFilter
      if (!FILTERS.includes(filter)) return problem(400, 'validation', 'Unknown filter.')
      return reply(await listMemoryItems(session, { filter, cursor: url.searchParams.get('cursor'), query: url.searchParams.get('q'), limit: Number(url.searchParams.get('limit') ?? 20) || 20 }), (page) => ({ page }))
    }
    if (view === 'item') return reply(await memoryItemDetail(session, url.searchParams.get('id') ?? ''), (detail) => ({ detail }))
    if (view === 'settings') return reply(await readMemorySettings(session), (settings) => ({ settings }))
    if (view === 'deletion') return reply(await memoryDeletionStatus(session, url.searchParams.get('id') ?? ''), (status) => ({ status }))
    if (view === 'export') {
      const exported = await exportMemory(session)
      if (!exported.ok) return reply(exported)
      const day = exported.value.exportedAt.slice(0, 10)
      if (url.searchParams.get('format') === 'md') {
        return new Response(renderMemoryMarkdown(exported.value), {
          headers: { ...HEADERS, 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="gideon-memory-${day}.md"` },
        })
      }
      return json(exported.value, 200, { 'Content-Disposition': `attachment; filename="gideon-memory-${day}.json"` })
    }
    return problem(400, 'validation', 'Unknown view.')
  }

  const parsed = await readJsonBody(request)
  if (parsed instanceof Response) return parsed
  const { body, bytes } = parsed
  const op = body.op
  if (op === 'enable') return reply(await enableMemory(session), (settings) => ({ settings }))
  if (op === 'settings') {
    const temporary = body.temporary === true ? { on: true as const, hours: typeof body.temporaryHours === 'number' ? body.temporaryHours : undefined } : body.temporary === false ? { on: false as const } : undefined
    return reply(await updateMemorySettings(session, {
      expectedRevision: Number(body.expectedRevision),
      learningEnabled: typeof body.learningEnabled === 'boolean' ? body.learningEnabled : undefined,
      temporary,
      evidenceRetentionDays: body.evidenceRetentionDays === undefined ? undefined : body.evidenceRetentionDays as 30 | 90 | 365 | null,
    }), (settings) => ({ settings }))
  }
  if (op === 'edit') {
    return reply(await editMemoryItem(session, {
      assertionId: text(body.assertionId) ?? '',
      expectedRevision: Number(body.expectedRevision),
      text: text(body.text) ?? '',
      change: body.change === 'changed' ? 'changed' : body.change === 'mistake' ? 'mistake' : ('' as never),
      since: text(body.since),
      timeZone: text(body.timeZone),
      context: text(body.context),
      requestId: text(body.requestId) ?? '',
    }), (edit) => ({ edit }))
  }
  if (op === 'forget') {
    return reply(await forgetMemoryItem(session, {
      assertionId: text(body.assertionId) ?? '',
      expectedRevision: Number(body.expectedRevision),
      requestId: text(body.requestId) ?? '',
    }), (forget) => ({ forget }))
  }
  if (op === 'import') return reply(await importMemory(session, body.document, bytes), (imported) => ({ imported }))
  return problem(400, 'validation', 'Unknown operation.')
}
