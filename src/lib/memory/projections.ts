/**
 * Edge-safe read projections for conversational memory.
 *
 * These objects are replaceable views over accepted assertion versions.  They
 * deliberately contain exact source references and never become a canonical
 * writer.  Node adapters persist them; edge clients may carry them privately
 * only while an authenticated, short-lived lease is valid.
 */

import { parseAssertionVersion } from './contracts'
import type {
  AssertionVersion,
  Condition,
  EventId,
  ExactVersionRef,
  PrincipalId,
  ScopeId,
  SourceBasis,
} from './contracts'

export const PROJECTION_SCHEMA_VERSION = 1 as const
export const MAX_PROFILE_BULLETS = 32
export const MAX_ACTIVE_PROFILE_BULLETS = 16
export const MAX_CONSTRAINT_ENTRIES = 48
export const MAX_EPISODE_HEADS = 16
export const MAX_RECENT_ACCEPTED_CHANGES = 32
export const MAX_LEXICAL_TERMS = 256
export const MAX_SOURCE_EVENT_REFS = 8
export const MAX_INPUT_VERSIONS = 256
export const MAX_SNAPSHOT_BYTES = 128 * 1024
export const MAX_PRIVATE_CACHE_LEASE_MS = 5_000
export const MAX_TELEMETRY_ITEMS = 256

export type ProjectionFreshness = 'fresh' | 'stale' | 'expired'

export interface ProfileBullet {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION
  bulletId: string
  assertion: ExactVersionRef
  scopeId: ScopeId
  kind: 'preference' | 'decision'
  text: string
  topicLabel: string | null
  placement: 'stable' | 'active_topic'
  basis: SourceBasis
  reason: 'explicit_user_statement' | 'user_correction'
  sourceEventIds: readonly EventId[]
  conditions: readonly Condition[]
  validUntil: string | null
}

export interface ConstraintIndexEntry {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION
  assertion: ExactVersionRef
  scopeId: ScopeId
  kind: 'constraint' | 'temporary_exception'
  text: string
  conditions: readonly Condition[]
  sourceEventIds: readonly EventId[]
  basis: SourceBasis
  validFrom: string | null
  validUntil: string | null
  active: boolean
}

export interface EpisodeHead {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION
  assertion: ExactVersionRef
  scopeId: ScopeId
  topic: string
  sourceWatermark: string
  decisions: readonly string[]
  alternatives: readonly string[]
  reasons: readonly string[]
  openItems: readonly string[]
  meaningfulOutcomes: readonly string[]
  sourceEventIds: readonly EventId[]
}

export interface LexicalTermFrequency {
  term: string
  frequency: number
}

export interface LexicalIndex {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION
  documentCount: number
  terms: readonly LexicalTermFrequency[]
}

export interface ProjectionChange {
  scopeId: ScopeId
  changeWatermark: string
  operation: 'remember' | 'correct'
  /** Every change kind the change feed records; learning (Stage 10) adds the last three. */
  changeKind: 'remembered' | 'corrected' | 'temporary_exception' | 'learned' | 'promoted' | 'retired'
  assertion: ExactVersionRef
  version: AssertionVersion
}

export interface ProjectionCoverage {
  eventSequenceFrom: number
  eventSequenceTo: number
  changeWatermarkFrom: number
  changeWatermarkTo: number
  complete: boolean
  resetRequired: boolean
}

export interface ProjectionInspector {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION
  projectionId: string
  generation: string
  ageMs: number
  inputCoverage: ProjectionCoverage
  dependencies: {
    assertionVersions: readonly string[]
    eventIds: readonly EventId[]
    policyEpoch: number
    deletionEpoch: number
  }
  missingInputs: readonly string[]
  conflicts: readonly string[]
  bulletReasons: readonly string[]
}

export interface WarmSnapshot {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION
  snapshotId: string
  scopeId: ScopeId
  principalId: PrincipalId
  policyEpoch: number
  deletionEpoch: number
  generatedAt: string
  expiresAt: string | null
  freshness: ProjectionFreshness
  activeTopic: { id: string; label: string } | null
  stableProfile: readonly ProfileBullet[]
  activeProfile: readonly ProfileBullet[]
  activeEpisodeHeads: readonly EpisodeHead[]
  constraints: readonly ConstraintIndexEntry[]
  lexical: LexicalIndex
  recentAcceptedChanges: readonly ProjectionChange[]
  coveredAssertionRefs: readonly ExactVersionRef[]
  coverage: ProjectionCoverage
  inspector: ProjectionInspector
}

export interface WarmSnapshotBuildInput {
  snapshotId: string
  projectionId: string
  scopeId: ScopeId
  principalId: PrincipalId
  generation: string
  generatedAt: string
  expiresAt: string | null
  policyEpoch: number
  deletionEpoch: number
  coveredEventSequence: number
  coveredChangeWatermark: number
  assertions: readonly AssertionVersion[]
  recentAcceptedChanges?: readonly ProjectionChange[]
  activeTopic?: { id: string; label: string } | null
  missingInputs?: readonly string[]
  eventSequenceFrom?: number
  changeWatermarkFrom?: number
}

export interface SnapshotCacheBinding {
  principalId: PrincipalId
  scopeId: ScopeId
  policyEpoch: number
  deletionEpoch: number
  leaseId: string
  issuedAt: string
  expiresAt: string
}

