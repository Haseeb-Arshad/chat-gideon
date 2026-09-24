import type { AssertionKind, AssertionPolarity, Condition, SourceBasis, TemporalRelation, ValidTime } from './contracts'

/**
 * Stage 12 memory controls: edge-safe view types, the export format, the
 * strict import parser and the readable Markdown projection.
 *
 * Nothing here reads storage or decides authority. The server builds these
 * views from the scope-bound authority; the browser only renders them.
 */

export const MEMORY_EXPORT_FORMAT = 'chatgideon.memory-export' as const
export const MEMORY_EXPORT_VERSION = 1 as const
export const MAX_IMPORT_ITEMS = 500
export const MAX_IMPORT_BYTES = 512 * 1024
export const MAX_ITEM_TEXT_CHARS = 1_000
export const INSPECTOR_PAGE_LIMIT = 50

export type InspectorBasis = 'explicit' | 'corrected' | 'learned' | 'inferred' | 'imported' | 'tool' | 'other'
export type InspectorStatus = 'accepted' | 'candidate' | 'disputed'
export type InspectorFilter = 'all' | 'preferences' | 'facts' | 'decisions' | 'proposed' | 'topics'

export interface InspectorSource {
  eventId: string
  kind: string
  receivedAt: string
  /** Only the user's own words are quoted; other sources are listed by kind. */
  quote: string | null
  relation: 'supports' | 'contradicts' | 'derived_from'
}

export interface InspectorItem {
  assertionId: string
  revision: number
  kind: AssertionKind
  text: string
  status: InspectorStatus
  basis: InspectorBasis
  basisDetail: SourceBasis
  producer: string
  polarity: AssertionPolarity
  scope: { kind: 'general' | 'conditional' | 'task' | 'temporary'; label: string; conditions: readonly Condition[] }
  relation: TemporalRelation
  validTime: ValidTime
  freshness: 'current' | 'expired' | 'future'
  receivedAt: string
  interpretedAt: string
  updatedAt: string
  /** Why a proposed item is waiting, as a reason code, if one was recorded. */
  proposedReason: string | null
  sources: { count: number; shown: readonly InspectorSource[]; gap: null | 'no_citation_imported' | 'no_citation_legacy' | 'sources_removed' }
  conflict: { disputed: boolean; contradicting: number }
  revisions: number
}

export interface InspectorPage {
  items: readonly InspectorItem[]
  nextCursor: string | null
}

export interface InspectorOverview {
  counts: { accepted: number; proposed: number; disputed: number; topics: number }
  preferences: readonly InspectorItem[]
  facts: readonly InspectorItem[]
  decisions: readonly InspectorItem[]
  topics: readonly InspectorItem[]
  proposed: readonly InspectorItem[]
  recentChanges: readonly { kind: string; at: string; assertionId: string | null; text: string | null }[]
  settings: MemorySettingsView
}

export interface InspectorVersion {
  revision: number
  text: string
  status: string
  relation: TemporalRelation
  basis: SourceBasis
  interpretedAt: string
  validTime: ValidTime
}

export interface InspectorDetail {
  item: InspectorItem
  history: readonly InspectorVersion[]
  sources: readonly InspectorSource[]
  decisions: readonly { action: string; reason: string; at: string }[]
}

export interface MemorySettingsView {
  revision: number
  learningEnabled: boolean
  temporaryUntil: string | null
  temporaryActive: boolean
  evidenceRetentionDays: 30 | 90 | 365 | null
}

/** What each setting does, shown next to it; the server enforces the same. */
export const SETTING_EFFECTS = {
  learning: 'Off stops learning from new and queued conversation turns. Nothing already remembered is deleted, and "remember this" still works.',
  temporary: 'On means this account\'s conversations are not captured, nothing is saved, and memories are not used, until you turn it off or it expires. Nothing already remembered is deleted.',
  retention: 'Conversation turns that never became a memory are deleted after the chosen period. Memories and the words they cite are kept until you forget them.',
} as const

export const RETENTION_CHOICES = [null, 30, 90, 365] as const

// ---------------------------------------------------------------------------
// Export format
// ---------------------------------------------------------------------------

export interface MemoryExportItem {
  assertionId: string
  revision: number
  kind: AssertionKind
  text: string
  status: InspectorStatus
  basis: SourceBasis
  polarity: AssertionPolarity
  conditions: readonly Condition[]
  relation: TemporalRelation
  validTime: ValidTime
  receivedAt: string
  interpretedAt: string
  sources: readonly { eventId: string; kind: string; receivedAt: string; quote: string | null }[]
  history: readonly { revision: number; text: string; relation: TemporalRelation; interpretedAt: string }[]
}

