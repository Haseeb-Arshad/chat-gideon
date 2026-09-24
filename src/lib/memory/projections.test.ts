import { describe, expect, it } from 'vitest'
import type { AssertionVersion, EventId, PrincipalId, ScopeId, SubjectId } from './contracts'
import {
  MAX_PRIVATE_CACHE_LEASE_MS,
  MAX_INPUT_VERSIONS,
  SnapshotTelemetryBuffer,
  WarmSnapshotCache,
  applyAcceptedCorrectionOverlays,
  buildWarmSnapshot,
  parseWarmSnapshot,
  serializedWarmSnapshotBytes,
  type ProjectionChange,
  type SnapshotCacheBinding,
} from './projections'

const scopeId = 'scope/projection-test' as ScopeId
const principalId = 'principal/projection-test' as PrincipalId

function version(
  id: string,
  kind: AssertionVersion['kind'],
  payload: AssertionVersion['payload'],
  overrides: Partial<AssertionVersion> = {},
): AssertionVersion {
  return {
    schemaVersion: 1,
    id: id as AssertionVersion['id'],
    revision: 1,
    scopeId,
    subject: { kind: 'known', subjectId: 'subject/projection-test' as SubjectId },
    kind,
    payload,
    attribution: { actor: { kind: 'principal', principalId }, basis: 'explicit_user_statement' },
    polarity: 'positive',
    status: 'accepted',
    time: {
      validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null },
      receivedAt: '2026-09-22T00:00:00.000Z',
      interpretedAt: '2026-09-22T00:00:00.000Z',
      relation: 'ordinary',
    },
    evidence: [{ eventId: `event/${id}` as EventId, span: null, relation: 'supports' }],
    dependencies: [],
    producer: { name: 'stage-07-test', version: '1', model: null },
    ...overrides,
  }
}

function snapshot(assertions: readonly AssertionVersion[], activeTopic: { id: string; label: string } | null = null) {
  return buildWarmSnapshot({
    snapshotId: 'snapshot/test',
    projectionId: 'projection/test',
    scopeId,
    principalId,
    generation: 'warm/test-1',
    generatedAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-09-22T00:00:05.000Z',
    policyEpoch: 1,
    deletionEpoch: 0,
    coveredEventSequence: 4,
    coveredChangeWatermark: 4,
    assertions,
    activeTopic,
  })
}

function binding(overrides: Partial<SnapshotCacheBinding> = {}): SnapshotCacheBinding {
  return {
    principalId,
    scopeId,
    policyEpoch: 1,
    deletionEpoch: 0,
    leaseId: 'lease/projection-test',
    issuedAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-09-22T00:00:05.000Z',
    ...overrides,
  }
}

