import { describe, expect, it } from 'vitest'
import {
  EXPORT_SEMANTICS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ITEMS,
  MEMORY_EXPORT_FORMAT,
  parseImportDocument,
  renderMemoryMarkdown,
  safeMemoryId,
  type MemoryExportDocument,
} from './controls'

const fingerprint = 'a'.repeat(32)

function document(items: unknown[], extra: Record<string, unknown> = {}) {
  return { format: MEMORY_EXPORT_FORMAT, formatVersion: 1, exportedAt: '2026-09-24T10:00:00.000Z', scopeFingerprint: fingerprint, baseWatermark: 3, items, ...extra }
}

const item = {
  assertionId: 'assertion/cmd/abc', revision: 2, kind: 'preference', text: 'I prefer tea', status: 'accepted', basis: 'explicit_user_statement', polarity: 'positive',
  conditions: [{ key: 'topic', operator: 'equals', value: 'mornings' }], relation: 'ordinary',
  validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null },
  receivedAt: '2026-09-20T10:00:00.000Z', interpretedAt: '2026-09-20T10:00:00.000Z',
  sources: [{ eventId: 'event/user/abc', kind: 'user_statement', receivedAt: '2026-09-20T10:00:00.000Z', quote: 'I prefer tea' }], history: [],
}

describe('Stage 12 import parsing', () => {
  it('accepts this format and keeps only the fields an import may use', () => {
    const parsed = parseImportDocument(document([item]), 1_000)
    expect(parsed).toMatchObject({ ok: true, scopeFingerprint: fingerprint, baseWatermark: 3, rejected: [] })
    if (!parsed.ok) return
    expect(parsed.items).toEqual([{ index: 0, assertionId: 'assertion/cmd/abc', revision: 2, kind: 'preference', text: 'I prefer tea', status: 'accepted', polarity: 'positive', conditions: item.conditions, sourceEventIds: ['event/user/abc'] }])
    // Basis, timestamps and history in the file are never trusted.
    expect(Object.keys(parsed.items[0]!)).not.toContain('basis')
  })

  it('refuses unknown formats, versions, oversize files and too many items as a whole', () => {
    expect(parseImportDocument(document([item], { format: 'other' }), 10)).toEqual({ ok: false, reason: 'unknown_format' })
    expect(parseImportDocument(document([item], { formatVersion: 2 }), 10)).toEqual({ ok: false, reason: 'unsupported_version' })
    expect(parseImportDocument(document([item]), MAX_IMPORT_BYTES + 1)).toEqual({ ok: false, reason: 'too_large' })
    expect(parseImportDocument(document(Array.from({ length: MAX_IMPORT_ITEMS + 1 }, () => item)), 10)).toEqual({ ok: false, reason: 'too_many_items' })
    expect(parseImportDocument(document([item], { scopeFingerprint: '../other' }), 10)).toEqual({ ok: false, reason: 'invalid_scope_fingerprint' })
    expect(parseImportDocument(document([item], { baseWatermark: -1 }), 10)).toEqual({ ok: false, reason: 'invalid_base_watermark' })
    expect(parseImportDocument([item], 10)).toEqual({ ok: false, reason: 'not_an_object' })
  })

  it('rejects traversal-shaped ids, bad conditions and oversized text per item', () => {
    const parsed = parseImportDocument(document([
      { ...item, assertionId: 'assertion/../../etc/passwd' },
      { ...item, assertionId: '/assertion/abs' },
      { ...item, assertionId: 'assertion\\windows\\path' },
      { ...item, sources: [{ eventId: 'event/../x' }] },
      { ...item, conditions: [{ key: '1bad', operator: 'equals', value: 'x' }] },
      { ...item, text: 'x'.repeat(1_001) },
      { ...item, kind: 'episode_checkpoint' },
      { ...item, revision: 0 },
      { ...item, assertionId: null, sources: [] },
    ]), 10)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.rejected).toEqual([
      { index: 0, reason: 'invalid_id' }, { index: 1, reason: 'invalid_id' }, { index: 2, reason: 'invalid_id' }, { index: 3, reason: 'invalid_id' },
      { index: 4, reason: 'invalid_conditions' }, { index: 5, reason: 'invalid_text' }, { index: 6, reason: 'topics_not_importable' }, { index: 7, reason: 'invalid_revision' },
    ])
    expect(parsed.items.map((entry) => entry.index)).toEqual([8])
    expect(safeMemoryId('assertion/a/./b', 'assertion')).toBeNull()
    expect(safeMemoryId('assertion/a//b', 'assertion')).toBeNull()
    expect(safeMemoryId('event/a', 'assertion')).toBeNull()
    expect(safeMemoryId('assertion/learned/abc-123', 'assertion')).toBe('assertion/learned/abc-123')
  })
})

describe('Stage 12 readable projection', () => {
  it('groups by kind, states basis and scope, escapes Markdown, and names provenance gaps and uncontrolled copies', () => {
    const exported: MemoryExportDocument = {
      format: MEMORY_EXPORT_FORMAT, formatVersion: 1, exportedAt: '2026-09-24T10:00:00.000Z', scopeFingerprint: fingerprint, baseWatermark: 3,
      semantics: EXPORT_SEMANTICS, provenanceGaps: ['1 item(s) have no source citation.'],
      settings: { learningEnabled: true, temporaryUntil: null, evidenceRetentionDays: null },
      counts: { items: 2, accepted: 1, proposed: 1, disputed: 0 }, itemsSha256: 'x',
      items: [
        { ...item, text: 'I like *bold* <script>', basis: 'explicit_user_statement', status: 'accepted', validTime: { from: '2026-09-19T19:00:00.000Z', until: null, precision: 'day', sourceTimeZone: 'Asia/Karachi' } } as MemoryExportDocument['items'][number],
        { ...item, assertionId: 'assertion/learned/x', kind: 'fact', text: 'Works nights', basis: 'imported_legacy', status: 'candidate', conditions: [], sources: [] } as MemoryExportDocument['items'][number],
      ],
    }
    const markdown = renderMemoryMarkdown(exported)
    expect(markdown).toContain('## Preferences')
    expect(markdown).toContain('I like \\*bold\\* \\<script\\>')
    expect(markdown).toContain('you said this; topic equals mornings; valid 2026-09-20 (Asia/Karachi) to …')
    expect(markdown).toContain('Works nights _(proposed)_')
    expect(markdown).toContain('imported, no conversation citation')
    expect(markdown).toContain('No source citation is available for this item.')
    expect(markdown).toContain('## Provenance gaps')
    expect(markdown).toContain(EXPORT_SEMANTICS.deletion)
  })
})