export type SnapshotCacheRead =
  | { status: 'hit'; snapshot: WarmSnapshot }
  | { status: 'cold' | 'expired' | 'binding_mismatch' | 'invalidated' | 'unavailable'; snapshot: null; reason: string }

export interface ProjectionInvalidation {
  scopeId: ScopeId
  principalId: PrincipalId
  policyEpoch: number
  deletionEpoch: number
  reason: 'accepted_change' | 'correction' | 'deletion' | 'grant_revocation' | 'lease_expired' | 'authority_unavailable'
  changeWatermark: number
}

export interface SnapshotAuthorityResult {
  status: 'available' | 'unavailable'
  snapshot: WarmSnapshot | null
  reason?: string
}

export interface SnapshotTelemetryEvent {
  itemId: string
  observedAt: string
  retrieved?: boolean
  included?: boolean
  cited?: boolean
  independentlyUseful?: boolean
}

export interface SnapshotTelemetrySummary {
  itemId: string
  retrieved: number
  included: number
  cited: number
  independentlyUseful: number
  firstObservedAt: string
  lastObservedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isExactRef(value: unknown): value is ExactVersionRef {
  return isRecord(value)
    && typeof value.assertionId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.assertionId)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) > 0
}

function isConditionArray(value: unknown): value is Condition[] {
  return Array.isArray(value) && value.length <= 12 && value.every((condition) => {
    if (!isRecord(condition) || typeof condition.key !== 'string' || !condition.key.trim()) return false
    if (!['equals', 'not_equals', 'contains', 'in'].includes(String(condition.operator))) return false
    const kind = typeof condition.value
    return condition.value === null || kind === 'string' || kind === 'number' || kind === 'boolean' || Array.isArray(condition.value) || isRecord(condition.value)
  })
}

function isProfileBullet(value: unknown, scopeId: string, refs: Set<string>): value is ProfileBullet {
  if (!isRecord(value) || value.schemaVersion !== PROJECTION_SCHEMA_VERSION || !isExactRef(value.assertion)) return false
  if (value.scopeId !== scopeId || !refs.has(`${value.assertion.assertionId}/${value.assertion.revision}`)) return false
  if (typeof value.bulletId !== 'string' || typeof value.text !== 'string' || value.text.length > 4_096) return false
  if (value.kind !== 'preference' && value.kind !== 'decision') return false
  if (value.placement !== 'stable' && value.placement !== 'active_topic') return false
  if (value.basis !== 'explicit_user_statement' && value.basis !== 'user_correction') return false
  if (value.reason !== (value.basis === 'user_correction' ? 'user_correction' : 'explicit_user_statement')) return false
  if (value.topicLabel !== null && typeof value.topicLabel !== 'string') return false
  if (value.validUntil !== null && (typeof value.validUntil !== 'string' || Number.isNaN(Date.parse(value.validUntil)))) return false
  return isStringArray(value.sourceEventIds) && value.sourceEventIds.length <= MAX_SOURCE_EVENT_REFS && isConditionArray(value.conditions)
}

function isConstraintEntry(value: unknown, scopeId: string, refs: Set<string>): value is ConstraintIndexEntry {
  if (!isRecord(value) || value.schemaVersion !== PROJECTION_SCHEMA_VERSION || !isExactRef(value.assertion)) return false
  if (value.scopeId !== scopeId || !refs.has(`${value.assertion.assertionId}/${value.assertion.revision}`)) return false
  if (value.kind !== 'constraint' && value.kind !== 'temporary_exception') return false
  if (typeof value.text !== 'string' || value.text.length > 4_096 || typeof value.active !== 'boolean') return false
  if (!['explicit_user_statement', 'user_correction', 'verified_tool_result', 'inference', 'imported_legacy', 'attributed_third_party', 'assistant_delivery_observation'].includes(String(value.basis))) return false
  if (value.validFrom !== null && (typeof value.validFrom !== 'string' || Number.isNaN(Date.parse(value.validFrom)))) return false
  if (value.validUntil !== null && (typeof value.validUntil !== 'string' || Number.isNaN(Date.parse(value.validUntil)))) return false
  return isStringArray(value.sourceEventIds) && value.sourceEventIds.length <= MAX_SOURCE_EVENT_REFS && isConditionArray(value.conditions)
}

function isEpisodeHead(value: unknown, scopeId: string, refs: Set<string>): value is EpisodeHead {
  if (!isRecord(value) || value.schemaVersion !== PROJECTION_SCHEMA_VERSION || !isExactRef(value.assertion)) return false
  if (value.scopeId !== scopeId || !refs.has(`${value.assertion.assertionId}/${value.assertion.revision}`)) return false
  return typeof value.topic === 'string'
    && typeof value.sourceWatermark === 'string'
    && isStringArray(value.decisions) && value.decisions.length <= 16
    && isStringArray(value.alternatives) && value.alternatives.length <= 16
    && isStringArray(value.reasons) && value.reasons.length <= 16
    && isStringArray(value.openItems) && value.openItems.length <= 16
    && isStringArray(value.meaningfulOutcomes) && value.meaningfulOutcomes.length <= 16
    && isStringArray(value.sourceEventIds) && value.sourceEventIds.length <= MAX_SOURCE_EVENT_REFS
}

