import { createHash } from 'node:crypto'
import {
  parseAssertionVersion,
  type AssertionId,
  type AssertionVersion,
  type Condition,
  type MemoryFailure,
  type MemorySession,
  type PrincipalId,
  type ScopeId,
  type ValidTime,
} from '../../../src/lib/memory/contracts.ts'
import {
  EXPORT_SEMANTICS,
  INSPECTOR_PAGE_LIMIT,
  MAX_ITEM_TEXT_CHARS,
  MEMORY_EXPORT_FORMAT,
  MEMORY_EXPORT_VERSION,
  parseImportDocument,
  type InspectorBasis,
  type InspectorDetail,
  type InspectorFilter,
  type InspectorItem,
  type InspectorOverview,
  type InspectorPage,
  type InspectorSource,
  type InspectorStatus,
  type MemoryExportDocument,
  type MemoryExportItem,
  type MemorySettingsView,
} from '../../../src/lib/memory/controls.ts'
import { executeExplicitCommand } from './commands.ts'
import { MEMORY_SCHEMA } from './config.ts'
import { executeEvidenceRetention, executeForgetCommand, getDeletionStatus, type DeletionReceipt } from './deletion.ts'
import { PostgresMemoryOperationError, PostgresMemoryStore, type PostgresMemoryTransaction } from './postgres.ts'
import { canonicalJson, isoNow, sha256 } from './serialization.ts'

/**
 * Stage 12 server-side memory controls.
 *
 * Every read and write runs in a transaction bound to the authenticated
 * session's scope, after the grant check. Item ids from the browser are only
 * lookup keys inside that scope: an id from another scope reads exactly like
 * one that does not exist. Edits and forgets require the revision the user
 * was looking at, so a stale tab gets a conflict with the newer revision
 * instead of silently overwriting or deleting something it never showed.
 */

const SQL = {
  assertions: `${MEMORY_SCHEMA}.assertions`,
  versions: `${MEMORY_SCHEMA}.assertion_versions`,
  evidence: `${MEMORY_SCHEMA}.evidence_edges`,
  events: `${MEMORY_SCHEMA}.events`,
  suppressions: `${MEMORY_SCHEMA}.deletion_suppressions`,
  decisions: `${MEMORY_SCHEMA}.learning_decisions`,
  changes: `${MEMORY_SCHEMA}.change_feed`,
  counters: `${MEMORY_SCHEMA}.change_counters`,
  settings: `${MEMORY_SCHEMA}.memory_settings`,
  grants: `${MEMORY_SCHEMA}.grants`,
  epochs: `${MEMORY_SCHEMA}.policy_epochs`,
} as const

type Session = MemorySession<unknown> & { readonly store: PostgresMemoryStore }
export type ControlsResult<T> = { ok: true; value: T } | { ok: false; failure: MemoryFailure }

const USER_AUTHORED_SOURCES = new Set(['user_statement', 'user_correction'])
const VISIBLE_STATUSES = ['accepted', 'candidate', 'disputed'] as const
const MAX_SHOWN_SOURCES = 3
const MAX_EXPORT_ITEMS = 2_000
const TEMPORARY_DEFAULT_HOURS = 24
const TEMPORARY_MAX_HOURS = 72

function failure(code: MemoryFailure['code'], message: string, retryable = false, details?: MemoryFailure['details']): PostgresMemoryOperationError {
  return new PostgresMemoryOperationError({ code, message, retryable, ...(details ? { details } : {}) })
}

async function guarded<T>(work: () => Promise<T>): Promise<ControlsResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    if (error instanceof PostgresMemoryOperationError) return { ok: false, failure: error.failure }
    return { ok: false, failure: { code: 'unavailable', message: 'Memory is unavailable right now. Nothing was changed.', retryable: true } }
  }
}

function durable(session: MemorySession): Session {
  if (!(session.store instanceof PostgresMemoryStore) || session.trust !== 'authenticated') {
    throw failure('unauthorized', 'Memory controls need an authenticated memory session.')
  }
  return session as Session
}

function inScope<T>(session: Session, action: 'inspect' | 'export' | 'correct' | 'forget' | 'remember', work: (tx: PostgresMemoryTransaction) => Promise<T>): Promise<T> {
  return session.store.forSession(session).runTransaction(async (tx) => {
    await tx.assertAuthorizedContext(session, action)
    return work(tx)
  })
}

export function scopeFingerprint(scopeId: string): string {
  return createHash('sha256').update(`memory-export\0${scopeId}`).digest('hex').slice(0, 32)
}

// ---------------------------------------------------------------------------
// Enabling memory and settings
// ---------------------------------------------------------------------------

/** Whether this owner's memory scope exists and grants the session access. */
export async function memoryControlsStatus(session: MemorySession): Promise<{ enabled: boolean }> {
  try {
    const bound = durable(session)
    await inScope(bound, 'inspect', async () => undefined)
    return { enabled: true }
  } catch {
    return { enabled: false }
  }
}

/**
 * The user's own "turn on memory" action. It provisions the server-bound
 * scope and grant for the signed owner; nothing in the request chooses them.
 */
export async function enableMemory(session: MemorySession): Promise<ControlsResult<MemorySettingsView>> {
  return guarded(async () => {
    const bound = durable(session)
    await bound.store.provisionTrustedContext(bound)
    return inScope(bound, 'inspect', async (tx) => {
      await tx.query(`INSERT INTO ${SQL.settings} (scope_id) VALUES ($1) ON CONFLICT (scope_id) DO NOTHING`, [bound.scope.id])
      return readSettings(tx, bound.scope.id, isoNow())
    })
  })
}