export interface MemoryExportDocument {
  format: typeof MEMORY_EXPORT_FORMAT
  formatVersion: typeof MEMORY_EXPORT_VERSION
  exportedAt: string
  /** A one-way fingerprint of the scope, so an import can refuse another account's file. */
  scopeFingerprint: string
  /** The scope's change watermark when exported; imports compare against it. */
  baseWatermark: number
  semantics: {
    time: string
    basis: string
    deletion: string
  }
  provenanceGaps: readonly string[]
  settings: Omit<MemorySettingsView, 'revision' | 'temporaryActive'>
  counts: { items: number; accepted: number; proposed: number; disputed: number }
  /** SHA-256 of the canonical items array, for integrity checks by the user. */
  itemsSha256: string
  items: readonly MemoryExportItem[]
}

export const EXPORT_SEMANTICS: MemoryExportDocument['semantics'] = Object.freeze({
  time: 'receivedAt is when the server received the statement, interpretedAt when it was accepted; validTime is when the statement is true in the world (null bounds mean unknown). All instants are UTC.',
  basis: 'explicit_user_statement: you said it; user_correction: you corrected it; inference: learned, not said outright; imported_legacy: came from an import, not from a conversation.',
  deletion: 'This file is a copy outside ChatGideon. Forgetting a memory later deletes it from ChatGideon, not from copies you saved or shared.',
})

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

export interface ImportItem {
  index: number
  assertionId: string | null
  revision: number | null
  kind: Exclude<AssertionKind, 'episode_checkpoint'>
  text: string
  status: InspectorStatus
  polarity: AssertionPolarity
  conditions: readonly Condition[]
  sourceEventIds: readonly string[]
}

export type ImportParseResult =
  | { ok: true; scopeFingerprint: string; baseWatermark: number; exportedAt: string | null; items: readonly ImportItem[]; rejected: readonly { index: number; reason: string }[] }
  | { ok: false; reason: string }

const ID = /^(?:assertion|event)\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/u
const CONDITION_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Identifiers are data, never paths: no traversal segments, no absolute or backslash forms. */
export function safeMemoryId(value: unknown, prefix: 'assertion' | 'event'): string | null {
  if (typeof value !== 'string' || value.length > 200 || !value.startsWith(`${prefix}/`)) return null
  if (!ID.test(value) || value.split('/').some((segment) => segment === '.' || segment === '..' || !segment)) return null
  return value
}

function parseCondition(value: unknown): Condition | null {
  if (!isRecord(value) || typeof value.key !== 'string' || !CONDITION_KEY.test(value.key)) return null
  if (!['equals', 'not_equals', 'contains', 'in'].includes(String(value.operator))) return null
  const scalar = (item: unknown) => (typeof item === 'string' && item.length <= 160) || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
  const ok = scalar(value.value) || (Array.isArray(value.value) && value.value.length <= 12 && value.value.every(scalar))
  return ok ? { key: value.key, operator: value.operator as Condition['operator'], value: value.value as Condition['value'] } : null
}

/**
 * Parses an uploaded export. It is untrusted: unknown formats and versions
 * are refused whole, every item is bounded, and anything malformed is
 * reported per item instead of guessed. Only the fields an import may use are
 * kept; basis, timestamps and history in the file are never trusted.
 */
export function parseImportDocument(raw: unknown, byteLength: number): ImportParseResult {
  if (byteLength > MAX_IMPORT_BYTES) return { ok: false, reason: 'too_large' }
  if (!isRecord(raw)) return { ok: false, reason: 'not_an_object' }
  if (raw.format !== MEMORY_EXPORT_FORMAT) return { ok: false, reason: 'unknown_format' }
  if (raw.formatVersion !== MEMORY_EXPORT_VERSION) return { ok: false, reason: 'unsupported_version' }
  if (typeof raw.scopeFingerprint !== 'string' || !/^[0-9a-f]{32}$/u.test(raw.scopeFingerprint)) return { ok: false, reason: 'invalid_scope_fingerprint' }
  const baseWatermark = raw.baseWatermark
  if (typeof baseWatermark !== 'number' || !Number.isSafeInteger(baseWatermark) || baseWatermark < 0) return { ok: false, reason: 'invalid_base_watermark' }
  if (!Array.isArray(raw.items)) return { ok: false, reason: 'missing_items' }
  if (raw.items.length > MAX_IMPORT_ITEMS) return { ok: false, reason: 'too_many_items' }
  const exportedAt = typeof raw.exportedAt === 'string' && Number.isFinite(Date.parse(raw.exportedAt)) ? raw.exportedAt : null
  const items: ImportItem[] = []
  const rejected: { index: number; reason: string }[] = []
  raw.items.forEach((entry, index) => {
    if (!isRecord(entry)) return rejected.push({ index, reason: 'invalid_item' })
    const kind = ['fact', 'preference', 'constraint', 'decision'].includes(String(entry.kind)) ? entry.kind as ImportItem['kind'] : null
    const text = typeof entry.text === 'string' ? entry.text.normalize('NFKC').replace(/\s+/gu, ' ').trim() : ''
    const status = ['accepted', 'candidate', 'disputed'].includes(String(entry.status)) ? entry.status as InspectorStatus : null
    const polarity = ['positive', 'negative', 'unknown'].includes(String(entry.polarity ?? 'positive')) ? (entry.polarity ?? 'positive') as AssertionPolarity : null
    if (!kind) return rejected.push({ index, reason: entry.kind === 'episode_checkpoint' ? 'topics_not_importable' : 'invalid_kind' })
    if (!text || text.length > MAX_ITEM_TEXT_CHARS) return rejected.push({ index, reason: 'invalid_text' })
    if (!status || !polarity) return rejected.push({ index, reason: 'invalid_status' })
    const assertionId = entry.assertionId === undefined || entry.assertionId === null ? null : safeMemoryId(entry.assertionId, 'assertion')
    if (entry.assertionId !== undefined && entry.assertionId !== null && !assertionId) return rejected.push({ index, reason: 'invalid_id' })
    const revision = entry.revision === undefined || entry.revision === null ? null : Number.isSafeInteger(entry.revision) && (entry.revision as number) >= 1 ? entry.revision as number : undefined
    if (revision === undefined) return rejected.push({ index, reason: 'invalid_revision' })
    const rawConditions = Array.isArray(entry.conditions) ? entry.conditions : entry.conditions === undefined ? [] : null
    const conditions = rawConditions?.map(parseCondition) ?? null
    if (!conditions || conditions.length > 12 || conditions.some((condition) => !condition)) return rejected.push({ index, reason: 'invalid_conditions' })
    const sources = Array.isArray(entry.sources) ? entry.sources : []
    if (sources.length > 32) return rejected.push({ index, reason: 'too_many_sources' })
    const sourceEventIds: string[] = []
    for (const source of sources) {
      const eventId = isRecord(source) ? safeMemoryId(source.eventId, 'event') : null
      if (!eventId) return rejected.push({ index, reason: 'invalid_id' })
      sourceEventIds.push(eventId)
    }
    items.push({ index, assertionId, revision, kind, text, status, polarity, conditions: conditions as Condition[], sourceEventIds })
  })
  return { ok: true, scopeFingerprint: raw.scopeFingerprint, baseWatermark, exportedAt, items, rejected }
}