function isProjectionChange(value: unknown, scopeId: string): value is ProjectionChange {
  if (!isRecord(value) || value.scopeId !== scopeId || typeof value.changeWatermark !== 'string') return false
  if (safeWatermark(value.changeWatermark) < 1 || !value.changeWatermark.includes(`/${scopeId}/`)) return false
  if (value.operation !== 'remember' && value.operation !== 'correct') return false
  if (!['remembered', 'corrected', 'temporary_exception', 'learned', 'promoted', 'retired'].includes(value.changeKind as string)) return false
  if (!isExactRef(value.assertion)) return false
  const parsed = parseAssertionVersion(value.version)
  return parsed.ok
    && parsed.value.scopeId === scopeId
    && parsed.value.id === value.assertion.assertionId
    && parsed.value.revision === value.assertion.revision
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

function normalizedKey(value: string): string {
  return normalizeText(value).toLocaleLowerCase('en-US')
}

function safeWatermark(value: string): number {
  const match = /(?:^|\/)(\d+)$/.exec(value)
  if (!match) return 0
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function sourceEventIds(version: AssertionVersion): readonly EventId[] {
  return [...new Set(version.evidence.map((edge) => edge.eventId))].slice(0, MAX_SOURCE_EVENT_REFS)
}

function conditionsFor(version: AssertionVersion): readonly Condition[] {
  if (version.payload.kind === 'preference' || version.payload.kind === 'constraint') return version.payload.conditions
  return []
}

function topicLabelFor(version: AssertionVersion): string | null {
  if (version.payload.kind === 'decision') return normalizeText(version.payload.topic) || null
  if (version.payload.kind !== 'preference' && version.payload.kind !== 'constraint') return null
  const topic = version.payload.conditions.find((condition) => {
    const key = normalizedKey(condition.key)
    return key === 'topic' || key === 'project' || key === 'workstream'
  })
  return topic && typeof topic.value === 'string' ? normalizeText(topic.value) || null : null
}

function topicMatches(topic: string | null, activeTopic: { id: string; label: string } | null): boolean {
  if (!topic || !activeTopic) return false
  const candidate = normalizedKey(topic)
  return candidate === normalizedKey(activeTopic.id) || candidate === normalizedKey(activeTopic.label)
}

function profileText(version: AssertionVersion): string | null {
  if (version.payload.kind === 'preference') return normalizeText(version.payload.text) || null
  if (version.payload.kind === 'decision') {
    const decision = normalizeText(version.payload.decision)
    if (!decision) return null
    const topic = normalizeText(version.payload.topic)
    return topic ? `${topic}: ${decision}` : decision
  }
  return null
}

function conditionKey(conditions: readonly Condition[]): string {
  return JSON.stringify([...conditions].map((condition) => ({
    key: condition.key,
    operator: condition.operator,
    value: condition.value,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
}

function profileBulletFor(version: AssertionVersion, activeTopic: { id: string; label: string } | null): ProfileBullet | null {
  if (version.status !== 'accepted' || (version.kind !== 'preference' && version.kind !== 'decision')) return null
  if (version.attribution.basis !== 'explicit_user_statement' && version.attribution.basis !== 'user_correction') return null
  if (version.time.relation === 'temporary_exception') return null
  const text = profileText(version)
  if (!text) return null
  const topicLabel = topicLabelFor(version)
  const placement = topicLabel ? (topicMatches(topicLabel, activeTopic) ? 'active_topic' : null) : 'stable'
  if (!placement) return null
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    bulletId: `profile/${version.id}/${version.revision}`,
    assertion: { assertionId: version.id, revision: version.revision },
    scopeId: version.scopeId,
    kind: version.kind,
    text,
    topicLabel,
    placement,
    basis: version.attribution.basis,
    reason: version.attribution.basis === 'user_correction' ? 'user_correction' : 'explicit_user_statement',
    sourceEventIds: sourceEventIds(version),
    conditions: conditionsFor(version),
    validUntil: version.time.validTime.until,
  }
}

function constraintFor(version: AssertionVersion, now: string): ConstraintIndexEntry | null {
  if (version.status !== 'accepted') return null
  const isTemporary = version.time.relation === 'temporary_exception'
  if (version.kind !== 'constraint' && !(version.kind === 'preference' && isTemporary)) return null
  const until = version.time.validTime.until
  if (until && Date.parse(until) <= Date.parse(now)) return null
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    assertion: { assertionId: version.id, revision: version.revision },
    scopeId: version.scopeId,
    kind: isTemporary ? 'temporary_exception' : 'constraint',
    text: normalizeText(version.payload.kind === 'constraint' || version.payload.kind === 'preference' ? version.payload.text : ''),
    conditions: conditionsFor(version),
    sourceEventIds: sourceEventIds(version),
    basis: version.attribution.basis,
    validFrom: version.time.validTime.from,
    validUntil: until,
    active: true,
  }
}

function episodeFor(version: AssertionVersion): EpisodeHead | null {
  if (version.status !== 'accepted' || version.kind !== 'episode_checkpoint' || version.payload.kind !== 'episode_checkpoint') return null
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    assertion: { assertionId: version.id, revision: version.revision },
    scopeId: version.scopeId,
    topic: normalizeText(version.payload.topic),
    sourceWatermark: version.payload.sourceWatermark,
    decisions: version.payload.decisions.slice(0, 16),
    alternatives: version.payload.alternatives.slice(0, 16),
    reasons: version.payload.reasons.slice(0, 16),
    openItems: version.payload.openItems.slice(0, 16),
    meaningfulOutcomes: version.payload.meaningfulOutcomes.slice(0, 16),
    sourceEventIds: sourceEventIds(version),
  }
}

function currentAssertions(assertions: readonly AssertionVersion[]): AssertionVersion[] {
  const latest = new Map<string, AssertionVersion>()
  for (const version of assertions) {
    if (version.status !== 'accepted') continue
    const current = latest.get(version.id)
    if (!current || version.revision > current.revision) latest.set(version.id, version)
  }
  return [...latest.values()].sort((left, right) => {
    const received = Date.parse(right.time.receivedAt) - Date.parse(left.time.receivedAt)
    return received || right.revision - left.revision || left.id.localeCompare(right.id)
  })
}

function uniqueRefs(assertions: readonly AssertionVersion[]): readonly ExactVersionRef[] {
  const refs = assertions.map((version) => ({ assertionId: version.id, revision: version.revision }))
  return refs.slice(0, MAX_INPUT_VERSIONS)
}

function lexicalDocuments(snapshotParts: readonly string[]): LexicalIndex {
  const frequencies = new Map<string, number>()
  let documentCount = 0
  for (const part of snapshotParts) {
    const text = normalizeText(part)
    if (!text) continue
    documentCount += 1
    const tokens = text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []
    for (const token of new Set(tokens)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }
  const terms = [...frequencies.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_LEXICAL_TERMS)
    .map(([term, frequency]) => ({ term, frequency }))
  return { schemaVersion: PROJECTION_SCHEMA_VERSION, documentCount, terms }
}

function eventIdsFor(assertions: readonly AssertionVersion[]): readonly EventId[] {
  return [...new Set(assertions.flatMap((version) => version.evidence.map((edge) => edge.eventId)))].slice(0, MAX_SOURCE_EVENT_REFS * 8)
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function trimSnapshot(snapshot: WarmSnapshot): WarmSnapshot {
  let current = snapshot
  const missing = [...snapshot.inspector.missingInputs]
  const trim = (label: string, transform: (value: WarmSnapshot) => WarmSnapshot): void => {
    const next = transform(current)
    if (next !== current) {
      current = next
      missing.push(label)
    }
  }
  while (byteLength(current) > MAX_SNAPSHOT_BYTES) {
    const before = current
    if (current.recentAcceptedChanges.length > 0) {
      trim('recentAcceptedChanges', (value) => ({ ...value, recentAcceptedChanges: value.recentAcceptedChanges.slice(0, -1) }))
    } else if (current.lexical.terms.length > 0) {
      trim('lexical.terms', (value) => ({ ...value, lexical: { ...value.lexical, terms: value.lexical.terms.slice(0, -1) } }))
    } else if (current.activeEpisodeHeads.length > 0) {
      trim('activeEpisodeHeads', (value) => ({ ...value, activeEpisodeHeads: value.activeEpisodeHeads.slice(0, -1) }))
    } else if (current.activeProfile.length > 0) {
      trim('activeProfile', (value) => ({ ...value, activeProfile: value.activeProfile.slice(0, -1) }))
    } else if (current.stableProfile.length > 0) {
      trim('stableProfile', (value) => ({ ...value, stableProfile: value.stableProfile.slice(0, -1) }))
    } else if (current.constraints.length > 0) {
      trim('constraints', (value) => ({ ...value, constraints: value.constraints.slice(0, -1) }))
    } else {
      break
    }
    if (before === current) break
  }
  if (missing.length === snapshot.inspector.missingInputs.length) return current
  const coverage = { ...current.coverage, complete: false }
  return {
    ...current,
    coverage,
    inspector: {
      ...current.inspector,
      inputCoverage: coverage,
      missingInputs: [...new Set(missing)],
    },
  }
}

function inspectorFor(
  input: WarmSnapshotBuildInput,
  refs: readonly ExactVersionRef[],
  eventIds: readonly EventId[],
  bulletReasons: readonly string[],
): ProjectionInspector {
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    projectionId: input.projectionId,
    generation: input.generation,
    ageMs: 0,
    inputCoverage: {
      eventSequenceFrom: input.eventSequenceFrom ?? 0,
      eventSequenceTo: input.coveredEventSequence,
      changeWatermarkFrom: input.changeWatermarkFrom ?? 0,
      changeWatermarkTo: input.coveredChangeWatermark,
      complete: !(input.missingInputs?.length),
      resetRequired: false,
    },
    dependencies: {
      assertionVersions: refs.map((ref) => `revision/${ref.assertionId}/${ref.revision}`),
      eventIds,
      policyEpoch: input.policyEpoch,
      deletionEpoch: input.deletionEpoch,
    },
    missingInputs: [...(input.missingInputs ?? [])],
    conflicts: [],
    bulletReasons,
  }
}

export function buildWarmSnapshot(input: WarmSnapshotBuildInput): WarmSnapshot {
  const allAssertions = currentAssertions(input.assertions)
  const assertions = allAssertions.slice(0, MAX_INPUT_VERSIONS)
  const missingInputs = [...(input.missingInputs ?? [])]
  if (allAssertions.length > MAX_INPUT_VERSIONS) missingInputs.push('assertions:input-cap')
  const activeTopic = input.activeTopic ?? null
  const stableProfile: ProfileBullet[] = []
  const activeProfile: ProfileBullet[] = []
  const constraints: ConstraintIndexEntry[] = []
  const activeEpisodeHeads: EpisodeHead[] = []
  const parts: string[] = []
  const stableProfileKeys = new Set<string>()
  const activeProfileKeys = new Set<string>()

  for (const version of assertions) {
    const bullet = profileBulletFor(version, activeTopic)
    if (bullet) {
      const target = bullet.placement === 'active_topic' ? activeProfile : stableProfile
      const keys = bullet.placement === 'active_topic' ? activeProfileKeys : stableProfileKeys
      const key = `${bullet.kind}/${normalizedKey(bullet.text)}/${conditionKey(bullet.conditions)}`
      if (!keys.has(key)) {
        target.push(bullet)
        keys.add(key)
      }
      parts.push(bullet.text)
    }
    const constraint = constraintFor(version, input.generatedAt)
    if (constraint && !constraints.some((candidate) => candidate.assertion.assertionId === constraint.assertion.assertionId)) {
      constraints.push(constraint)
      parts.push(constraint.text)
    }
    const episode = episodeFor(version)
    if (episode && !activeEpisodeHeads.some((candidate) => candidate.assertion.assertionId === episode.assertion.assertionId)) {
      activeEpisodeHeads.push(episode)
      parts.push(episode.topic, ...episode.decisions, ...episode.openItems)
    }
  }

  stableProfile.splice(MAX_PROFILE_BULLETS)
  activeProfile.splice(MAX_ACTIVE_PROFILE_BULLETS)
  constraints.splice(MAX_CONSTRAINT_ENTRIES)
  activeEpisodeHeads.splice(MAX_EPISODE_HEADS)
  const recentAcceptedChanges = [...(input.recentAcceptedChanges ?? [])]
    .filter((change) => change.scopeId === input.scopeId)
    .sort((left, right) => safeWatermark(right.changeWatermark) - safeWatermark(left.changeWatermark))
    .slice(0, MAX_RECENT_ACCEPTED_CHANGES)
  parts.push(...recentAcceptedChanges.flatMap((change) => {
    const text = profileText(change.version)
    return text ? [text] : []
  }))
  const refs = uniqueRefs(assertions)
  const coverage: ProjectionCoverage = {
    eventSequenceFrom: input.eventSequenceFrom ?? 0,
    eventSequenceTo: input.coveredEventSequence,
    changeWatermarkFrom: input.changeWatermarkFrom ?? 0,
    changeWatermarkTo: input.coveredChangeWatermark,
    complete: missingInputs.length === 0,
    resetRequired: false,
  }
  const snapshot: WarmSnapshot = {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    snapshotId: input.snapshotId,
    scopeId: input.scopeId,
    principalId: input.principalId,
    policyEpoch: input.policyEpoch,
    deletionEpoch: input.deletionEpoch,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    freshness: 'fresh',
    activeTopic,
    stableProfile,
    activeProfile,
    activeEpisodeHeads,
    constraints,
    lexical: lexicalDocuments(parts),
    recentAcceptedChanges,
    coveredAssertionRefs: refs,
    coverage,
    inspector: inspectorFor({ ...input, missingInputs }, refs, eventIdsFor(assertions), [
      ...stableProfile.map((bullet) => `${bullet.kind}:${bullet.reason}`),
      ...activeProfile.map((bullet) => `active:${bullet.kind}:${bullet.reason}`),
      ...constraints.map((constraint) => `${constraint.kind}:${constraint.basis}`),
    ]),
  }
  return trimSnapshot(snapshot)
}

function removeAssertion<T extends { assertion: ExactVersionRef }>(items: readonly T[], assertionId: string): T[] {
  return items.filter((item) => item.assertion.assertionId !== assertionId)
}

function snapshotInput(input: WarmSnapshot, assertions: readonly AssertionVersion[], now: string): WarmSnapshotBuildInput {
  return {
    snapshotId: input.snapshotId,
    projectionId: input.inspector.projectionId,
    scopeId: input.scopeId,
    principalId: input.principalId,
    generation: input.inspector.generation,
    generatedAt: now,
    expiresAt: input.expiresAt,
    policyEpoch: input.policyEpoch,
    deletionEpoch: input.deletionEpoch,
    coveredEventSequence: input.coverage.eventSequenceTo,
    coveredChangeWatermark: input.coverage.changeWatermarkTo,
    assertions,
    recentAcceptedChanges: input.recentAcceptedChanges,
    activeTopic: input.activeTopic,
    eventSequenceFrom: input.coverage.eventSequenceFrom,
    changeWatermarkFrom: input.coverage.changeWatermarkFrom,
    missingInputs: input.inspector.missingInputs,
  }
}

/**
 * Apply accepted changes ahead of a warm snapshot.  The caller must obtain
 * changes through an authorized scope-bound feed; the function does not grant
 * identity or disclosure authority on its own.
 */
export function applyAcceptedCorrectionOverlays(
  snapshot: WarmSnapshot,
  overlays: readonly ProjectionChange[],
  now: string,
): WarmSnapshot {
  const ordered = overlays
    .filter((overlay) => overlay.scopeId === snapshot.scopeId && safeWatermark(overlay.changeWatermark) > snapshot.coverage.changeWatermarkTo)
    .sort((left, right) => safeWatermark(left.changeWatermark) - safeWatermark(right.changeWatermark))
  if (!ordered.length) return snapshot

  const versions = new Map(snapshot.coveredAssertionRefs.map((ref) => [`${ref.assertionId}/${ref.revision}`, ref]))
  const pseudoAssertions: AssertionVersion[] = []
  for (const overlay of ordered) {
    for (const ref of [...versions.values()]) {
      if (ref.assertionId === overlay.assertion.assertionId) versions.delete(`${ref.assertionId}/${ref.revision}`)
    }
    if (overlay.version.status === 'accepted') {
      versions.set(`${overlay.version.id}/${overlay.version.revision}`, { assertionId: overlay.version.id, revision: overlay.version.revision })
      pseudoAssertions.push(overlay.version)
    }
  }

  let next = snapshot
  for (const overlay of ordered) {
    const version = overlay.version
    next = {
      ...next,
      stableProfile: removeAssertion(next.stableProfile, version.id),
      activeProfile: removeAssertion(next.activeProfile, version.id),
      constraints: removeAssertion(next.constraints, version.id),
      activeEpisodeHeads: removeAssertion(next.activeEpisodeHeads, version.id),
      recentAcceptedChanges: [overlay, ...next.recentAcceptedChanges.filter((change) => change.changeWatermark !== overlay.changeWatermark)].slice(0, MAX_RECENT_ACCEPTED_CHANGES),
      coverage: {
        ...next.coverage,
        changeWatermarkTo: Math.max(next.coverage.changeWatermarkTo, safeWatermark(overlay.changeWatermark)),
      },
      inspector: {
        ...next.inspector,
        generation: `${next.inspector.generation}+overlay/${safeWatermark(overlay.changeWatermark)}`,
      },
    }
  }

  if (pseudoAssertions.length) {
    const rebuilt = buildWarmSnapshot(snapshotInput(next, pseudoAssertions, now))
    next = {
      ...next,
      stableProfile: [...next.stableProfile, ...rebuilt.stableProfile].slice(0, MAX_PROFILE_BULLETS),
      activeProfile: [...next.activeProfile, ...rebuilt.activeProfile].slice(0, MAX_ACTIVE_PROFILE_BULLETS),
      constraints: [...next.constraints, ...rebuilt.constraints].slice(0, MAX_CONSTRAINT_ENTRIES),
      activeEpisodeHeads: [...next.activeEpisodeHeads, ...rebuilt.activeEpisodeHeads].slice(0, MAX_EPISODE_HEADS),
      lexical: lexicalDocuments([
        ...next.stableProfile.map((bullet) => bullet.text),
        ...next.activeProfile.map((bullet) => bullet.text),
        ...next.constraints.map((constraint) => constraint.text),
        ...next.activeEpisodeHeads.flatMap((episode) => [episode.topic, ...episode.decisions, ...episode.openItems]),
      ]),
    }
  }

  const changedRefs = [...versions.values()].slice(0, MAX_INPUT_VERSIONS)
  const changedEventIds = [...new Set([
    ...next.inspector.dependencies.eventIds,
    ...ordered.flatMap((overlay) => sourceEventIds(overlay.version)),
  ])].slice(0, MAX_SOURCE_EVENT_REFS * 8)
  return trimSnapshot({
    ...next,
    generatedAt: now,
    freshness: 'fresh',
    coveredAssertionRefs: changedRefs,
    inspector: {
      ...next.inspector,
      ageMs: 0,
      inputCoverage: { ...next.coverage },
      dependencies: {
        ...next.inspector.dependencies,
        assertionVersions: changedRefs.map((ref) => `revision/${ref.assertionId}/${ref.revision}`),
        eventIds: changedEventIds,
      },
    },
  })
}

export function serializeWarmSnapshot(snapshot: WarmSnapshot): string {
  return JSON.stringify(snapshot)
}

export function serializedWarmSnapshotBytes(snapshot: WarmSnapshot): number {
  return byteLength(snapshot)
}

export function parseWarmSnapshot(input: unknown): { ok: true; value: WarmSnapshot } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: 'Snapshot payload must be an object.' }
  if (input.schemaVersion !== PROJECTION_SCHEMA_VERSION) return { ok: false, error: 'Unsupported snapshot schema.' }
  if (typeof input.snapshotId !== 'string' || !input.snapshotId || typeof input.scopeId !== 'string' || !input.scopeId || typeof input.principalId !== 'string' || !input.principalId) return { ok: false, error: 'Snapshot identity fields are invalid.' }
  if (typeof input.generatedAt !== 'string' || Number.isNaN(Date.parse(input.generatedAt)) || (input.expiresAt !== null && (typeof input.expiresAt !== 'string' || Number.isNaN(Date.parse(input.expiresAt))))) return { ok: false, error: 'Snapshot timestamps are invalid.' }
  if (input.freshness !== 'fresh' && input.freshness !== 'stale' && input.freshness !== 'expired') return { ok: false, error: 'Snapshot freshness is invalid.' }
  if (!isNonNegativeInteger(input.policyEpoch) || !isNonNegativeInteger(input.deletionEpoch)) return { ok: false, error: 'Snapshot epoch fields are invalid.' }
  if (!Array.isArray(input.stableProfile) || input.stableProfile.length > MAX_PROFILE_BULLETS || !Array.isArray(input.activeProfile) || input.activeProfile.length > MAX_ACTIVE_PROFILE_BULLETS || !Array.isArray(input.constraints) || input.constraints.length > MAX_CONSTRAINT_ENTRIES || !Array.isArray(input.activeEpisodeHeads) || input.activeEpisodeHeads.length > MAX_EPISODE_HEADS || !Array.isArray(input.recentAcceptedChanges) || input.recentAcceptedChanges.length > MAX_RECENT_ACCEPTED_CHANGES || !Array.isArray(input.coveredAssertionRefs) || input.coveredAssertionRefs.length > MAX_INPUT_VERSIONS || !isRecord(input.coverage) || !isRecord(input.inspector) || !isRecord(input.lexical) || !isRecord(input.inspector.dependencies)) return { ok: false, error: 'Snapshot collections are invalid.' }
  if (!input.coveredAssertionRefs.every(isExactRef)) return { ok: false, error: 'Snapshot assertion references are invalid.' }
  const refs = input.coveredAssertionRefs as ExactVersionRef[]
  const refKeys = new Set(refs.map((ref) => `${ref.assertionId}/${ref.revision}`))
  if (refKeys.size !== refs.length) return { ok: false, error: 'Snapshot assertion references contain duplicates.' }
  if (!input.stableProfile.every((item) => isProfileBullet(item, input.scopeId as string, refKeys) && item.placement === 'stable') || !input.activeProfile.every((item) => isProfileBullet(item, input.scopeId as string, refKeys) && item.placement === 'active_topic') || !input.constraints.every((item) => isConstraintEntry(item, input.scopeId as string, refKeys)) || !input.activeEpisodeHeads.every((item) => isEpisodeHead(item, input.scopeId as string, refKeys)) || !input.recentAcceptedChanges.every((item) => isProjectionChange(item, input.scopeId as string))) return { ok: false, error: 'Snapshot projection entries are invalid.' }
  if (input.activeTopic !== null && (!isRecord(input.activeTopic) || typeof input.activeTopic.id !== 'string' || typeof input.activeTopic.label !== 'string')) return { ok: false, error: 'Snapshot active topic is invalid.' }
  const coverage = input.coverage as Record<string, unknown>
  const coverageFields = ['eventSequenceFrom', 'eventSequenceTo', 'changeWatermarkFrom', 'changeWatermarkTo'] as const
  if (!coverageFields.every((field) => isNonNegativeInteger(coverage[field])) || typeof coverage.complete !== 'boolean' || typeof coverage.resetRequired !== 'boolean') return { ok: false, error: 'Snapshot coverage fields are invalid.' }
  const eventSequenceFrom = coverage.eventSequenceFrom as number
  const eventSequenceTo = coverage.eventSequenceTo as number
  const changeWatermarkFrom = coverage.changeWatermarkFrom as number
  const changeWatermarkTo = coverage.changeWatermarkTo as number
  if (eventSequenceFrom > eventSequenceTo || changeWatermarkFrom > changeWatermarkTo) return { ok: false, error: 'Snapshot coverage range is invalid.' }
  const inspector = input.inspector as Record<string, unknown>
  const dependencies = inspector.dependencies as Record<string, unknown>
  if (inspector.schemaVersion !== PROJECTION_SCHEMA_VERSION || typeof inspector.projectionId !== 'string' || typeof inspector.generation !== 'string' || !isNonNegativeInteger(inspector.ageMs)) return { ok: false, error: 'Snapshot inspector fields are invalid.' }
  if (!Array.isArray(inspector.missingInputs) || !isStringArray(inspector.missingInputs) || inspector.missingInputs.length > 512 || !Array.isArray(inspector.conflicts) || !isStringArray(inspector.conflicts) || inspector.conflicts.length > 512 || !Array.isArray(inspector.bulletReasons) || !isStringArray(inspector.bulletReasons) || inspector.bulletReasons.length > MAX_PROFILE_BULLETS + MAX_ACTIVE_PROFILE_BULLETS + MAX_CONSTRAINT_ENTRIES) return { ok: false, error: 'Snapshot inspector diagnostics are invalid.' }
  if (!isStringArray(dependencies.assertionVersions) || !isStringArray(dependencies.eventIds) || dependencies.eventIds.length > MAX_SOURCE_EVENT_REFS * 8 || !isNonNegativeInteger(dependencies.policyEpoch) || !isNonNegativeInteger(dependencies.deletionEpoch)) return { ok: false, error: 'Snapshot dependencies are invalid.' }
  if (dependencies.policyEpoch !== input.policyEpoch || dependencies.deletionEpoch !== input.deletionEpoch) return { ok: false, error: 'Snapshot epoch binding is inconsistent.' }
  if (JSON.stringify(dependencies.assertionVersions) !== JSON.stringify(refs.map((ref) => `revision/${ref.assertionId}/${ref.revision}`))) return { ok: false, error: 'Snapshot revision dependencies are inconsistent.' }
  if (JSON.stringify(inspector.inputCoverage) !== JSON.stringify(coverage)) return { ok: false, error: 'Snapshot inspector coverage is inconsistent.' }
  if (!coverage.complete && !(inspector.missingInputs as string[]).length) return { ok: false, error: 'Incomplete snapshot coverage has no missing-input reason.' }
  const lexical = input.lexical as Record<string, unknown>
  if (lexical.schemaVersion !== PROJECTION_SCHEMA_VERSION || !isNonNegativeInteger(lexical.documentCount) || !Array.isArray(lexical.terms) || lexical.terms.length > MAX_LEXICAL_TERMS || !lexical.terms.every((term) => isRecord(term) && typeof term.term === 'string' && term.term.length > 0 && term.term.length <= 128 && isNonNegativeInteger(term.frequency) && term.frequency > 0 && term.frequency <= (lexical.documentCount as number))) return { ok: false, error: 'Snapshot lexical index is invalid.' }
  if (byteLength(input) > MAX_SNAPSHOT_BYTES) return { ok: false, error: 'Snapshot exceeds the bounded cache size.' }
  const value = input as unknown as WarmSnapshot
  return { ok: true, value }
}

function sameBinding(left: SnapshotCacheBinding, right: SnapshotCacheBinding): boolean {
  return left.principalId === right.principalId
    && left.scopeId === right.scopeId
    && left.policyEpoch === right.policyEpoch
    && left.deletionEpoch === right.deletionEpoch
    && left.leaseId === right.leaseId
    && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt
}

function validLease(binding: SnapshotCacheBinding): boolean {
  const issued = Date.parse(binding.issuedAt)
  const expires = Date.parse(binding.expiresAt)
  return Number.isFinite(issued) && Number.isFinite(expires) && expires > issued && expires - issued <= MAX_PRIVATE_CACHE_LEASE_MS
}

export class WarmSnapshotCache {
  private entry: { snapshot: WarmSnapshot; binding: SnapshotCacheBinding } | null = null
  private readonly listeners = new Set<(event: ProjectionInvalidation) => void>()

  put(snapshot: WarmSnapshot, binding: SnapshotCacheBinding): boolean {
    if (!validLease(binding)) return false
    const parsed = parseWarmSnapshot(snapshot)
    if (!parsed.ok) return false
    if (parsed.value.scopeId !== binding.scopeId || parsed.value.principalId !== binding.principalId || parsed.value.policyEpoch !== binding.policyEpoch || parsed.value.deletionEpoch !== binding.deletionEpoch) return false
    if (this.entry && this.entry.snapshot.coverage.changeWatermarkTo > parsed.value.coverage.changeWatermarkTo) return false
    this.entry = { snapshot: parsed.value, binding }
    return true
  }

  acceptAuthorityResult(result: SnapshotAuthorityResult, binding: SnapshotCacheBinding): boolean {
    if (result.status !== 'available' || !result.snapshot) return false
    return this.put(result.snapshot, binding)
  }

  read(binding: SnapshotCacheBinding, now: string): SnapshotCacheRead {
    if (!this.entry) return { status: 'cold', snapshot: null, reason: 'no_snapshot' }
    if (!sameBinding(this.entry.binding, binding)) return { status: 'binding_mismatch', snapshot: null, reason: 'identity_or_epoch_changed' }
    if (Date.parse(this.entry.binding.expiresAt) <= Date.parse(now) || Date.parse(this.entry.snapshot.expiresAt ?? this.entry.binding.expiresAt) <= Date.parse(now)) {
      this.invalidate({ ...this.invalidation('lease_expired'), reason: 'lease_expired' })
      return { status: 'expired', snapshot: null, reason: 'private_lease_expired' }
    }
    if (this.entry.snapshot.freshness !== 'fresh') return { status: 'invalidated', snapshot: null, reason: 'snapshot_not_fresh' }
    return { status: 'hit', snapshot: this.entry.snapshot }
  }

  renew(binding: SnapshotCacheBinding, now: string, expiresAt: string): boolean {
    if (!this.entry || !sameBinding(this.entry.binding, binding)) return false
    if (Date.parse(binding.expiresAt) <= Date.parse(now)) return false
    const renewed = { ...binding, issuedAt: now, expiresAt }
    if (!validLease(renewed) || Date.parse(expiresAt) <= Date.parse(now)) return false
    this.entry = { ...this.entry, binding: renewed }
    return true
  }

  applyOverlays(binding: SnapshotCacheBinding, overlays: readonly ProjectionChange[], now: string): boolean {
    if (!this.entry || !sameBinding(this.entry.binding, binding)) return false
    this.entry = { ...this.entry, snapshot: applyAcceptedCorrectionOverlays(this.entry.snapshot, overlays, now) }
    return true
  }

  invalidate(event: ProjectionInvalidation): void {
    if (this.entry && (this.entry.snapshot.scopeId !== event.scopeId || this.entry.snapshot.principalId !== event.principalId)) return
    this.entry = null
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: (event: ProjectionInvalidation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get size(): number {
    return this.entry ? 1 : 0
  }

  private invalidation(reason: ProjectionInvalidation['reason']): ProjectionInvalidation {
    if (!this.entry) throw new Error('A cache invalidation requires a cache entry.')
    return {
      scopeId: this.entry.snapshot.scopeId,
      principalId: this.entry.snapshot.principalId,
      policyEpoch: this.entry.snapshot.policyEpoch,
      deletionEpoch: this.entry.snapshot.deletionEpoch,
      reason,
      changeWatermark: this.entry.snapshot.coverage.changeWatermarkTo,
    }
  }
}

export class SnapshotTelemetryBuffer {
  private readonly records = new Map<string, SnapshotTelemetrySummary>()

  record(event: SnapshotTelemetryEvent): boolean {
    if (!event.itemId.trim() || !event.observedAt || !this.records.has(event.itemId) && this.records.size >= MAX_TELEMETRY_ITEMS) return false
    const current = this.records.get(event.itemId)
    const next: SnapshotTelemetrySummary = current
      ? { ...current, lastObservedAt: event.observedAt }
      : { itemId: event.itemId, retrieved: 0, included: 0, cited: 0, independentlyUseful: 0, firstObservedAt: event.observedAt, lastObservedAt: event.observedAt }
    if (event.retrieved) next.retrieved += 1
    if (event.included) next.included += 1
    if (event.cited) next.cited += 1
    if (event.independentlyUseful) next.independentlyUseful += 1
    this.records.set(event.itemId, next)
    return true
  }

  drain(): readonly SnapshotTelemetrySummary[] {
    const values = [...this.records.values()]
    this.records.clear()
    return values
  }

  get size(): number {
    return this.records.size
  }
}

export function projectionChangeWatermark(change: ProjectionChange): number {
  return safeWatermark(change.changeWatermark)
}