async function readSettings(tx: PostgresMemoryTransaction, scopeId: string, now: string): Promise<MemorySettingsView> {
  const row = await tx.query<{ revision: string; learning_enabled: boolean; temporary_until: Date | null; evidence_retention_days: number | null }>(
    `SELECT revision, learning_enabled, temporary_until, evidence_retention_days FROM ${SQL.settings} WHERE scope_id = $1`,
    [scopeId],
  )
  const settings = row.rows[0]
  const temporaryUntil = settings?.temporary_until ? new Date(settings.temporary_until).toISOString() : null
  return {
    revision: settings ? Number(settings.revision) : 0,
    learningEnabled: settings?.learning_enabled ?? true,
    temporaryUntil,
    temporaryActive: Boolean(temporaryUntil && Date.parse(temporaryUntil) > Date.parse(now)),
    evidenceRetentionDays: (settings?.evidence_retention_days ?? null) as MemorySettingsView['evidenceRetentionDays'],
  }
}

export async function readMemorySettings(session: MemorySession, options: { now?: string } = {}): Promise<ControlsResult<MemorySettingsView>> {
  return guarded(() => inScope(durable(session), 'inspect', (tx) => readSettings(tx, session.scope.id, options.now ?? isoNow())))
}

/** The runtime's view: is this owner in a temporary conversation, and may it learn? */
export async function readMemoryMode(session: MemorySession, now = isoNow()): Promise<{ temporary: boolean; learningEnabled: boolean } | null> {
  try {
    const bound = durable(session)
    return await bound.store.forSession(bound).runTransaction(async (tx) => {
      const settings = await readSettings(tx, bound.scope.id, now)
      return { temporary: settings.temporaryActive, learningEnabled: settings.learningEnabled }
    })
  } catch {
    return null
  }
}

export interface SettingsUpdate {
  expectedRevision: number
  learningEnabled?: boolean
  temporary?: { on: true; hours?: number } | { on: false }
  evidenceRetentionDays?: 30 | 90 | 365 | null
}

export async function updateMemorySettings(session: MemorySession, update: SettingsUpdate, options: { now?: string } = {}): Promise<ControlsResult<MemorySettingsView>> {
  return guarded(async () => {
    const bound = durable(session)
    const now = options.now ?? isoNow()
    if (!Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0) throw failure('validation', 'A settings change needs the revision it was made from.')
    if (update.learningEnabled !== undefined && typeof update.learningEnabled !== 'boolean') throw failure('validation', 'Learning must be on or off.')
    if (update.evidenceRetentionDays !== undefined && ![null, 30, 90, 365].includes(update.evidenceRetentionDays)) throw failure('validation', 'Retention must be 30, 90 or 365 days, or kept until deleted.')
    let temporaryUntil: string | null | undefined
    if (update.temporary) {
      if (update.temporary.on) {
        const hours = update.temporary.hours ?? TEMPORARY_DEFAULT_HOURS
        if (!Number.isFinite(hours) || hours < 1 || hours > TEMPORARY_MAX_HOURS) throw failure('validation', `Temporary mode lasts between 1 and ${TEMPORARY_MAX_HOURS} hours.`)
        temporaryUntil = new Date(Date.parse(now) + hours * 3_600_000).toISOString()
      } else {
        temporaryUntil = null
      }
    }
    return inScope(bound, 'correct', async (tx) => {
      await tx.query(`INSERT INTO ${SQL.settings} (scope_id) VALUES ($1) ON CONFLICT (scope_id) DO NOTHING`, [bound.scope.id])
      const current = await tx.query<{ revision: string }>(`SELECT revision FROM ${SQL.settings} WHERE scope_id = $1 FOR UPDATE`, [bound.scope.id])
      const revision = Number(current.rows[0]!.revision)
      // Revision 0 is "no row yet"; the row created above starts at 1.
      if (update.expectedRevision !== revision && !(update.expectedRevision === 0 && revision === 1)) {
        throw failure('conflict', 'These settings changed in another tab. Review the current values and try again.', true, { currentRevision: revision })
      }
      await tx.query(
        `UPDATE ${SQL.settings}
         SET revision = revision + 1,
             learning_enabled = COALESCE($2, learning_enabled),
             temporary_until = CASE WHEN $3 THEN $4::timestamptz ELSE temporary_until END,
             evidence_retention_days = CASE WHEN $5 THEN $6::integer ELSE evidence_retention_days END,
             updated_at = now()
         WHERE scope_id = $1`,
        [bound.scope.id, update.learningEnabled ?? null, temporaryUntil !== undefined, temporaryUntil ?? null, update.evidenceRetentionDays !== undefined, update.evidenceRetentionDays ?? null],
      )
      return readSettings(tx, bound.scope.id, now)
    })
  })
}

// ---------------------------------------------------------------------------
// Item views
// ---------------------------------------------------------------------------

export function assertionText(version: AssertionVersion): string {
  const payload = version.payload
  if (payload.kind === 'fact') return payload.proposition.type === 'free_form' ? payload.proposition.text : `${payload.proposition.slot.slotId}: ${String(payload.proposition.value)}`
  if (payload.kind === 'preference' || payload.kind === 'constraint') return payload.text
  if (payload.kind === 'decision') return payload.decision === payload.topic ? payload.decision : `${payload.topic}: ${payload.decision}`
  return payload.decisions.length ? `${payload.topic}: ${payload.decisions.join('; ')}` : payload.topic
}

function conditionsOf(version: AssertionVersion): readonly Condition[] {
  const payload = version.payload
  if (payload.kind === 'preference' || payload.kind === 'constraint') return payload.conditions
  if (payload.kind === 'fact' && payload.proposition.type === 'free_form') return payload.proposition.conditions
  return []
}