describe('warm profile and snapshot projections', () => {
  it('promotes only explicit profile material and separates active topic state', () => {
    const stable = version('assertion/stable', 'preference', { kind: 'preference', text: 'Concise informal replies', conditions: [], exceptions: [] })
    const active = version('assertion/active', 'preference', { kind: 'preference', text: 'Formal tone', conditions: [{ key: 'topic', operator: 'equals', value: 'investor-presentation' }], exceptions: [] })
    const decision = version('assertion/decision', 'decision', { kind: 'decision', topic: 'Investor presentation', decision: 'Use the concise deck', alternatives: ['Detailed deck'], reasons: ['Time'] })
    const inferred = version('assertion/inferred', 'preference', { kind: 'preference', text: 'Likes expensive hotels', conditions: [], exceptions: [] }, { attribution: { actor: { kind: 'assistant', assistantId: 'gideon' }, basis: 'inference' } })
    const result = snapshot([stable, active, decision, inferred], { id: 'investor-presentation', label: 'Investor Presentation' })

    expect(result.stableProfile.map((item) => item.text)).toEqual(['Concise informal replies'])
    expect(result.activeProfile.map((item) => item.text)).toEqual(['Formal tone', 'Investor presentation: Use the concise deck'])
    expect(result.stableProfile.some((item) => item.text.includes('expensive'))).toBe(false)
    expect(result.stableProfile.every((item) => item.sourceEventIds.length > 0)).toBe(true)
  })

  it('expires temporary constraints without decaying a still-valid stable preference', () => {
    const stable = version('assertion/morning', 'preference', { kind: 'preference', text: 'Morning meetings', conditions: [], exceptions: [] })
    const expired = version('assertion/evening', 'preference', { kind: 'preference', text: 'Evening meetings only today', conditions: [], exceptions: [] }, {
      time: {
        validTime: { from: '2026-09-21T00:00:00.000Z', until: '2026-09-22T00:00:00.000Z', precision: 'day', sourceTimeZone: 'Asia/Karachi' },
        receivedAt: '2026-09-21T00:00:00.000Z',
        interpretedAt: '2026-09-21T00:00:00.000Z',
        relation: 'temporary_exception',
      },
    })
    const result = snapshot([stable, expired])

    expect(result.stableProfile.map((item) => item.text)).toEqual(['Morning meetings'])
    expect(result.constraints).toEqual([])
  })

  it('applies a correction overlay immediately and removes the old bullet', () => {
    const original = version('assertion/correction', 'preference', { kind: 'preference', text: 'Quiet venues', conditions: [], exceptions: [] })
    const warm = snapshot([original])
    const corrected = { ...original, revision: 12, payload: { kind: 'preference' as const, text: 'Quiet and accessible venues', conditions: [], exceptions: [] }, attribution: { ...original.attribution, basis: 'user_correction' as const }, producer: { ...original.producer, version: '2' } }
    const overlay: ProjectionChange = {
      scopeId,
      changeWatermark: `watermark/${scopeId}/12`,
      operation: 'correct',
      changeKind: 'corrected',
      assertion: { assertionId: corrected.id, revision: corrected.revision },
      version: corrected,
    }
    const updated = applyAcceptedCorrectionOverlays(warm, [overlay], '2026-09-22T00:00:01.000Z')

    expect(updated.stableProfile.map((item) => item.text)).toEqual(['Quiet and accessible venues'])
    expect(updated.stableProfile[0]?.assertion.revision).toBe(12)
    expect(updated.stableProfile.some((item) => item.text === 'Quiet venues')).toBe(false)
    expect(updated.coverage.changeWatermarkTo).toBe(12)
    expect(applyAcceptedCorrectionOverlays(updated, [{ ...overlay, changeWatermark: `watermark/${scopeId}/11`, version: original }], '2026-09-22T00:00:02.000Z')).toEqual(updated)
  })

  it('does not promote a generated inference or duplicate summary as evidence', () => {
    const explicit = version('assertion/explicit', 'preference', { kind: 'preference', text: 'Quiet venues', conditions: [], exceptions: [] })
    const duplicateSummary = version('assertion/summary', 'preference', { kind: 'preference', text: 'Quiet venues', conditions: [], exceptions: [] }, {
      attribution: { actor: { kind: 'assistant', assistantId: 'gideon' }, basis: 'inference' },
      evidence: [{ eventId: explicit.evidence[0].eventId, span: null, relation: 'derived_from' }],
    })
    const result = snapshot([explicit, duplicateSummary])

    expect(result.stableProfile).toHaveLength(1)
    expect(result.stableProfile[0]?.sourceEventIds).toEqual([explicit.evidence[0].eventId])
  })

  it('keeps a snapshot bounded and rejects malformed cached payloads', () => {
    const many = Array.from({ length: 80 }, (_, index) => version(`assertion/${index}`, 'preference', { kind: 'preference', text: `Preference ${index}`, conditions: [], exceptions: [] }))
    const result = snapshot(many)
    expect(serializedWarmSnapshotBytes(result)).toBeLessThanOrEqual(131_072)
    expect(parseWarmSnapshot(JSON.parse(JSON.stringify(result))).ok).toBe(true)
    expect(parseWarmSnapshot({ schemaVersion: 1, stableProfile: [] }).ok).toBe(false)
    const malformed = JSON.parse(JSON.stringify(result)) as { stableProfile: Array<Record<string, unknown>> }
    if (malformed.stableProfile[0]) malformed.stableProfile[0].basis = 'inference'
    expect(parseWarmSnapshot(malformed).ok).toBe(false)
  })

  it('accepts learned and promoted changes in a cached snapshot, as the change feed records them', () => {
    const learned = version('assertion/learned-hiking', 'preference', { kind: 'preference', text: 'Enjoys hiking on weekends', conditions: [], exceptions: [] })
    const cached = JSON.parse(JSON.stringify(snapshot([learned]))) as { recentAcceptedChanges: unknown[] }
    for (const [index, changeKind] of (['learned', 'promoted'] as const).entries()) {
      cached.recentAcceptedChanges.push({ scopeId, changeWatermark: `watermark/${scopeId}/${20 + index}`, operation: 'remember', changeKind, assertion: { assertionId: learned.id, revision: learned.revision }, version: learned })
    }
    expect(parseWarmSnapshot(cached)).toMatchObject({ ok: true })
    cached.recentAcceptedChanges.push({ scopeId, changeWatermark: `watermark/${scopeId}/30`, operation: 'remember', changeKind: 'invented', assertion: { assertionId: learned.id, revision: learned.revision }, version: learned })
    expect(parseWarmSnapshot(cached).ok).toBe(false)
  })

  it('marks capped input coverage incomplete and retains references only for composed inputs', () => {
    const many = Array.from({ length: MAX_INPUT_VERSIONS + 1 }, (_, index) => version(`assertion/cap-${index}`, 'preference', { kind: 'preference', text: `Preference ${index}`, conditions: [], exceptions: [] }))
    const result = snapshot(many)

    expect(result.coveredAssertionRefs).toHaveLength(MAX_INPUT_VERSIONS)
    expect(result.coverage.complete).toBe(false)
    expect(result.inspector.missingInputs).toContain('assertions:input-cap')
    expect(serializedWarmSnapshotBytes(result)).toBeLessThanOrEqual(131_072)
  })

  it('measures bounded maximum-input composition separately from database refresh', () => {
    const many = Array.from({ length: MAX_INPUT_VERSIONS }, (_, index) => version(
      `assertion/load-${index}`,
      'preference',
      { kind: 'preference', text: `Preference ${index}: ${'bounded synthetic profile material '.repeat(12)}`, conditions: [], exceptions: [] },
    ))
    const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc
    const compositionDurations: number[] = []
    const retainedHeapDeltas: number[] = []
    let serializedBytes = 0
    for (let round = 0; round < 5; round += 1) {
      collectGarbage?.()
      const heapBefore = process.memoryUsage().heapUsed
      const startedAt = performance.now()
      const result = snapshot(many)
      compositionDurations.push(performance.now() - startedAt)
      serializedBytes = serializedWarmSnapshotBytes(result)
      collectGarbage?.()
      retainedHeapDeltas.push(process.memoryUsage().heapUsed - heapBefore)
      expect(result.coveredAssertionRefs).toHaveLength(MAX_INPUT_VERSIONS)
      expect(serializedBytes).toBeLessThanOrEqual(131_072)
    }
    const sortedDurations = [...compositionDurations].sort((left, right) => left - right)
    const sortedHeapDeltas = [...retainedHeapDeltas].sort((left, right) => left - right)
    console.info('[memory-projection-composition]', JSON.stringify({
      assertions: many.length,
      rounds: compositionDurations.length,
      medianCompositionMs: Number(sortedDurations[Math.floor(sortedDurations.length / 2)]?.toFixed(2)),
      maxCompositionMs: Number(Math.max(...compositionDurations).toFixed(2)),
      gcAvailable: Boolean(collectGarbage),
      medianRetainedHeapDeltaBytes: collectGarbage ? sortedHeapDeltas[Math.floor(sortedHeapDeltas.length / 2)] : null,
      serializedBytes,
    }))
  })
})