// ---------------------------------------------------------------------------
// Readable projection
// ---------------------------------------------------------------------------

const KIND_HEADINGS: Record<string, string> = {
  preference: 'Preferences',
  constraint: 'Constraints',
  fact: 'Facts',
  decision: 'Decisions',
  episode_checkpoint: 'Conversation topics',
}

const BASIS_LABELS: Partial<Record<SourceBasis, string>> = {
  explicit_user_statement: 'you said this',
  user_correction: 'you corrected this',
  inference: 'learned, not said outright',
  imported_legacy: 'imported, no conversation citation',
  verified_tool_result: 'from a verified tool result',
}

function markdownText(text: string): string {
  return text.replace(/[\\`*_[\]<>#|]/gu, (match) => `\\${match}`).replace(/\r?\n/gu, ' ')
}

function conditionLabel(conditions: readonly Condition[]): string {
  if (!conditions.length) return 'general'
  return conditions.map((condition) => condition.key === 'scope' && condition.value === 'current_task' ? 'one task only' : `${condition.key} ${condition.operator.replace('_', ' ')} ${Array.isArray(condition.value) ? condition.value.join(', ') : String(condition.value)}`).join('; ')
}

/** A readable view of an export. The JSON is the authority; this is for people. */
export function renderMemoryMarkdown(document: MemoryExportDocument): string {
  const lines = [
    '# ChatGideon memory export',
    '',
    `Exported ${document.exportedAt} (UTC). ${document.counts.accepted} remembered, ${document.counts.proposed} proposed, ${document.counts.disputed} disputed.`,
    '',
    `> ${EXPORT_SEMANTICS.deletion}`,
    '',
  ]
  if (document.provenanceGaps.length) {
    lines.push('## Provenance gaps', '', ...document.provenanceGaps.map((gap) => `- ${markdownText(gap)}`), '')
  }
  const groups = new Map<string, MemoryExportItem[]>()
  for (const item of document.items) groups.set(item.kind, [...groups.get(item.kind) ?? [], item])
  for (const kind of ['preference', 'constraint', 'fact', 'decision', 'episode_checkpoint']) {
    const items = groups.get(kind)
    if (!items?.length) continue
    lines.push(`## ${KIND_HEADINGS[kind]}`, '')
    for (const item of items) {
      const status = item.status === 'accepted' ? '' : ` _(${item.status === 'candidate' ? 'proposed' : 'disputed'})_`
      const time = item.validTime.from || item.validTime.until ? `; valid ${item.validTime.from ?? '…'} to ${item.validTime.until ?? '…'}` : ''
      lines.push(`- ${markdownText(item.text)}${status}`)
      lines.push(`  - ${BASIS_LABELS[item.basis] ?? item.basis}; ${conditionLabel(item.conditions)}${time}; accepted ${item.interpretedAt}`)
      for (const source of item.sources.slice(0, 3)) {
        lines.push(`  - Source (${source.kind}, ${source.receivedAt})${source.quote ? `: "${markdownText(source.quote)}"` : ''}`)
      }
      if (!item.sources.length) lines.push('  - No source citation is available for this item.')
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