function basisOf(version: AssertionVersion): InspectorBasis {
  const basis = version.attribution.basis
  if (basis === 'user_correction') return 'corrected'
  if (basis === 'inference') return 'inferred'
  if (basis === 'imported_legacy') return 'imported'
  if (basis === 'verified_tool_result') return 'tool'
  if (basis === 'explicit_user_statement') return version.producer.name === 'explicit-command' ? 'explicit' : 'learned'
  return 'other'
}

function scopeOf(version: AssertionVersion): InspectorItem['scope'] {
  const conditions = conditionsOf(version)
  if (version.time.relation === 'temporary_exception') {
    return { kind: 'temporary', label: version.time.validTime.until ? `until ${version.time.validTime.until.slice(0, 10)}` : 'temporary', conditions }
  }
  if (!conditions.length) return { kind: 'general', label: 'everywhere', conditions }
  if (conditions.some((condition) => condition.key === 'scope' && condition.value === 'current_task')) return { kind: 'task', label: 'one task only', conditions }
  return {
    kind: 'conditional',
    label: conditions.map((condition) => `${condition.key === 'topic' ? 'when working on' : condition.key} ${Array.isArray(condition.value) ? condition.value.join(', ') : String(condition.value)}`).join('; '),
    conditions,
  }
}

function freshnessOf(validTime: ValidTime, now: string): InspectorItem['freshness'] {
  if (validTime.until && Date.parse(validTime.until) <= Date.parse(now)) return 'expired'
  if (validTime.from && Date.parse(validTime.from) > Date.parse(now)) return 'future'
  return 'current'
}

interface SourceRow { assertion_id: string; assertion_revision: string; event_id: string; relation: InspectorSource['relation']; source_kind: string | null; received_at: Date | null; text: string | null; span_quote: string | null }

async function sourcesFor(tx: PostgresMemoryTransaction, scopeId: string, refs: readonly { assertionId: string; revision: number }[], limitPerItem: number): Promise<Map<string, { count: number; shown: InspectorSource[] }>> {
  const result = new Map<string, { count: number; shown: InspectorSource[] }>()
  if (!refs.length) return result
  const rows = await tx.query<SourceRow>(
    `SELECT ee.assertion_id, ee.assertion_revision, ee.event_id, ee.relation, e.source_kind, e.received_at,
            e.envelope->'payload'->>'text' AS text, ee.source_span->>'quote' AS span_quote
     FROM ${SQL.evidence} ee
     JOIN ${SQL.events} e ON e.scope_id = ee.scope_id AND e.event_id = ee.event_id
     WHERE ee.scope_id = $1 AND ee.assertion_id = ANY($2::text[])
       AND NOT EXISTS (SELECT 1 FROM ${SQL.suppressions} s WHERE s.scope_id = ee.scope_id AND s.event_id = ee.event_id)
     ORDER BY e.received_at DESC`,
    [scopeId, [...new Set(refs.map((ref) => ref.assertionId))]],
  )
  const wanted = new Set(refs.map((ref) => `${ref.assertionId}#${ref.revision}`))
  for (const row of rows.rows) {
    const key = `${row.assertion_id}#${Number(row.assertion_revision)}`
    if (!wanted.has(key)) continue
    const entry = result.get(key) ?? { count: 0, shown: [] }
    entry.count += 1
    if (entry.shown.length < limitPerItem) {
      const own = row.source_kind !== null && USER_AUTHORED_SOURCES.has(row.source_kind)
      const quote = own ? (row.span_quote ?? row.text ?? null) : null
      entry.shown.push({
        eventId: row.event_id,
        kind: row.source_kind ?? 'unknown',
        receivedAt: row.received_at ? new Date(row.received_at).toISOString() : '',
        quote: quote ? quote.slice(0, 280) : null,
        relation: row.relation,
      })
    }
    result.set(key, entry)
  }
  return result
}

async function proposedReasons(tx: PostgresMemoryTransaction, scopeId: string, assertionIds: readonly string[]): Promise<Map<string, string>> {
  if (!assertionIds.length) return new Map()
  const rows = await tx.query<{ assertion_id: string; reason: string }>(
    `SELECT DISTINCT ON (assertion_id) assertion_id, reason FROM ${SQL.decisions}
     WHERE scope_id = $1 AND assertion_id = ANY($2::text[]) AND action IN ('add', 'promote')
     ORDER BY assertion_id, created_at DESC`,
    [scopeId, [...assertionIds]],
  )
  return new Map(rows.rows.map((row) => [row.assertion_id, row.reason]))
}

interface ItemRow { assertion_id: string; current_status: string; updated_at: Date; version: unknown; revisions: string }

async function itemsFromRows(tx: PostgresMemoryTransaction, scopeId: string, rows: readonly ItemRow[], now: string): Promise<InspectorItem[]> {
  const versions: { row: ItemRow; version: AssertionVersion }[] = []
  for (const row of rows) {
    const parsed = parseAssertionVersion(row.version)
    if (!parsed.ok) continue
    if (await tx.isVersionSuppressed({ assertionId: parsed.value.id, revision: parsed.value.revision }, parsed.value.evidence.map((edge) => edge.eventId))) continue
    versions.push({ row, version: parsed.value })
  }
  const refs = versions.map(({ version }) => ({ assertionId: version.id, revision: version.revision }))
  const sources = await sourcesFor(tx, scopeId, refs, MAX_SHOWN_SOURCES)
  const reasons = await proposedReasons(tx, scopeId, versions.filter(({ version }) => version.status !== 'accepted').map(({ version }) => version.id))
  return versions.map(({ row, version }) => {
    const key = `${version.id}#${version.revision}`
    const found = sources.get(key) ?? { count: 0, shown: [] }
    const supporting = found.shown.filter((source) => source.relation !== 'contradicts')
    const contradicting = found.shown.filter((source) => source.relation === 'contradicts').length
    const basis = basisOf(version)
    const gap = found.count ? null : basis === 'imported' ? 'no_citation_imported' as const : version.attribution.basis === 'imported_legacy' ? 'no_citation_legacy' as const : 'sources_removed' as const
    return {
      assertionId: version.id,
      revision: version.revision,
      kind: version.kind,
      text: assertionText(version),
      status: (row.current_status === 'disputed' ? 'disputed' : version.status === 'candidate' ? 'candidate' : 'accepted') as InspectorStatus,
      basis,
      basisDetail: version.attribution.basis,
      producer: version.producer.name,
      polarity: version.polarity,
      scope: scopeOf(version),
      relation: version.time.relation,
      validTime: version.time.validTime,
      freshness: freshnessOf(version.time.validTime, now),
      receivedAt: version.time.receivedAt,
      interpretedAt: version.time.interpretedAt,
      updatedAt: new Date(row.updated_at).toISOString(),
      proposedReason: reasons.get(version.id) ?? null,
      sources: { count: found.count, shown: supporting, gap },
      conflict: { disputed: row.current_status === 'disputed', contradicting },
      revisions: Number(row.revisions),
    }
  })
}