describe('private warm cache and telemetry', () => {
  it('binds cache reads to identity/epochs, ignores out-of-order writes, and expires at five seconds', () => {
    const cache = new WarmSnapshotCache()
    const current = snapshot([version('assertion/cache', 'preference', { kind: 'preference', text: 'Use short answers', conditions: [], exceptions: [] })])
    expect(cache.put(current, binding())).toBe(true)
    expect(cache.read(binding(), '2026-09-22T00:00:01.000Z')).toMatchObject({ status: 'hit' })
    expect(cache.put({ ...current, coverage: { ...current.coverage, changeWatermarkTo: 2 } }, binding({ expiresAt: '2026-09-22T00:00:04.000Z' }))).toBe(false)
    expect(cache.read(binding({ policyEpoch: 2 }), '2026-09-22T00:00:01.000Z')).toMatchObject({ status: 'binding_mismatch' })
    expect(cache.read(binding(), '2026-09-22T00:00:05.000Z')).toMatchObject({ status: 'expired', snapshot: null })
    expect(MAX_PRIVATE_CACHE_LEASE_MS).toBe(5_000)
  })

  it('does not replace private state with an unavailable or empty authority result and emits invalidation', () => {
    const cache = new WarmSnapshotCache()
    const current = snapshot([version('assertion/authority', 'preference', { kind: 'preference', text: 'Keep source lineage', conditions: [], exceptions: [] })])
    const events: string[] = []
    cache.subscribe((event) => events.push(event.reason))
    expect(cache.put(current, binding())).toBe(true)
    expect(cache.acceptAuthorityResult({ status: 'unavailable', snapshot: null, reason: 'database_down' }, binding())).toBe(false)
    expect(cache.read(binding(), '2026-09-22T00:00:01.000Z')).toMatchObject({ status: 'hit' })
    cache.invalidate({ scopeId, principalId: binding().principalId, policyEpoch: 1, deletionEpoch: 0, reason: 'correction', changeWatermark: 12 })
    expect(cache.read(binding(), '2026-09-22T00:00:01.000Z')).toMatchObject({ status: 'cold' })
    expect(events).toEqual(['correction'])
  })

  it('requires the exact private lease for reads and prevents renewal after expiry', () => {
    const cache = new WarmSnapshotCache()
    const current = snapshot([version('assertion/lease-binding', 'preference', { kind: 'preference', text: 'Lease bound', conditions: [], exceptions: [] })])
    expect(cache.put(current, binding())).toBe(true)
    expect(cache.read(binding({ leaseId: 'lease/other' }), '2026-09-22T00:00:01.000Z')).toMatchObject({ status: 'binding_mismatch' })
    expect(cache.renew(binding(), '2026-09-22T00:00:04.000Z', '2026-09-22T00:00:09.000Z')).toBe(true)
    expect(cache.read(binding(), '2026-09-22T00:00:04.500Z')).toMatchObject({ status: 'binding_mismatch' })
    const renewed = binding({ issuedAt: '2026-09-22T00:00:04.000Z', expiresAt: '2026-09-22T00:00:09.000Z' })
    expect(cache.read(renewed, '2026-09-22T00:00:04.500Z')).toMatchObject({ status: 'hit' })
    expect(cache.renew(renewed, '2026-09-22T00:00:09.000Z', '2026-09-22T00:00:14.000Z')).toBe(false)
  })

  it('buffers retrieved, included, cited, and independently useful telemetry outside canonical state', () => {
    const telemetry = new SnapshotTelemetryBuffer()
    expect(telemetry.record({ itemId: 'assertion/1', observedAt: '2026-09-22T00:00:00.000Z', retrieved: true, included: true })).toBe(true)
    expect(telemetry.record({ itemId: 'assertion/1', observedAt: '2026-09-22T00:00:01.000Z', cited: true, independentlyUseful: true })).toBe(true)
    expect(telemetry.drain()).toEqual([{
      itemId: 'assertion/1', retrieved: 1, included: 1, cited: 1, independentlyUseful: 1,
      firstObservedAt: '2026-09-22T00:00:00.000Z', lastObservedAt: '2026-09-22T00:00:01.000Z',
    }])
    expect(telemetry.size).toBe(0)
  })
})