const ITEM_SELECT = `
  SELECT a.assertion_id, a.current_status, a.updated_at, v.version,
         (SELECT count(*) FROM ${SQL.versions} h WHERE h.scope_id = a.scope_id AND h.assertion_id = a.assertion_id)::text AS revisions
  FROM ${SQL.assertions} a
  JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision`

const FILTERS: Record<InspectorFilter, { statuses: readonly string[]; kinds: readonly string[] | null }> = {
  all: { statuses: VISIBLE_STATUSES, kinds: ['fact', 'preference', 'constraint', 'decision'] },
  preferences: { statuses: ['accepted', 'disputed'], kinds: ['preference', 'constraint'] },
  facts: { statuses: ['accepted', 'disputed'], kinds: ['fact'] },
  decisions: { statuses: ['accepted', 'disputed'], kinds: ['decision'] },
  proposed: { statuses: ['candidate'], kinds: ['fact', 'preference', 'constraint', 'decision'] },
  topics: { statuses: VISIBLE_STATUSES, kinds: ['episode_checkpoint'] },
}

function encodeCursor(updatedAt: string, assertionId: string): string {
  return Buffer.from(JSON.stringify([updatedAt, assertionId])).toString('base64url')
}

function decodeCursor(cursor: string | null | undefined): [string, string] | null | 'invalid' {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isFinite(Date.parse(value[0])) && typeof value[1] === 'string' && value[1].length <= 200) return [value[0], value[1]]
  } catch {
    // fall through
  }
  return 'invalid'
}

export interface ListOptions { filter?: InspectorFilter; cursor?: string | null; limit?: number; query?: string | null; now?: string }

export async function listMemoryItems(session: MemorySession, options: ListOptions = {}): Promise<ControlsResult<InspectorPage>> {
  return guarded(async () => {
    const bound = durable(session)
    const filter = FILTERS[options.filter ?? 'all']
    if (!filter) throw failure('validation', 'Unknown filter.')
    const cursor = decodeCursor(options.cursor)
    if (cursor === 'invalid') throw failure('validation', 'That page link is not valid; start from the first page.')
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 20), 1), INSPECTOR_PAGE_LIMIT)
    const query = options.query?.trim().slice(0, 120) || null
    const now = options.now ?? isoNow()
    return inScope(bound, 'inspect', async (tx) => {
      const rows = await tx.query<ItemRow>(
        `${ITEM_SELECT}
         WHERE a.scope_id = $1 AND a.current_status = ANY($2::text[]) AND v.version->>'kind' = ANY($3::text[])
           AND ($4::text IS NULL OR (v.version->'payload')::text ILIKE '%' || $4 || '%')
           AND ($5::timestamptz IS NULL OR (a.updated_at, a.assertion_id) < ($5::timestamptz, $6::text))
         ORDER BY a.updated_at DESC, a.assertion_id DESC
         LIMIT $7`,
        [bound.scope.id, [...filter.statuses], [...(filter.kinds ?? [])], query?.replace(/[\\%_]/gu, (match) => `\\${match}`) ?? null, cursor?.[0] ?? null, cursor?.[1] ?? '', limit + 1],
      )
      const page = rows.rows.slice(0, limit)
      const items = await itemsFromRows(tx, bound.scope.id, page, now)
      const last = page.at(-1)
      return { items, nextCursor: rows.rows.length > limit && last ? encodeCursor(new Date(last.updated_at).toISOString(), last.assertion_id) : null }
    })
  })
}

export async function memoryOverview(session: MemorySession, options: { now?: string } = {}): Promise<ControlsResult<InspectorOverview>> {
  return guarded(async () => {
    const bound = durable(session)
    const now = options.now ?? isoNow()
    return inScope(bound, 'inspect', async (tx) => {
      const counts = await tx.query<{ accepted: string; proposed: string; disputed: string; topics: string }>(
        `SELECT count(*) FILTER (WHERE a.current_status = 'accepted' AND v.version->>'kind' <> 'episode_checkpoint')::text AS accepted,
                count(*) FILTER (WHERE a.current_status = 'candidate')::text AS proposed,
                count(*) FILTER (WHERE a.current_status = 'disputed')::text AS disputed,
                count(*) FILTER (WHERE a.current_status = 'accepted' AND v.version->>'kind' = 'episode_checkpoint')::text AS topics
         FROM ${SQL.assertions} a
         JOIN ${SQL.versions} v ON v.scope_id = a.scope_id AND v.assertion_id = a.assertion_id AND v.revision = a.current_revision
         WHERE a.scope_id = $1`,
        [bound.scope.id],
      )
      const section = async (statuses: readonly string[], kinds: readonly string[], limit: number, userFirst: boolean) => {
        const rows = await tx.query<ItemRow>(
          `${ITEM_SELECT}
           WHERE a.scope_id = $1 AND a.current_status = ANY($2::text[]) AND v.version->>'kind' = ANY($3::text[])
           ORDER BY ${userFirst ? `(v.version->'attribution'->>'basis' IN ('explicit_user_statement', 'user_correction')) DESC,` : ''} a.updated_at DESC
           LIMIT $4`,
          [bound.scope.id, [...statuses], [...kinds], limit],
        )
        return itemsFromRows(tx, bound.scope.id, rows.rows, now)
      }
      const recent = await tx.query<{ change_kind: string; created_at: Date; assertion_id: string | null; version: unknown }>(
        `SELECT c.change_kind, c.created_at, c.assertion_id, v.version
         FROM ${SQL.changes} c
         LEFT JOIN ${SQL.versions} v ON v.scope_id = c.scope_id AND v.assertion_id = c.assertion_id AND v.revision = c.assertion_revision
         WHERE c.scope_id = $1
         ORDER BY c.watermark DESC LIMIT 6`,
        [bound.scope.id],
      )
      const recentChanges = []
      for (const row of recent.rows) {
        const parsed = row.version ? parseAssertionVersion(row.version) : null
        const hidden = parsed?.ok ? await tx.isVersionSuppressed({ assertionId: parsed.value.id, revision: parsed.value.revision }, parsed.value.evidence.map((edge) => edge.eventId)) : true
        recentChanges.push({ kind: row.change_kind, at: new Date(row.created_at).toISOString(), assertionId: hidden ? null : row.assertion_id, text: hidden || !parsed?.ok ? null : assertionText(parsed.value).slice(0, 200) })
      }
      const row = counts.rows[0]!
      return {
        counts: { accepted: Number(row.accepted), proposed: Number(row.proposed), disputed: Number(row.disputed), topics: Number(row.topics) },
        preferences: await section(['accepted', 'disputed'], ['preference', 'constraint'], 8, true),
        facts: await section(['accepted', 'disputed'], ['fact'], 8, true),
        decisions: await section(['accepted', 'disputed'], ['decision'], 5, false),
        topics: await section(['accepted'], ['episode_checkpoint'], 5, false),
        proposed: await section(['candidate'], ['fact', 'preference', 'constraint', 'decision'], 8, false),
        recentChanges,
        settings: await readSettings(tx, bound.scope.id, now),
      }
    })
  })
}

async function currentItemRow(tx: PostgresMemoryTransaction, scopeId: string, assertionId: string): Promise<ItemRow | null> {
  const rows = await tx.query<ItemRow>(`${ITEM_SELECT} WHERE a.scope_id = $1 AND a.assertion_id = $2 AND a.current_status = ANY($3::text[])`, [scopeId, assertionId, [...VISIBLE_STATUSES]])
  return rows.rows[0] ?? null
}

async function readItem(tx: PostgresMemoryTransaction, scopeId: string, assertionId: string, now: string): Promise<InspectorItem | null> {
  const row = await currentItemRow(tx, scopeId, assertionId)
  if (!row) return null
  return (await itemsFromRows(tx, scopeId, [row], now))[0] ?? null
}

const NOT_FOUND = 'That memory is not available. It may have been forgotten or changed.'

export async function memoryItemDetail(session: MemorySession, assertionId: string, options: { now?: string } = {}): Promise<ControlsResult<InspectorDetail>> {
  return guarded(async () => {
    const bound = durable(session)
    const now = options.now ?? isoNow()
    if (typeof assertionId !== 'string' || !assertionId.startsWith('assertion/') || assertionId.length > 200) throw failure('not_found', NOT_FOUND)
    return inScope(bound, 'inspect', async (tx) => {
      const item = await readItem(tx, bound.scope.id, assertionId, now)
      if (!item) throw failure('not_found', NOT_FOUND)
      const history: InspectorDetail['history'][number][] = []
      for (const version of await tx.allVersions(assertionId as AssertionId)) {
        if (await tx.isVersionSuppressed({ assertionId: version.id, revision: version.revision }, version.evidence.map((edge) => edge.eventId))) continue
        history.push({ revision: version.revision, text: assertionText(version), status: version.status, relation: version.time.relation, basis: version.attribution.basis, interpretedAt: version.time.interpretedAt, validTime: version.time.validTime })
      }
      const sources = await sourcesFor(tx, bound.scope.id, [{ assertionId, revision: item.revision }], 12)
      const decisions = await tx.query<{ action: string; reason: string; created_at: Date }>(
        `SELECT action, reason, created_at FROM ${SQL.decisions} WHERE scope_id = $1 AND assertion_id = $2 ORDER BY created_at DESC LIMIT 10`,
        [bound.scope.id, assertionId],
      )
      return {
        item,
        history,
        sources: sources.get(`${assertionId}#${item.revision}`)?.shown ?? [],
        decisions: decisions.rows.map((row) => ({ action: row.action, reason: row.reason, at: new Date(row.created_at).toISOString() })),
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Edit and forget
// ---------------------------------------------------------------------------

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/u

function commandIdFor(scopeId: string, operation: string, requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw failure('validation', 'Each change needs a request id so a retry cannot apply twice.')
  return `controls/${operation}/${sha256({ scopeId, requestId }).slice(0, 40)}`
}

export interface EditInput {
  assertionId: string
  expectedRevision: number
  text: string
  /** `mistake`: it was never right. `changed`: it was right until `since`. */
  change: 'mistake' | 'changed'
  since?: string | null
  /** Contextual: add a narrower version that applies only to this topic; the general one stays. */
  context?: string | null
  requestId: string
}

export interface EditOutcome {
  item: InspectorItem
  /** For a contextual edit, the unchanged general item is returned too. */
  general: InspectorItem | null
  receiptState: string
  receiptId: string
  duplicate: boolean
}

export async function editMemoryItem(session: MemorySession, input: EditInput, options: { now?: string } = {}): Promise<ControlsResult<EditOutcome>> {
  return guarded(async () => {
    const bound = durable(session)
    const now = options.now ?? isoNow()
    const text = typeof input.text === 'string' ? input.text.normalize('NFKC').replace(/\s+/gu, ' ').trim() : ''
    if (!text || text.length > MAX_ITEM_TEXT_CHARS) throw failure('validation', `The new wording must be 1 to ${MAX_ITEM_TEXT_CHARS} characters.`)
    if (input.change !== 'mistake' && input.change !== 'changed') throw failure('validation', 'Say whether this was a mistake or a real change.')
    const context = typeof input.context === 'string' ? input.context.trim().slice(0, 120) : ''
    const since = input.since ? new Date(input.since) : null
    if (since && (!Number.isFinite(since.getTime()) || since.getTime() > Date.parse(now))) throw failure('validation', 'The change date must be a past or current date.')
    const commandId = commandIdFor(bound.scope.id, context ? 'contextual' : 'edit', input.requestId)

    // Read what the user is editing, in scope, and refuse a stale tab.
    const current = await inScope(bound, 'inspect', (tx) => currentItemRow(tx, bound.scope.id, input.assertionId))
    const parsed = current ? parseAssertionVersion(current.version) : null
    if (!parsed?.ok || parsed.value.kind === 'episode_checkpoint') throw failure('not_found', NOT_FOUND)
    const version = parsed.value
    if (version.revision !== input.expectedRevision) {
      throw failure('conflict', 'This memory changed since you opened it. Review the current wording first.', true, { currentRevision: version.revision })
    }
    if (version.status === 'candidate') throw failure('validation', 'A proposed memory cannot be edited. Keep it by saying it yourself, or forget it.')
    const assertionKind = version.kind as Exclude<AssertionVersion['kind'], 'episode_checkpoint'>

    const result = context
      ? await executeExplicitCommand(bound, {
          schemaVersion: 1, commandId, kind: 'remember', text, assertionKind,
          conditions: [...conditionsOf(version).filter((condition) => condition.key !== 'topic'), { key: 'topic', operator: 'equals', value: context }],
          polarity: version.polarity,
        }, { now })
      : await executeExplicitCommand(bound, {
          schemaVersion: 1, commandId, kind: 'correct', targetAssertionId: version.id, targetRevision: version.revision, text, assertionKind,
          conditions: [...conditionsOf(version)],
          relation: input.change === 'changed' ? 'transition' : 'correction',
          ...(input.change === 'changed' ? { validTime: { from: (since ?? new Date(now)).toISOString(), until: null, precision: since ? 'day' : 'second', sourceTimeZone: null } } : {}),
          polarity: version.polarity,
        }, { now })
    if (!result.ok) throw new PostgresMemoryOperationError(result.failure)
    // The accepted state is read back, never assumed from the request.
    return inScope(bound, 'inspect', async (tx) => {
      const item = await readItem(tx, bound.scope.id, result.assertion.id, now)
      if (!item) throw failure('unavailable', 'The change was accepted but could not be read back yet. Refresh to see it.', true)
      const general = context ? await readItem(tx, bound.scope.id, version.id, now) : null
      return { item, general, receiptState: result.receipt.state, receiptId: result.receipt.receiptId, duplicate: result.outcome === 'duplicate' }
    })
  })
}

export interface ForgetOutcome {
  assertionId: string
  deletionId: string
  /** Recall and export stop immediately; physical cleanup is reported separately. */
  logical: 'blocked'
  physical: DeletionReceipt['physical']
  externalCopies: DeletionReceipt['backup']['externallyControlledCopies']
}

export async function forgetMemoryItem(session: MemorySession, input: { assertionId: string; expectedRevision: number; requestId: string }, options: { now?: string } = {}): Promise<ControlsResult<ForgetOutcome>> {
  return guarded(async () => {
    const bound = durable(session)
    const now = options.now ?? isoNow()
    const commandId = commandIdFor(bound.scope.id, 'forget', input.requestId)
    const current = await inScope(bound, 'inspect', (tx) => currentItemRow(tx, bound.scope.id, input.assertionId))
    const parsed = current ? parseAssertionVersion(current.version) : null
    if (!parsed?.ok) throw failure('not_found', NOT_FOUND)
    if (parsed.value.revision !== input.expectedRevision) {
      throw failure('conflict', 'This memory changed since you opened it. Review the current wording before forgetting it.', true, { currentRevision: parsed.value.revision })
    }
    const result = await executeForgetCommand(bound, {
      schemaVersion: 1, commandId, kind: 'forget', targetAssertionId: parsed.value.id, targetRevision: parsed.value.revision, query: null,
    }, { now })
    if (!result.ok) throw new PostgresMemoryOperationError(result.failure)
    return { assertionId: parsed.value.id, deletionId: result.receipt.deletionId, logical: 'blocked', physical: result.receipt.physical, externalCopies: result.receipt.backup.externallyControlledCopies }
  })
}

export async function memoryDeletionStatus(session: MemorySession, deletionId: string): Promise<ControlsResult<Pick<ForgetOutcome, 'deletionId' | 'physical'>>> {
  return guarded(async () => {
    const bound = durable(session)
    if (typeof deletionId !== 'string' || !deletionId.startsWith('deletion/') || deletionId.length > 120) throw failure('not_found', 'That deletion is not available.')
    const status = await getDeletionStatus(bound, deletionId)
    if (!status.ok) throw new PostgresMemoryOperationError(status.failure)
    return { deletionId, physical: status.receipt.physical }
  })
}

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

export async function exportMemory(session: MemorySession, options: { now?: string } = {}): Promise<ControlsResult<MemoryExportDocument>> {
  return guarded(async () => {
    const bound = durable(session)
    const now = options.now ?? isoNow()
    return inScope(bound, 'export', async (tx) => {
      const rows = await tx.query<ItemRow>(
        `${ITEM_SELECT} WHERE a.scope_id = $1 AND a.current_status = ANY($2::text[]) ORDER BY a.created_at, a.assertion_id LIMIT $3`,
        [bound.scope.id, [...VISIBLE_STATUSES], MAX_EXPORT_ITEMS + 1],
      )
      const items = await itemsFromRows(tx, bound.scope.id, rows.rows.slice(0, MAX_EXPORT_ITEMS), now)
      const allSources = await sourcesFor(tx, bound.scope.id, items.map((item) => ({ assertionId: item.assertionId, revision: item.revision })), 32)
      const exported: MemoryExportItem[] = []
      for (const item of items) {
        const history = []
        for (const version of await tx.allVersions(item.assertionId as AssertionId)) {
          if (version.revision === item.revision) continue
          if (await tx.isVersionSuppressed({ assertionId: version.id, revision: version.revision }, version.evidence.map((edge) => edge.eventId))) continue
          history.push({ revision: version.revision, text: assertionText(version), relation: version.time.relation, interpretedAt: version.time.interpretedAt })
        }
        exported.push({
          assertionId: item.assertionId, revision: item.revision, kind: item.kind, text: item.text, status: item.status,
          basis: item.basisDetail, polarity: item.polarity, conditions: item.scope.conditions, relation: item.relation,
          validTime: item.validTime, receivedAt: item.receivedAt, interpretedAt: item.interpretedAt,
          sources: (allSources.get(`${item.assertionId}#${item.revision}`)?.shown ?? []).map((source) => ({ eventId: source.eventId, kind: source.kind, receivedAt: source.receivedAt, quote: source.quote })),
          history,
        })
      }
      const watermark = await tx.query<{ next_watermark: string }>(`SELECT next_watermark FROM ${SQL.counters} WHERE scope_id = $1`, [bound.scope.id])
      const settings = await readSettings(tx, bound.scope.id, now)
      const gaps: string[] = []
      const uncited = exported.filter((item) => !item.sources.length).length
      if (uncited) gaps.push(`${uncited} item(s) have no source citation (imported, legacy, or sources removed by retention or deletion).`)
      if (rows.rows.length > MAX_EXPORT_ITEMS) gaps.push(`Only the first ${MAX_EXPORT_ITEMS} items are included.`)
      gaps.push('Quotes are included only for your own words; assistant and third-party sources are listed by kind.')
      return {
        format: MEMORY_EXPORT_FORMAT,
        formatVersion: MEMORY_EXPORT_VERSION,
        exportedAt: now,
        scopeFingerprint: scopeFingerprint(bound.scope.id),
        baseWatermark: Number(watermark.rows[0]?.next_watermark ?? 0),
        semantics: EXPORT_SEMANTICS,
        provenanceGaps: gaps,
        settings: { learningEnabled: settings.learningEnabled, temporaryUntil: settings.temporaryUntil, evidenceRetentionDays: settings.evidenceRetentionDays },
        counts: {
          items: exported.length,
          accepted: exported.filter((item) => item.status === 'accepted').length,
          proposed: exported.filter((item) => item.status === 'candidate').length,
          disputed: exported.filter((item) => item.status === 'disputed').length,
        },
        itemsSha256: sha256(canonicalJson(exported)),
        items: exported,
      }
    })
  })
}

export type ImportItemOutcome = 'imported' | 'duplicate' | 'unchanged' | 'stale' | 'suppressed' | 'not_accepted' | 'invalid' | 'failed'

export interface ImportOutcome {
  importId: string
  results: readonly { index: number; outcome: ImportItemOutcome; reason: string | null; assertionId: string | null }[]
  counts: Record<ImportItemOutcome, number>
}

/**
 * Controlled import of this account's own export. Refused whole for another
 * account's file. Per item: proposed and disputed items are never imported as
 * accepted; anything forgotten (the item or any cited source) stays forgotten;
 * anything changed since the export is left as it is now. What remains is
 * written as an attributable import, not as something the user said.
 */
export async function importMemory(session: MemorySession, raw: unknown, byteLength: number, options: { now?: string } = {}): Promise<ControlsResult<ImportOutcome>> {
  return guarded(async () => {
    const bound = durable(session)
    const now = options.now ?? isoNow()
    const parsed = parseImportDocument(raw, byteLength)
    if (!parsed.ok) throw failure('validation', `The file cannot be imported (${parsed.reason}).`, false, { reason: parsed.reason })
    if (parsed.scopeFingerprint !== scopeFingerprint(bound.scope.id)) {
      throw failure('validation', 'This file was exported from a different account and cannot be imported here.', false, { reason: 'scope_mismatch' })
    }
    const importId = `import/${sha256({ scope: bound.scope.id, raw: canonicalJson(raw) }).slice(0, 32)}`
    const results: { index: number; outcome: ImportItemOutcome; reason: string | null; assertionId: string | null }[] = parsed.rejected.map((entry) => ({ index: entry.index, outcome: 'invalid', reason: entry.reason, assertionId: null }))

    // Decide every item against current state before writing anything.
    const plan = await inScope(bound, 'remember', async (tx) => {
      const decisions: { item: typeof parsed.items[number]; outcome: ImportItemOutcome | 'write'; reason: string | null }[] = []
      for (const item of parsed.items) {
        if (item.status !== 'accepted') { decisions.push({ item, outcome: 'not_accepted', reason: 'proposed_or_disputed' }); continue }
        if (item.sourceEventIds.length) {
          const suppressedSource = await tx.query(`SELECT 1 FROM ${SQL.suppressions} WHERE scope_id = $1 AND event_id = ANY($2::text[]) LIMIT 1`, [bound.scope.id, [...item.sourceEventIds]])
          if (suppressedSource.rows[0]) { decisions.push({ item, outcome: 'suppressed', reason: 'source_forgotten' }); continue }
        }
        if (!item.assertionId) { decisions.push({ item, outcome: 'write', reason: null }); continue }
        const suppressed = await tx.query(`SELECT 1 FROM ${SQL.suppressions} WHERE scope_id = $1 AND assertion_id = $2 LIMIT 1`, [bound.scope.id, item.assertionId])
        if (suppressed.rows[0]) { decisions.push({ item, outcome: 'suppressed', reason: 'memory_forgotten' }); continue }
        const existing = await tx.query<{ current_revision: string; current_status: string }>(`SELECT current_revision, current_status FROM ${SQL.assertions} WHERE scope_id = $1 AND assertion_id = $2`, [bound.scope.id, item.assertionId])
        const row = existing.rows[0]
        if (!row) { decisions.push({ item, outcome: 'write', reason: null }); continue }
        if (row.current_status === 'deleted') { decisions.push({ item, outcome: 'suppressed', reason: 'memory_forgotten' }); continue }
        if (item.revision !== null && Number(row.current_revision) === item.revision && ['accepted', 'disputed'].includes(row.current_status)) {
          decisions.push({ item, outcome: 'unchanged', reason: null })
          continue
        }
        decisions.push({ item, outcome: 'stale', reason: 'changed_since_export' })
      }
      return decisions
    })

    for (const decision of plan) {
      if (decision.outcome !== 'write') {
        results.push({ index: decision.item.index, outcome: decision.outcome, reason: decision.reason, assertionId: decision.item.assertionId })
        continue
      }
      const written = await executeExplicitCommand(bound, {
        schemaVersion: 1,
        commandId: `${importId}/${decision.item.index}`,
        kind: 'remember',
        text: decision.item.text,
        assertionKind: decision.item.kind,
        conditions: decision.item.conditions,
        polarity: decision.item.polarity,
      }, { now, origin: { kind: 'import', importId, exportedAt: parsed.exportedAt } })
      if (written.ok) {
        results.push({ index: decision.item.index, outcome: written.outcome === 'duplicate' ? 'duplicate' : 'imported', reason: null, assertionId: written.assertion.id })
      } else {
        results.push({ index: decision.item.index, outcome: written.failure.code === 'suppressed' ? 'suppressed' : 'failed', reason: written.failure.code, assertionId: null })
      }
    }
    results.sort((left, right) => left.index - right.index)
    const counts = { imported: 0, duplicate: 0, unchanged: 0, stale: 0, suppressed: 0, not_accepted: 0, invalid: 0, failed: 0 } satisfies Record<ImportItemOutcome, number>
    for (const result of results) counts[result.outcome] += 1
    return { importId, results, counts }
  })
}

// ---------------------------------------------------------------------------
// Background enforcement
// ---------------------------------------------------------------------------

/** Scopes among these whose owner turned learning off or is in a temporary conversation. */
export async function scopesWithoutLearning(store: PostgresMemoryStore, scopeIds: readonly string[], now = isoNow()): Promise<Set<string>> {
  if (!scopeIds.length) return new Set()
  const rows = await store.runTransaction((tx) => tx.query<{ scope_id: string }>(
    `SELECT scope_id FROM ${SQL.settings}
     WHERE scope_id = ANY($1::text[]) AND (learning_enabled = false OR (temporary_until IS NOT NULL AND temporary_until > $2::timestamptz))`,
    [[...new Set(scopeIds)], now],
  ))
  return new Set(rows.rows.map((row) => row.scope_id))
}

/** Applies each scope's evidence retention choice; bounded per tick. */
export async function runEvidenceRetention(store: PostgresMemoryStore, options: { now?: string; scopes?: number; eventsPerScope?: number } = {}): Promise<{ scopes: number; suppressedEvents: number }> {
  const now = options.now ?? isoNow()
  const due = await store.runTransaction((tx) => tx.query<{ scope_id: string; days: number; principal_id: string | null; policy_epoch: string | null }>(
    `SELECT s.scope_id, s.evidence_retention_days AS days, g.principal_id, e.policy_epoch
     FROM ${SQL.settings} s
     LEFT JOIN LATERAL (SELECT principal_id FROM ${SQL.grants} WHERE scope_id = s.scope_id AND revoked_at IS NULL LIMIT 1) g ON true
     LEFT JOIN ${SQL.epochs} e ON e.scope_id = s.scope_id
     WHERE s.evidence_retention_days IS NOT NULL
     ORDER BY s.updated_at
     LIMIT $1`,
    [Math.min(Math.max(options.scopes ?? 10, 1), 100)],
  ))
  let suppressedEvents = 0
  let scopes = 0
  for (const row of due.rows) {
    if (!row.principal_id || row.policy_epoch === null) continue
    const cutoff = new Date(Date.parse(now) - row.days * 86_400_000).toISOString()
    const result = await executeEvidenceRetention(store, {
      scopeId: row.scope_id as ScopeId, principalId: row.principal_id as PrincipalId, policyEpoch: Number(row.policy_epoch), cutoff, now, limit: options.eventsPerScope,
    }).catch(() => null)
    if (result?.suppressedEvents) {
      scopes += 1
      suppressedEvents += result.suppressedEvents
    }
  }
  return { scopes, suppressedEvents }
}
