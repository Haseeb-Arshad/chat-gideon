/**
 * Edge-safe semantic contracts for conversational memory.
 *
 * This module is deliberately boring at runtime: it has no framework, Node,
 * filesystem, database-driver, provider, or secret imports.  Server adapters
 * bind the trusted fields and storage capability; request bodies and model
 * arguments are validated as public commands and can never supply those
 * fields themselves.
 */

export const MEMORY_CONTRACT_VERSION = 1 as const
export const MAX_IDEMPOTENCY_KEY_LENGTH = 160
export const MAX_EVENT_PAYLOAD_BYTES = 16_384
export const MAX_SOURCE_SPANS = 8
export const MAX_SOURCE_SPAN_LENGTH = 8_192
export const MAX_ASSERTION_TEXT_LENGTH = 1_024
export const MAX_CONDITIONS = 12
export const MAX_EVIDENCE_REFS = 16
export const MAX_DEPENDENCIES = 32
export const MAX_GRANTS = 16

declare const identifierBrand: unique symbol
export type Identifier<Name extends string> = string & { readonly [identifierBrand]: Name }
export type PrincipalId = Identifier<'principal'>
export type SubjectId = Identifier<'subject'>
export type ScopeId = Identifier<'scope'>
export type ClientId = Identifier<'client'>
export type EventId = Identifier<'event'>
export type ConversationId = Identifier<'conversation'>
export type TurnId = Identifier<'turn'>
export type AssertionId = Identifier<'assertion'>
export type RevisionId = Identifier<'revision'>
export type ConsentId = Identifier<'consent'>
export type GrantId = Identifier<'grant'>
export type SourceId = Identifier<'source'>

export type ContractIssueCode =
  | 'invalid_type'
  | 'invalid_value'
  | 'unknown_enum'
  | 'unknown_field'
  | 'missing_field'
  | 'too_large'
  | 'unsafe_field'
  | 'inconsistent'

export interface ContractIssue {
  path: string
  code: ContractIssueCode
  message: string
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryContractError }

export class MemoryContractError extends Error {
  readonly name = 'MemoryContractError'

  constructor(
    readonly issues: readonly ContractIssue[],
    message = issues[0]?.message ?? 'The memory contract is invalid.',
  ) {
    super(message)
  }

  get code(): ContractIssueCode {
    return this.issues[0]?.code ?? 'inconsistent'
  }
}

export type MemoryFailureCode =
  | 'unauthorized'
  | 'conflict'
  | 'ambiguous'
  | 'unavailable'
  | 'budget_exhausted'
  | 'validation'
  | 'not_found'
  | 'suppressed'

export interface MemoryFailure {
  code: MemoryFailureCode
  message: string
  retryable: boolean
  /** Safe, bounded metadata only. Never include source text or provider errors. */
  details?: Readonly<Record<string, string | number | boolean>>
}

export type MemoryAction =
  | 'capture'
  | 'read'
  | 'remember'
  | 'correct'
  | 'forget'
  | 'recall'
  | 'inspect'
  | 'export'

export type SessionTrust = 'authenticated' | 'ephemeral'
export type SessionAuthority =
  | 'node_signed_cookie'
  | 'worker_auth_session'
  | 'worker_internal_owner'
  | 'ephemeral_request'

export type PrincipalKind = 'anonymous' | 'user' | 'service'

export interface Principal {
  id: PrincipalId
  kind: PrincipalKind
  trust: SessionTrust
}

export type ClientChannel = 'http' | 'websocket' | 'worker_http' | 'worker_websocket' | 'test'

export interface ClientContext {
  id: ClientId
  channel: ClientChannel
  /** Optional server-observed revision; it is never accepted from a claim payload. */
  connectionRevision: string | null
}

export type ScopeKind = 'account' | 'project' | 'conversation' | 'task' | 'global'

export interface Scope {
  id: ScopeId
  kind: ScopeKind
  parentId: ScopeId | null
}

export interface Grant {
  id: GrantId
  scopeId: ScopeId
  actions: readonly MemoryAction[]
  issuedBy: 'server_policy'
  expiresAt: string | null
}

export type ActorRef =
  | { kind: 'principal'; principalId: PrincipalId }
  | { kind: 'assistant'; assistantId: 'gideon' }
  | { kind: 'third_party'; label: string; externalId: string | null }

export type ClaimSubject =
  | { kind: 'known'; subjectId: SubjectId }
  | { kind: 'unresolved'; label: string | null }

export type SourceBasis =
  | 'explicit_user_statement'
  | 'user_correction'
  | 'verified_tool_result'
  | 'inference'
  | 'imported_legacy'
  | 'attributed_third_party'
  | 'assistant_delivery_observation'

export type EventSourceKind =
  | 'user_statement'
  | 'user_correction'
  | 'verified_tool_result'
  | 'assistant_generated'
  | 'assistant_sent'
  | 'assistant_played'
  | 'assistant_displayed'
  | 'assistant_acknowledged'
  | 'quoted_third_party'
  | 'third_party_document'
  | 'imported_legacy'
  | 'model_inference'

export type SourceAuthorityKind =
  | 'authenticated_user'
  | 'server_verified_tool'
  | 'server_generated'
  | 'client_report'
  | 'third_party_evidence'
  | 'legacy_import'
  | 'model_inference'

export interface SourceAuthority {
  kind: SourceAuthorityKind
  revision: RevisionId
}

export interface SourceDocument {
  sourceId: SourceId
  revision: RevisionId
  contentHash: string
}

export interface SourceSpan {
  document: SourceDocument
  start: number
  end: number
  /** Hash of the immutable source slice; raw text is not required in the core. */
  textHash: string
  quote: string | null
}

export type TimePrecision = 'unknown' | 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'

export interface ValidTime {
  from: string | null
  until: string | null
  precision: TimePrecision
  /** Preserve the source zone when a date was interpreted from a local source. */
  sourceTimeZone: string | null
}

export type TemporalRelation = 'ordinary' | 'correction' | 'transition' | 'temporary_exception'

export interface TimeSemantics {
  validTime: ValidTime
  /** System receipt and interpretation are distinct from source/valid time. */
  receivedAt: string
  interpretedAt: string
  relation: TemporalRelation
}

export interface ConsentRef {
  id: ConsentId
  policyVersion: RevisionId
  purpose: 'memory_capture' | 'memory_retention' | 'assistant_delivery_observation'
}

export type CommittedPhase = 'committed' | 'corrected' | 'retracted'

export interface EventEnvelope {
  schemaVersion: typeof MEMORY_CONTRACT_VERSION
  id: EventId
  idempotencyKey: string
  conversationId: ConversationId
  turnId: TurnId
  actor: ActorRef
  /** This is the entity the event is about, not necessarily its actor. */
  subject: ClaimSubject
  sourceKind: EventSourceKind
  sourceAuthority: SourceAuthority
  committedPhase: CommittedPhase
  sequence: number
  sourceTime: string | null
  sourceTimePrecision: TimePrecision
  receivedAt: string
  consent: ConsentRef | null
  sourceSpans: readonly SourceSpan[]
  payload: BoundedPayload
}

export type BoundedJson = null | boolean | number | string | readonly BoundedJson[] | { readonly [key: string]: BoundedJson }
export type BoundedPayload = Readonly<Record<string, BoundedJson>>

export type SlotCardinality = 'scalar' | 'set' | 'event'

export interface CanonicalSlot {
  slotId: string
  cardinality: SlotCardinality
}

export interface Condition {
  key: string
  operator: 'equals' | 'not_equals' | 'contains' | 'in'
  value: BoundedJson
}

export type Proposition =
  | {
      type: 'slot'
      slot: CanonicalSlot
      value: BoundedJson
    }
  | {
      type: 'free_form'
      text: string
      /** Free-form claims may stay unresolved instead of guessing a slot/entity. */
      subject: ClaimSubject
      conditions: readonly Condition[]
    }

export interface FactAssertionPayload {
  kind: 'fact'
  proposition: Proposition
}

export interface PreferenceAssertionPayload {
  kind: 'preference'
  text: string
  conditions: readonly Condition[]
  exceptions: readonly Condition[]
}

export interface ConstraintAssertionPayload {
  kind: 'constraint'
  text: string
  conditions: readonly Condition[]
  exceptions: readonly Condition[]
}

export interface DecisionAssertionPayload {
  kind: 'decision'
  topic: string
  decision: string
  alternatives: readonly string[]
  reasons: readonly string[]
}

export interface EpisodeCheckpointPayload {
  kind: 'episode_checkpoint'
  topic: string
  decisions: readonly string[]
  alternatives: readonly string[]
  reasons: readonly string[]
  openItems: readonly string[]
  meaningfulOutcomes: readonly string[]
  sourceWatermark: string
  state: BoundedJson
}

export type AssertionKind = 'fact' | 'preference' | 'constraint' | 'decision' | 'episode_checkpoint'
export type AssertionPayload =
  | FactAssertionPayload
  | PreferenceAssertionPayload
  | ConstraintAssertionPayload
  | DecisionAssertionPayload
  | EpisodeCheckpointPayload

export type AssertionStatus = 'candidate' | 'accepted' | 'disputed' | 'superseded' | 'retracted' | 'deleted'
export type AssertionPolarity = 'positive' | 'negative' | 'unknown'

export type EvidenceRelation = 'supports' | 'contradicts' | 'derived_from'

export interface EvidenceRef {
  eventId: EventId
  span: SourceSpan | null
  relation: EvidenceRelation
}

export interface DependencyRef {
  type: 'event' | 'assertion' | 'projection' | 'source'
  id: string
  revision: RevisionId
}

export interface ProducerVersion {
  name: string
  version: string
  model: string | null
}

export interface AssertionAttribution {
  actor: ActorRef
  basis: SourceBasis
}

export interface AssertionVersion {
  schemaVersion: typeof MEMORY_CONTRACT_VERSION
  id: AssertionId
  revision: number
  scopeId: ScopeId
  subject: ClaimSubject
  kind: AssertionKind
  payload: AssertionPayload
  attribution: AssertionAttribution
  polarity: AssertionPolarity
  status: AssertionStatus
  time: TimeSemantics
  evidence: readonly EvidenceRef[]
  dependencies: readonly DependencyRef[]
  producer: ProducerVersion
  /** The exact prior version this edit replaces, retained for audit and reads. */
  supersedes?: ExactVersionRef | null
}

export interface Projection {
  schemaVersion: typeof MEMORY_CONTRACT_VERSION
  id: string
  scopeId: ScopeId
  inputVersions: readonly RevisionId[]
  coveredSequenceFrom: number
  coveredSequenceTo: number
  policyEpoch: number
  deletionEpoch: number
  generation: string
  freshness: 'fresh' | 'stale' | 'expired'
  expiresAt: string | null
}

export interface RecallRequest {
  query: string
  scopeId: ScopeId
  subject: ClaimSubject
  limit: number
  asOf: string | null
}

export interface PublicRememberCommand {
  schemaVersion: typeof MEMORY_CONTRACT_VERSION
  commandId: string
  kind: 'remember'
  text: string
  assertionKind: Exclude<AssertionKind, 'episode_checkpoint'>
  conditions: readonly Condition[]
  /** User-supplied valid-time information; receipt/interpretation time is server-bound. */
  validTime?: ValidTime
  relation?: 'ordinary' | 'temporary_exception'
  polarity?: AssertionPolarity
}

export interface PublicCorrectCommand {
  schemaVersion: typeof MEMORY_CONTRACT_VERSION
  commandId: string
  kind: 'correct'
  targetAssertionId: AssertionId
  targetRevision: number
  sourceRevision?: RevisionId | null
  text: string
  assertionKind: Exclude<AssertionKind, 'episode_checkpoint'>
  conditions: readonly Condition[]
  validTime?: ValidTime
  relation?: 'correction' | 'transition' | 'temporary_exception'
  polarity?: AssertionPolarity
}

export interface PublicForgetCommand {
  schemaVersion: typeof MEMORY_CONTRACT_VERSION
  commandId: string
  kind: 'forget'
  targetAssertionId: AssertionId | null
  /** Exact immutable version required for a destructive target. */
  targetRevision: number | null
  query: string | null
}

export interface PublicRecallCommand {
  schemaVersion: typeof MEMORY_CONTRACT_VERSION
  commandId: string
  kind: 'recall'
  query: string
  limit: number
}

export type PublicMemoryCommand =
  | PublicRememberCommand
  | PublicCorrectCommand
  | PublicForgetCommand
  | PublicRecallCommand

export interface BoundMemoryCommand {
  schemaVersion: typeof MEMORY_CONTRACT_VERSION
  command: PublicMemoryCommand
  principalId: PrincipalId
  subject: ClaimSubject
  scope: Scope
  sourceAuthority: SourceAuthority
  policyEpoch: number
}

export interface ScopedCandidateQuery {
  scopeId: ScopeId
  subject: ClaimSubject
  query: string
  limit: number
  asOf: string | null
}

export interface OutboxLease {
  id: string
  inputEventId: EventId
  leaseRevision: RevisionId
  leasedUntil: string
  attempt: number
}

export interface ExactVersionRef {
  assertionId: AssertionId
  revision: number
}

export interface AssertionCommit {
  assertion: AssertionVersion
  expectedRevision: number | null
  slot: CanonicalSlot | null
  /** Server-computed exact identity used by deterministic explicit commands. */
  canonicalKey?: string | null
}

/**
 * The minimum server capability.  This is intentionally not get/set: later
 * adapters must be able to express atomic capture, exact-version reads,
 * scoped reads, optimistic revision/slot locking, suppression and leasing.
 */
export interface MemoryStorageTransaction {
  findEventByIdempotency(idempotencyKey: string): Promise<EventEnvelope | null>
  insertEvent(event: EventEnvelope): Promise<'inserted' | 'duplicate'>
  exactVersion(reference: ExactVersionRef): Promise<AssertionVersion | null>
  scopedCandidates(query: ScopedCandidateQuery): Promise<readonly AssertionVersion[]>
  withSlotLock<T>(scopeId: ScopeId, slot: CanonicalSlot, work: () => Promise<T>): Promise<T>
  commitAssertion(input: AssertionCommit): Promise<
    | { ok: true; revision: number }
    | { ok: false; failure: MemoryFailure }
  >
  leaseOutbox(limit: number, now: string, leaseMs: number): Promise<readonly OutboxLease[]>
  isSuppressed(target: ExactVersionRef | { eventId: EventId }): Promise<boolean>
  dependenciesFor(reference: ExactVersionRef): Promise<readonly DependencyRef[]>
}

export interface MemoryStorageCapabilities {
  transaction<T>(work: (transaction: MemoryStorageTransaction) => Promise<T>): Promise<T>
}

export interface MemorySessionDescriptor {
  readonly schemaVersion: typeof MEMORY_CONTRACT_VERSION
  readonly trust: SessionTrust
  readonly authority: SessionAuthority
  readonly principal: Principal
  readonly client: ClientContext
  readonly subject: ClaimSubject
  readonly scope: Scope
  readonly grants: readonly Grant[]
  readonly policyEpoch: number
}

export interface MemorySession<Store = unknown> extends MemorySessionDescriptor {
  readonly store: Store
}

export type ReceiptState = 'captured' | 'accepted' | 'indexed' | 'pending' | 'failed'

interface ReceiptBase {
  schemaVersion: typeof MEMORY_CONTRACT_VERSION
  receiptId: string
  eventId: EventId | null
  receivedAt: string
}

export type MemoryReceipt =
  | (ReceiptBase & {
      ok: true
      state: 'captured'
      canonicalRevision: null
      indexWatermark: null
    })
  | (ReceiptBase & {
      ok: true
      state: 'accepted'
      canonicalRevision: RevisionId
      indexWatermark: null
    })
  | (ReceiptBase & {
      ok: true
      state: 'indexed'
      canonicalRevision: RevisionId
      indexWatermark: string
    })
  | (ReceiptBase & {
      ok: true
      state: 'pending'
      canonicalRevision: null
      indexWatermark: null
      pendingReason: 'interpretation' | 'indexing' | 'provider'
    })
  | (ReceiptBase & {
      ok: false
      state: 'failed'
      canonicalRevision: null
      indexWatermark: null
      failure: MemoryFailure
    })

export const CANONICAL_SLOTS: Readonly<Record<string, SlotCardinality>> = Object.freeze({
  'user.display_name': 'scalar',
  'user.timezone': 'scalar',
  'user.communication_style': 'set',
  'project.database_provider': 'scalar',
  'project.rejection_reason': 'event',
})

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const HASH_PATTERN = /^[A-Fa-f0-9]{16,128}$/
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/
const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function issue(path: string, code: ContractIssueCode, message: string): ContractIssue {
  return { path, code, message }
}

function parseResult<T>(value: T | null, issues: ContractIssue[]): ParseResult<T> {
  return issues.length ? { ok: false, error: new MemoryContractError(issues) } : { ok: true, value: value as T }
}

function invalid<T>(issues: ContractIssue[]): ParseResult<T> {
  return { ok: false, error: new MemoryContractError(issues) }
}

function unknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string): ContractIssue[] {
  const accepted = new Set(allowed)
  return Object.keys(value)
    .filter((key) => !accepted.has(key))
    .map((key) => issue(`${path}.${key}`, 'unknown_field', 'Unknown fields are rejected for this version.'))
}

function stringValue(value: unknown, path: string, issues: ContractIssue[], max: number): string | null {
  if (typeof value !== 'string') {
    issues.push(issue(path, 'invalid_type', 'Expected a string.'))
    return null
  }
  if (!value.trim()) issues.push(issue(path, 'invalid_value', 'String must not be empty.'))
  if (value.length > max) issues.push(issue(path, 'too_large', `String exceeds the ${max}-character limit.`))
  return value
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string, issues: ContractIssue[]): T | null {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    issues.push(issue(path, typeof value === 'string' ? 'unknown_enum' : 'invalid_type', 'Unsupported enum value.'))
    return null
  }
  return value as T
}

function numberValue(value: unknown, path: string, issues: ContractIssue[], min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected a safe integer.'))
    return null
  }
  if (value < min || value > max) issues.push(issue(path, 'invalid_value', 'Number is outside the supported range.'))
  return value
}

function identifier<Name extends string>(value: unknown, name: string, path: string, issues: ContractIssue[]): Identifier<Name> | null {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    issues.push(issue(path, 'invalid_value', `${name} has an invalid format.`))
    return null
  }
  return value as Identifier<Name>
}

function instant(value: unknown, path: string, issues: ContractIssue[], allowNull = false): string | null {
  if (allowNull && value === null) return null
  if (typeof value !== 'string' || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    issues.push(issue(path, 'invalid_value', 'Expected an ISO date or an ISO timestamp.'))
    return null
  }
  return value
}

function boundedJson(value: unknown, path: string, issues: ContractIssue[], depth = 0): BoundedJson | null {
  if (depth > 8) {
    issues.push(issue(path, 'too_large', 'Payload nesting is too deep.'))
    return null
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    return value.map((item, index) => boundedJson(item, `${path}[${index}]`, issues, depth + 1)) as BoundedJson
  }
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Only JSON values are permitted.'))
    return null
  }
  const result: Record<string, BoundedJson> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 64) issues.push(issue(`${path}.${key}`, 'too_large', 'Payload keys are too long.'))
    result[key] = boundedJson(item, `${path}.${key}`, issues, depth + 1) as BoundedJson
  }
  return result
}

function payload(value: unknown, path: string, issues: ContractIssue[]): BoundedPayload | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected a JSON object payload.'))
    return null
  }
  const parsed = boundedJson(value, path, issues)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(parsed)).byteLength
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) issues.push(issue(path, 'too_large', 'Payload exceeds the bounded event limit.'))
  } catch {
    issues.push(issue(path, 'invalid_value', 'Payload cannot be serialized as JSON.'))
  }
  return parsed as BoundedPayload
}

function parseActor(value: unknown, path: string, issues: ContractIssue[]): ActorRef | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected an actor object.'))
    return null
  }
  const kind = enumValue(value.kind, ['principal', 'assistant', 'third_party'] as const, `${path}.kind`, issues)
  if (kind === 'principal') {
    issues.push(...unknownFields(value, ['kind', 'principalId'], path))
    const principalId = identifier<'principal'>(value.principalId, 'Principal ID', `${path}.principalId`, issues)
    return principalId ? { kind, principalId } : null
  }
  if (kind === 'assistant') {
    issues.push(...unknownFields(value, ['kind', 'assistantId'], path))
    const assistantId = enumValue(value.assistantId, ['gideon'] as const, `${path}.assistantId`, issues)
    return assistantId ? { kind, assistantId } : null
  }
  if (kind === 'third_party') {
    issues.push(...unknownFields(value, ['kind', 'label', 'externalId'], path))
    const label = stringValue(value.label, `${path}.label`, issues, 160)
    const externalId = value.externalId === null ? null : stringValue(value.externalId, `${path}.externalId`, issues, 160)
    return label ? { kind, label, externalId } : null
  }
  return null
}

function parseSubject(value: unknown, path: string, issues: ContractIssue[]): ClaimSubject | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected a claim subject object.'))
    return null
  }
  const kind = enumValue(value.kind, ['known', 'unresolved'] as const, `${path}.kind`, issues)
  if (kind === 'known') {
    issues.push(...unknownFields(value, ['kind', 'subjectId'], path))
    const subjectId = identifier<'subject'>(value.subjectId, 'Subject ID', `${path}.subjectId`, issues)
    return subjectId ? { kind, subjectId } : null
  }
  if (kind === 'unresolved') {
    issues.push(...unknownFields(value, ['kind', 'label'], path))
    const label = value.label === null ? null : stringValue(value.label, `${path}.label`, issues, 160)
    return { kind, label }
  }
  return null
}

function parseAuthority(value: unknown, path: string, issues: ContractIssue[]): SourceAuthority | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected a source authority object.'))
    return null
  }
  issues.push(...unknownFields(value, ['kind', 'revision'], path))
  const kind = enumValue(value.kind, [
    'authenticated_user', 'server_verified_tool', 'server_generated', 'client_report',
    'third_party_evidence', 'legacy_import', 'model_inference',
  ] as const, `${path}.kind`, issues)
  const revision = identifier<'revision'>(value.revision, 'Revision ID', `${path}.revision`, issues)
  return kind && revision ? { kind, revision } : null
}

function parseSourceDocument(value: unknown, path: string, issues: ContractIssue[]): SourceDocument | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected an immutable source document.'))
    return null
  }
  issues.push(...unknownFields(value, ['sourceId', 'revision', 'contentHash'], path))
  const sourceId = identifier<'source'>(value.sourceId, 'Source ID', `${path}.sourceId`, issues)
  const revision = identifier<'revision'>(value.revision, 'Revision ID', `${path}.revision`, issues)
  const contentHash = typeof value.contentHash === 'string' && HASH_PATTERN.test(value.contentHash)
    ? value.contentHash
    : (issues.push(issue(`${path}.contentHash`, 'invalid_value', 'Source hashes must be bounded hexadecimal values.')), null)
  return sourceId && revision && contentHash ? { sourceId, revision, contentHash } : null
}

function parseSourceSpan(value: unknown, path: string, issues: ContractIssue[]): SourceSpan | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected a source span object.'))
    return null
  }
  issues.push(...unknownFields(value, ['document', 'start', 'end', 'textHash', 'quote'], path))
  const document = parseSourceDocument(value.document, `${path}.document`, issues)
  const start = numberValue(value.start, `${path}.start`, issues, 0, MAX_SOURCE_SPAN_LENGTH)
  const end = numberValue(value.end, `${path}.end`, issues, 1, MAX_SOURCE_SPAN_LENGTH)
  const textHash = typeof value.textHash === 'string' && HASH_PATTERN.test(value.textHash)
    ? value.textHash
    : (issues.push(issue(`${path}.textHash`, 'invalid_value', 'Span hashes must be bounded hexadecimal values.')), null)
  const quote = value.quote === null ? null : stringValue(value.quote, `${path}.quote`, issues, MAX_SOURCE_SPAN_LENGTH)
  if (start !== null && end !== null && end <= start) issues.push(issue(path, 'inconsistent', 'Source span end must be after start.'))
  return document && start !== null && end !== null && textHash ? { document, start, end, textHash, quote } : null
}

function parseConditions(value: unknown, path: string, issues: ContractIssue[]): readonly Condition[] {
  if (!Array.isArray(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected a condition array.'))
    return []
  }
  if (value.length > MAX_CONDITIONS) issues.push(issue(path, 'too_large', 'Too many conditions.'))
  return value.slice(0, MAX_CONDITIONS).flatMap((candidate, index) => {
    if (!isRecord(candidate)) {
      issues.push(issue(`${path}[${index}]`, 'invalid_type', 'Expected a condition object.'))
      return []
    }
    issues.push(...unknownFields(candidate, ['key', 'operator', 'value'], `${path}[${index}]`))
    const key = stringValue(candidate.key, `${path}[${index}].key`, issues, 96)
    const operator = enumValue(candidate.operator, ['equals', 'not_equals', 'contains', 'in'] as const, `${path}[${index}].operator`, issues)
    const parsedValue = boundedJson(candidate.value, `${path}[${index}].value`, issues)
    return key && operator && parsedValue !== null ? [{ key, operator, value: parsedValue }] : []
  })
}

function parseTimeSemantics(value: unknown, path: string, issues: ContractIssue[]): TimeSemantics | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected time semantics.'))
    return null
  }
  issues.push(...unknownFields(value, ['validTime', 'receivedAt', 'interpretedAt', 'relation'], path))
  const validValue = value.validTime
  if (!isRecord(validValue)) {
    issues.push(issue(`${path}.validTime`, 'invalid_type', 'Expected valid-time bounds.'))
    return null
  }
  issues.push(...unknownFields(validValue, ['from', 'until', 'precision', 'sourceTimeZone'], `${path}.validTime`))
  const from = instant(validValue.from, `${path}.validTime.from`, issues, true)
  const until = instant(validValue.until, `${path}.validTime.until`, issues, true)
  const precision = enumValue(validValue.precision, ['unknown', 'year', 'month', 'day', 'hour', 'minute', 'second'] as const, `${path}.validTime.precision`, issues)
  const sourceTimeZone = validValue.sourceTimeZone === null
    ? null
    : (typeof validValue.sourceTimeZone === 'string' && TIME_ZONE_PATTERN.test(validValue.sourceTimeZone)
      ? validValue.sourceTimeZone
      : (issues.push(issue(`${path}.validTime.sourceTimeZone`, 'invalid_value', 'Invalid source timezone.')), null))
  const receivedAt = instant(value.receivedAt, `${path}.receivedAt`, issues)
  const interpretedAt = instant(value.interpretedAt, `${path}.interpretedAt`, issues)
  const relation = enumValue(value.relation, ['ordinary', 'correction', 'transition', 'temporary_exception'] as const, `${path}.relation`, issues)
  if (precision === 'unknown' && (from !== null || until !== null)) {
    issues.push(issue(`${path}.validTime`, 'inconsistent', 'Unknown effective precision cannot carry an effective date.'))
  }
  if (from === null && precision !== 'unknown') {
    issues.push(issue(`${path}.validTime`, 'inconsistent', 'A known precision requires a known start.'))
  }
  if (from && until && Date.parse(until) < Date.parse(from)) {
    issues.push(issue(`${path}.validTime`, 'inconsistent', 'Valid-time end precedes its start.'))
  }
  return receivedAt && interpretedAt && precision && relation
    ? { validTime: { from, until, precision, sourceTimeZone }, receivedAt, interpretedAt, relation }
    : null
}

function parseCommandValidTime(value: unknown, path: string, issues: ContractIssue[]): ValidTime | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected valid-time bounds.'))
    return null
  }
  issues.push(...unknownFields(value, ['from', 'until', 'precision', 'sourceTimeZone'], path))
  const from = instant(value.from, `${path}.from`, issues, true)
  const until = instant(value.until, `${path}.until`, issues, true)
  const precision = enumValue(value.precision, ['unknown', 'year', 'month', 'day', 'hour', 'minute', 'second'] as const, `${path}.precision`, issues)
  const sourceTimeZone = value.sourceTimeZone === null
    ? null
    : (typeof value.sourceTimeZone === 'string' && TIME_ZONE_PATTERN.test(value.sourceTimeZone)
      ? value.sourceTimeZone
      : (issues.push(issue(`${path}.sourceTimeZone`, 'invalid_value', 'Invalid source timezone.')), null))
  if (precision === 'unknown' && (from !== null || until !== null)) {
    issues.push(issue(path, 'inconsistent', 'Unknown effective precision cannot carry an effective date.'))
  }
  if (from === null && precision !== 'unknown') {
    issues.push(issue(path, 'inconsistent', 'A known precision requires a known start.'))
  }
  if (from && until && Date.parse(until) < Date.parse(from)) {
    issues.push(issue(path, 'inconsistent', 'Valid-time end precedes its start.'))
  }
  return precision ? { from, until, precision, sourceTimeZone } : null
}

function parseProposition(value: unknown, path: string, issues: ContractIssue[]): Proposition | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected a proposition.'))
    return null
  }
  const type = enumValue(value.type, ['slot', 'free_form'] as const, `${path}.type`, issues)
  if (type === 'slot') {
    issues.push(...unknownFields(value, ['type', 'slot', 'value'], path))
    if (!isRecord(value.slot)) {
      issues.push(issue(`${path}.slot`, 'invalid_type', 'Expected a canonical slot.'))
      return null
    }
    issues.push(...unknownFields(value.slot, ['slotId', 'cardinality'], `${path}.slot`))
    const slotId = stringValue(value.slot.slotId, `${path}.slot.slotId`, issues, 96)
    const cardinality = enumValue(value.slot.cardinality, ['scalar', 'set', 'event'] as const, `${path}.slot.cardinality`, issues)
    const expected = slotId ? CANONICAL_SLOTS[slotId] : undefined
    if (!expected) issues.push(issue(`${path}.slot.slotId`, 'invalid_value', 'Slot is not registered.'))
    else if (cardinality !== expected) issues.push(issue(`${path}.slot.cardinality`, 'inconsistent', 'Slot cardinality does not match its registry.'))
    const parsedValue = boundedJson(value.value, `${path}.value`, issues)
    return slotId && cardinality && expected && parsedValue !== null ? { type, slot: { slotId, cardinality }, value: parsedValue } : null
  }
  if (type === 'free_form') {
    issues.push(...unknownFields(value, ['type', 'text', 'subject', 'conditions'], path))
    const text = stringValue(value.text, `${path}.text`, issues, MAX_ASSERTION_TEXT_LENGTH)
    const subject = parseSubject(value.subject, `${path}.subject`, issues)
    const conditions = parseConditions(value.conditions, `${path}.conditions`, issues)
    return text && subject ? { type, text, subject, conditions } : null
  }
  return null
}

function parseAssertionPayload(value: unknown, path: string, issues: ContractIssue[]): AssertionPayload | null {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected an assertion payload.'))
    return null
  }
  const kind = enumValue(value.kind, ['fact', 'preference', 'constraint', 'decision', 'episode_checkpoint'] as const, `${path}.kind`, issues)
  if (kind === 'fact') {
    issues.push(...unknownFields(value, ['kind', 'proposition'], path))
    const proposition = parseProposition(value.proposition, `${path}.proposition`, issues)
    return proposition ? { kind, proposition } : null
  }
  if (kind === 'preference' || kind === 'constraint') {
    issues.push(...unknownFields(value, ['kind', 'text', 'conditions', 'exceptions'], path))
    const text = stringValue(value.text, `${path}.text`, issues, MAX_ASSERTION_TEXT_LENGTH)
    const conditions = parseConditions(value.conditions, `${path}.conditions`, issues)
    const exceptions = parseConditions(value.exceptions, `${path}.exceptions`, issues)
    return text ? { kind, text, conditions, exceptions } : null
  }
  if (kind === 'decision') {
    issues.push(...unknownFields(value, ['kind', 'topic', 'decision', 'alternatives', 'reasons'], path))
    const topic = stringValue(value.topic, `${path}.topic`, issues, 240)
    const decision = stringValue(value.decision, `${path}.decision`, issues, MAX_ASSERTION_TEXT_LENGTH)
    const readList = (key: string, max: number) => {
      const candidate = value[key]
      if (!Array.isArray(candidate)) {
        issues.push(issue(`${path}.${key}`, 'invalid_type', 'Expected a string array.'))
        return [] as string[]
      }
      if (candidate.length > max) issues.push(issue(`${path}.${key}`, 'too_large', 'Too many entries.'))
      return candidate.slice(0, max).flatMap((item, index) => {
        const parsed = stringValue(item, `${path}.${key}[${index}]`, issues, 512)
        return parsed ? [parsed] : []
      })
    }
    const alternatives = readList('alternatives', 12)
    const reasons = readList('reasons', 12)
    return topic && decision ? { kind, topic, decision, alternatives, reasons } : null
  }
  if (kind === 'episode_checkpoint') {
    issues.push(...unknownFields(value, ['kind', 'topic', 'decisions', 'alternatives', 'reasons', 'openItems', 'meaningfulOutcomes', 'sourceWatermark', 'state'], path))
    const topic = stringValue(value.topic, `${path}.topic`, issues, 240)
    const sourceWatermark = stringValue(value.sourceWatermark, `${path}.sourceWatermark`, issues, 160)
    const state = boundedJson(value.state, `${path}.state`, issues)
    const readList = (key: string) => {
      const candidate = value[key]
      if (!Array.isArray(candidate)) {
        issues.push(issue(`${path}.${key}`, 'invalid_type', 'Expected a string array.'))
        return [] as string[]
      }
      if (candidate.length > 16) issues.push(issue(`${path}.${key}`, 'too_large', 'Too many entries.'))
      return candidate.slice(0, 16).flatMap((item, index) => {
        const parsed = stringValue(item, `${path}.${key}[${index}]`, issues, 512)
        return parsed ? [parsed] : []
      })
    }
    const decisions = readList('decisions')
    const alternatives = readList('alternatives')
    const reasons = readList('reasons')
    const openItems = readList('openItems')
    const meaningfulOutcomes = readList('meaningfulOutcomes')
    return topic && sourceWatermark && state !== null ? { kind, topic, decisions, alternatives, reasons, openItems, meaningfulOutcomes, sourceWatermark, state } : null
  }
  return null
}

function validateSourceCoherence(sourceKind: EventSourceKind | null, actor: ActorRef | null, authority: SourceAuthority | null, path: string, issues: ContractIssue[]) {
  if (!sourceKind || !actor || !authority) return
  const assistantSource = ['assistant_generated', 'assistant_sent', 'assistant_played', 'assistant_displayed', 'assistant_acknowledged'].includes(sourceKind)
  if (assistantSource && actor.kind !== 'assistant') issues.push(issue(`${path}.actor`, 'inconsistent', 'Assistant delivery events require the server assistant actor.'))
  if (assistantSource && sourceKind === 'assistant_generated' && authority.kind !== 'server_generated') {
    issues.push(issue(`${path}.sourceAuthority`, 'inconsistent', 'Generated assistant text requires server-generated authority.'))
  }
  if (sourceKind === 'user_statement' && actor.kind !== 'principal') issues.push(issue(`${path}.actor`, 'inconsistent', 'User statements require a principal actor.'))
  if (sourceKind === 'quoted_third_party' && authority.kind !== 'third_party_evidence') issues.push(issue(`${path}.sourceAuthority`, 'inconsistent', 'Quoted third-party content must retain third-party authority.'))
  if (sourceKind === 'model_inference' && authority.kind !== 'model_inference') issues.push(issue(`${path}.sourceAuthority`, 'inconsistent', 'Inferences must be marked as model output.'))
}

const FORBIDDEN_PUBLIC_FIELDS = new Set([
  'tenant', 'tenantId', 'principal', 'principalId', 'scope', 'scopeId', 'grant', 'grants', 'grantSet',
  'sourceAuthority', 'source_authority', 'authority', 'actor', 'canonicalRevision', 'policyEpoch',
])

function rejectForbiddenPublicFields(value: Record<string, unknown>, path: string, issues: ContractIssue[]) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PUBLIC_FIELDS.has(key)) issues.push(issue(`${path}.${key}`, 'unsafe_field', 'Authority fields are server-bound and cannot be supplied by a client or model.'))
  }
}

export function parseEventEnvelope(input: unknown): ParseResult<EventEnvelope> {
  const issues: ContractIssue[] = []
  if (!isRecord(input)) return invalid([issue('$', 'invalid_type', 'Expected an event object.')])
  issues.push(...unknownFields(input, [
    'schemaVersion', 'id', 'idempotencyKey', 'conversationId', 'turnId', 'actor', 'subject', 'sourceKind',
    'sourceAuthority', 'committedPhase', 'sequence', 'sourceTime', 'sourceTimePrecision', 'receivedAt', 'consent', 'sourceSpans', 'payload',
  ], '$'))
  const schemaVersion = numberValue(input.schemaVersion, '$.schemaVersion', issues, MEMORY_CONTRACT_VERSION, MEMORY_CONTRACT_VERSION)
  const id = identifier<'event'>(input.id, 'Event ID', '$.id', issues)
  const idempotencyKey = stringValue(input.idempotencyKey, '$.idempotencyKey', issues, MAX_IDEMPOTENCY_KEY_LENGTH)
  const conversationId = identifier<'conversation'>(input.conversationId, 'Conversation ID', '$.conversationId', issues)
  const turnId = identifier<'turn'>(input.turnId, 'Turn ID', '$.turnId', issues)
  const actor = parseActor(input.actor, '$.actor', issues)
  const subject = parseSubject(input.subject, '$.subject', issues)
  const sourceKind = enumValue(input.sourceKind, [
    'user_statement', 'user_correction', 'verified_tool_result', 'assistant_generated', 'assistant_sent',
    'assistant_played', 'assistant_displayed', 'assistant_acknowledged', 'quoted_third_party', 'third_party_document',
    'imported_legacy', 'model_inference',
  ] as const, '$.sourceKind', issues)
  const sourceAuthority = parseAuthority(input.sourceAuthority, '$.sourceAuthority', issues)
  const committedPhase = enumValue(input.committedPhase, ['committed', 'corrected', 'retracted'] as const, '$.committedPhase', issues)
  const sequence = numberValue(input.sequence, '$.sequence', issues, 1)
  const sourceTime = instant(input.sourceTime, '$.sourceTime', issues, true)
  const sourceTimePrecision = enumValue(input.sourceTimePrecision, ['unknown', 'year', 'month', 'day', 'hour', 'minute', 'second'] as const, '$.sourceTimePrecision', issues)
  const receivedAt = instant(input.receivedAt, '$.receivedAt', issues)
  let consent: ConsentRef | null = null
  if (input.consent !== null) {
    if (!isRecord(input.consent)) issues.push(issue('$.consent', 'invalid_type', 'Expected a consent reference or null.'))
    else {
      issues.push(...unknownFields(input.consent, ['id', 'policyVersion', 'purpose'], '$.consent'))
      const consentId = identifier<'consent'>(input.consent.id, 'Consent ID', '$.consent.id', issues)
      const policyVersion = identifier<'revision'>(input.consent.policyVersion, 'Policy revision', '$.consent.policyVersion', issues)
      const purpose = enumValue(input.consent.purpose, ['memory_capture', 'memory_retention', 'assistant_delivery_observation'] as const, '$.consent.purpose', issues)
      if (consentId && policyVersion && purpose) consent = { id: consentId, policyVersion, purpose }
    }
  }
  const spanValue = input.sourceSpans
  const sourceSpans: SourceSpan[] = []
  if (!Array.isArray(spanValue)) issues.push(issue('$.sourceSpans', 'invalid_type', 'Expected a source-span array.'))
  else {
    if (spanValue.length > MAX_SOURCE_SPANS) issues.push(issue('$.sourceSpans', 'too_large', 'Too many source spans.'))
    for (const [index, candidate] of spanValue.slice(0, MAX_SOURCE_SPANS).entries()) {
      const span = parseSourceSpan(candidate, `$.sourceSpans[${index}]`, issues)
      if (span) sourceSpans.push(span)
    }
  }
  const parsedPayload = payload(input.payload, '$.payload', issues)
  validateSourceCoherence(sourceKind, actor, sourceAuthority, '$', issues)
  if (sourceTimePrecision === 'unknown' && sourceTime !== null) issues.push(issue('$.sourceTime', 'inconsistent', 'Unknown source precision cannot carry a source date.'))
  if (schemaVersion !== MEMORY_CONTRACT_VERSION || sequence === null || !receivedAt || !parsedPayload || !id || !idempotencyKey || !conversationId || !turnId || !actor || !subject || !sourceKind || !sourceAuthority || !committedPhase || !sourceTimePrecision) {
    return invalid(issues)
  }
  return parseResult({
    schemaVersion: MEMORY_CONTRACT_VERSION, id, idempotencyKey, conversationId, turnId, actor, subject, sourceKind,
    sourceAuthority, committedPhase, sequence, sourceTime, sourceTimePrecision, receivedAt, consent, sourceSpans,
    payload: parsedPayload,
  }, issues)
}

export function parseAssertionVersion(input: unknown): ParseResult<AssertionVersion> {
  const issues: ContractIssue[] = []
  if (!isRecord(input)) return invalid([issue('$', 'invalid_type', 'Expected an assertion version object.')])
  issues.push(...unknownFields(input, [
    'schemaVersion', 'id', 'revision', 'scopeId', 'subject', 'kind', 'payload', 'attribution', 'polarity', 'status', 'time', 'evidence', 'dependencies', 'producer', 'supersedes',
  ], '$'))
  const schemaVersion = numberValue(input.schemaVersion, '$.schemaVersion', issues, MEMORY_CONTRACT_VERSION, MEMORY_CONTRACT_VERSION)
  const id = identifier<'assertion'>(input.id, 'Assertion ID', '$.id', issues)
  const revision = numberValue(input.revision, '$.revision', issues, 1)
  const scopeId = identifier<'scope'>(input.scopeId, 'Scope ID', '$.scopeId', issues)
  const subject = parseSubject(input.subject, '$.subject', issues)
  const kind = enumValue(input.kind, ['fact', 'preference', 'constraint', 'decision', 'episode_checkpoint'] as const, '$.kind', issues)
  const parsedPayload = parseAssertionPayload(input.payload, '$.payload', issues)
  if (parsedPayload && kind && parsedPayload.kind !== kind) issues.push(issue('$.payload.kind', 'inconsistent', 'Payload kind must match the assertion kind.'))
  if (!isRecord(input.attribution)) issues.push(issue('$.attribution', 'invalid_type', 'Expected assertion attribution.'))
  let attribution: AssertionAttribution | null = null
  if (isRecord(input.attribution)) {
    issues.push(...unknownFields(input.attribution, ['actor', 'basis'], '$.attribution'))
    const actor = parseActor(input.attribution.actor, '$.attribution.actor', issues)
    const basis = enumValue(input.attribution.basis, [
      'explicit_user_statement', 'user_correction', 'verified_tool_result', 'inference', 'imported_legacy', 'attributed_third_party', 'assistant_delivery_observation',
    ] as const, '$.attribution.basis', issues)
    if (actor && basis) attribution = { actor, basis }
  }
  const polarity = enumValue(input.polarity, ['positive', 'negative', 'unknown'] as const, '$.polarity', issues)
  const status = enumValue(input.status, ['candidate', 'accepted', 'disputed', 'superseded', 'retracted', 'deleted'] as const, '$.status', issues)
  const time = parseTimeSemantics(input.time, '$.time', issues)
  const evidence: EvidenceRef[] = []
  if (!Array.isArray(input.evidence)) issues.push(issue('$.evidence', 'invalid_type', 'Expected evidence references.'))
  else {
    if (input.evidence.length > MAX_EVIDENCE_REFS) issues.push(issue('$.evidence', 'too_large', 'Too many evidence references.'))
    for (const [index, candidate] of input.evidence.slice(0, MAX_EVIDENCE_REFS).entries()) {
      if (!isRecord(candidate)) {
        issues.push(issue(`$.evidence[${index}]`, 'invalid_type', 'Expected an evidence reference.'))
        continue
      }
      issues.push(...unknownFields(candidate, ['eventId', 'span', 'relation'], `$.evidence[${index}]`))
      const eventId = identifier<'event'>(candidate.eventId, 'Event ID', `$.evidence[${index}].eventId`, issues)
      const relation = enumValue(candidate.relation, ['supports', 'contradicts', 'derived_from'] as const, `$.evidence[${index}].relation`, issues)
      let span: SourceSpan | null = null
      if (candidate.span !== null) span = parseSourceSpan(candidate.span, `$.evidence[${index}].span`, issues)
      if (eventId && relation) evidence.push({ eventId, span, relation })
    }
  }
  const dependencies: DependencyRef[] = []
  if (!Array.isArray(input.dependencies)) issues.push(issue('$.dependencies', 'invalid_type', 'Expected dependency references.'))
  else {
    if (input.dependencies.length > MAX_DEPENDENCIES) issues.push(issue('$.dependencies', 'too_large', 'Too many dependencies.'))
    for (const [index, candidate] of input.dependencies.slice(0, MAX_DEPENDENCIES).entries()) {
      if (!isRecord(candidate)) {
        issues.push(issue(`$.dependencies[${index}]`, 'invalid_type', 'Expected a dependency reference.'))
        continue
      }
      issues.push(...unknownFields(candidate, ['type', 'id', 'revision'], `$.dependencies[${index}]`))
      const type = enumValue(candidate.type, ['event', 'assertion', 'projection', 'source'] as const, `$.dependencies[${index}].type`, issues)
      const dependencyId = stringValue(candidate.id, `$.dependencies[${index}].id`, issues, 160)
      const dependencyRevision = identifier<'revision'>(candidate.revision, 'Revision ID', `$.dependencies[${index}].revision`, issues)
      if (type && dependencyId && dependencyRevision) dependencies.push({ type, id: dependencyId, revision: dependencyRevision })
    }
  }
  if (!isRecord(input.producer)) issues.push(issue('$.producer', 'invalid_type', 'Expected producer version.'))
  let producer: ProducerVersion | null = null
  if (isRecord(input.producer)) {
    issues.push(...unknownFields(input.producer, ['name', 'version', 'model'], '$.producer'))
    const name = stringValue(input.producer.name, '$.producer.name', issues, 120)
    const version = stringValue(input.producer.version, '$.producer.version', issues, 120)
    const model = input.producer.model === null ? null : stringValue(input.producer.model, '$.producer.model', issues, 160)
    if (name && version) producer = { name, version, model }
  }
  let supersedes: ExactVersionRef | null | undefined
  if (input.supersedes !== undefined) {
    if (input.supersedes === null) {
      supersedes = null
    } else if (!isRecord(input.supersedes)) {
      issues.push(issue('$.supersedes', 'invalid_type', 'Expected an exact prior assertion version.'))
    } else {
      issues.push(...unknownFields(input.supersedes, ['assertionId', 'revision'], '$.supersedes'))
      const assertionId = identifier<'assertion'>(input.supersedes.assertionId, 'Assertion ID', '$.supersedes.assertionId', issues)
      const priorRevision = numberValue(input.supersedes.revision, '$.supersedes.revision', issues, 1)
      if (assertionId && priorRevision !== null) supersedes = { assertionId, revision: priorRevision }
    }
  }
  if (schemaVersion !== MEMORY_CONTRACT_VERSION || !id || revision === null || !scopeId || !subject || !kind || !parsedPayload || !attribution || !polarity || !status || !time || !producer) return invalid(issues)
  return parseResult({
    schemaVersion: MEMORY_CONTRACT_VERSION,
    id,
    revision,
    scopeId,
    subject,
    kind,
    payload: parsedPayload,
    attribution,
    polarity,
    status,
    time,
    evidence,
    dependencies,
    producer,
    ...(supersedes !== undefined ? { supersedes } : {}),
  }, issues)
}

function parseCommandId(value: unknown, path: string, issues: ContractIssue[]): string | null {
  return stringValue(value, path, issues, MAX_IDEMPOTENCY_KEY_LENGTH)
}

export function parsePublicMemoryCommand(input: unknown): ParseResult<PublicMemoryCommand> {
  const issues: ContractIssue[] = []
  if (!isRecord(input)) return invalid([issue('$', 'invalid_type', 'Expected a memory command object.')])
  rejectForbiddenPublicFields(input, '$', issues)
  const kind = enumValue(input.kind, ['remember', 'correct', 'forget', 'recall'] as const, '$.kind', issues)
  const schemaVersion = numberValue(input.schemaVersion, '$.schemaVersion', issues, MEMORY_CONTRACT_VERSION, MEMORY_CONTRACT_VERSION)
  const commandId = parseCommandId(input.commandId, '$.commandId', issues)
  if (kind === 'remember' || kind === 'correct') {
    const allowed = kind === 'remember'
      ? ['schemaVersion', 'commandId', 'kind', 'text', 'assertionKind', 'conditions', 'validTime', 'relation', 'polarity']
      : ['schemaVersion', 'commandId', 'kind', 'targetAssertionId', 'targetRevision', 'sourceRevision', 'text', 'assertionKind', 'conditions', 'validTime', 'relation', 'polarity']
    issues.push(...unknownFields(input, allowed, '$'))
    const text = stringValue(input.text, '$.text', issues, MAX_ASSERTION_TEXT_LENGTH)
    const assertionKind = enumValue(input.assertionKind, ['fact', 'preference', 'constraint', 'decision'] as const, '$.assertionKind', issues)
    const conditions = parseConditions(input.conditions, '$.conditions', issues)
    const validTime = input.validTime === undefined ? undefined : parseCommandValidTime(input.validTime, '$.validTime', issues)
    const parsedRelation = input.relation === undefined
      ? undefined
      : enumValue(input.relation, kind === 'remember' ? ['ordinary', 'temporary_exception'] as const : ['correction', 'transition', 'temporary_exception'] as const, '$.relation', issues)
    const relation = kind === 'remember'
      ? (parsedRelation === null ? undefined : parsedRelation as 'ordinary' | 'temporary_exception' | undefined)
      : (parsedRelation === null ? undefined : parsedRelation as 'correction' | 'transition' | 'temporary_exception' | undefined)
    const parsedPolarity = input.polarity === undefined ? undefined : enumValue(input.polarity, ['positive', 'negative', 'unknown'] as const, '$.polarity', issues)
    const polarity = parsedPolarity === null ? undefined : parsedPolarity
    let targetAssertionId: AssertionId | null = null
    let targetRevision: number | null = null
    let sourceRevision: RevisionId | null | undefined
    if (kind === 'correct') {
      targetAssertionId = identifier<'assertion'>(input.targetAssertionId, 'Assertion ID', '$.targetAssertionId', issues)
      targetRevision = numberValue(input.targetRevision, '$.targetRevision', issues, 1)
      sourceRevision = input.sourceRevision === undefined
        ? undefined
        : input.sourceRevision === null
          ? null
          : identifier<'revision'>(input.sourceRevision, 'Revision ID', '$.sourceRevision', issues)
    }
    if (schemaVersion === MEMORY_CONTRACT_VERSION && commandId && text && assertionKind && !issues.length) {
      if (kind === 'remember') {
        const rememberCommand: PublicRememberCommand = {
          schemaVersion: MEMORY_CONTRACT_VERSION,
          commandId,
          kind,
          text,
          assertionKind,
          conditions,
          ...(validTime !== undefined ? { validTime: validTime as ValidTime } : {}),
          ...(relation !== undefined ? { relation: relation as 'ordinary' | 'temporary_exception' } : {}),
          ...(polarity !== undefined ? { polarity } : {}),
        }
        return parseResult(rememberCommand, issues)
      }
      const correctCommand: PublicCorrectCommand = {
        schemaVersion: MEMORY_CONTRACT_VERSION,
        commandId,
        kind,
        targetAssertionId: targetAssertionId as AssertionId,
        targetRevision: targetRevision as number,
        ...(sourceRevision !== undefined ? { sourceRevision } : {}),
        text,
        assertionKind,
        conditions,
        ...(validTime !== undefined ? { validTime: validTime as ValidTime } : {}),
        ...(relation !== undefined ? { relation: relation as 'correction' | 'transition' | 'temporary_exception' } : {}),
        ...(polarity !== undefined ? { polarity } : {}),
      }
      return parseResult(correctCommand, issues)
    }
    return invalid(issues)
  }
  if (kind === 'forget') {
    issues.push(...unknownFields(input, ['schemaVersion', 'commandId', 'kind', 'targetAssertionId', 'targetRevision', 'query'], '$'))
    const targetAssertionId = input.targetAssertionId === null ? null : identifier<'assertion'>(input.targetAssertionId, 'Assertion ID', '$.targetAssertionId', issues)
    const targetRevision = input.targetRevision === undefined || input.targetRevision === null
      ? null
      : numberValue(input.targetRevision, '$.targetRevision', issues, 1)
    const query = input.query === null ? null : stringValue(input.query, '$.query', issues, 512)
    if (targetAssertionId === null && query === null) issues.push(issue('$', 'invalid_value', 'Forget needs an exact target or a query.'))
    if (targetAssertionId !== null && targetRevision === null) issues.push(issue('$.targetRevision', 'invalid_value', 'An exact forget target requires an exact revision.'))
    if (targetAssertionId === null && targetRevision !== null) issues.push(issue('$.targetRevision', 'inconsistent', 'A revision requires an exact assertion target.'))
    if (targetAssertionId !== null && query !== null) issues.push(issue('$', 'invalid_value', 'Choose an exact target or a query before creating a forget plan.'))
    if (schemaVersion === MEMORY_CONTRACT_VERSION && commandId && !issues.length) return parseResult({ schemaVersion: MEMORY_CONTRACT_VERSION, commandId, kind, targetAssertionId, targetRevision, query }, issues)
    return invalid(issues)
  }
  if (kind === 'recall') {
    issues.push(...unknownFields(input, ['schemaVersion', 'commandId', 'kind', 'query', 'limit'], '$'))
    const query = stringValue(input.query, '$.query', issues, 512)
    const limit = numberValue(input.limit, '$.limit', issues, 1, 20)
    if (schemaVersion === MEMORY_CONTRACT_VERSION && commandId && query && limit !== null) return parseResult({ schemaVersion: MEMORY_CONTRACT_VERSION, commandId, kind, query, limit }, issues)
  }
  return invalid(issues)
}

export function parseReceipt(input: unknown): ParseResult<MemoryReceipt> {
  const issues: ContractIssue[] = []
  if (!isRecord(input)) return invalid([issue('$', 'invalid_type', 'Expected a receipt object.')])
  const state = enumValue(input.state, ['captured', 'accepted', 'indexed', 'pending', 'failed'] as const, '$.state', issues)
  const schemaVersion = numberValue(input.schemaVersion, '$.schemaVersion', issues, MEMORY_CONTRACT_VERSION, MEMORY_CONTRACT_VERSION)
  const receiptId = stringValue(input.receiptId, '$.receiptId', issues, 160)
  const receivedAt = instant(input.receivedAt, '$.receivedAt', issues)
  const eventId = input.eventId === null ? null : identifier<'event'>(input.eventId, 'Event ID', '$.eventId', issues)
  if (state === 'failed') {
    issues.push(...unknownFields(input, ['schemaVersion', 'receiptId', 'eventId', 'receivedAt', 'ok', 'state', 'canonicalRevision', 'indexWatermark', 'failure'], '$'))
    if (input.ok !== false) issues.push(issue('$.ok', 'inconsistent', 'Failed receipts must have ok=false.'))
    if (input.canonicalRevision !== null || input.indexWatermark !== null) issues.push(issue('$', 'inconsistent', 'Failed receipts cannot claim a revision or index watermark.'))
    let failure: MemoryFailure | null = null
    if (!isRecord(input.failure)) issues.push(issue('$.failure', 'invalid_type', 'Failed receipts require a typed failure.'))
    else {
      issues.push(...unknownFields(input.failure, ['code', 'message', 'retryable', 'details'], '$.failure'))
      const code = enumValue(input.failure.code, ['unauthorized', 'conflict', 'ambiguous', 'unavailable', 'budget_exhausted', 'validation', 'not_found', 'suppressed'] as const, '$.failure.code', issues)
      const message = stringValue(input.failure.message, '$.failure.message', issues, 240)
      if (typeof input.failure.retryable !== 'boolean') issues.push(issue('$.failure.retryable', 'invalid_type', 'Expected a boolean.'))
      let details: Record<string, string | number | boolean> | undefined
      if (input.failure.details !== undefined) {
        if (!isRecord(input.failure.details)) issues.push(issue('$.failure.details', 'invalid_type', 'Failure details must be a flat object.'))
        else {
          const entries = Object.entries(input.failure.details)
          if (entries.length > 8) issues.push(issue('$.failure.details', 'too_large', 'Failure details are bounded to eight fields.'))
          details = {}
          for (const [key, value] of entries.slice(0, 8)) {
            if (typeof value === 'string' && value.length <= 160) details[key] = value
            else if (typeof value === 'number' && Number.isFinite(value)) details[key] = value
            else if (typeof value === 'boolean') details[key] = value
            else issues.push(issue(`$.failure.details.${key}`, 'invalid_value', 'Failure details must be bounded scalar values.'))
          }
        }
      }
      if (code && message && typeof input.failure.retryable === 'boolean') {
        failure = { code, message, retryable: input.failure.retryable, ...(details ? { details } : {}) }
      }
    }
    if (schemaVersion === MEMORY_CONTRACT_VERSION && receiptId && receivedAt && failure && !issues.length) {
      return parseResult({ schemaVersion: MEMORY_CONTRACT_VERSION, receiptId, eventId, receivedAt, ok: false, state, canonicalRevision: null, indexWatermark: null, failure }, issues)
    }
  } else {
    issues.push(...unknownFields(input, ['schemaVersion', 'receiptId', 'eventId', 'receivedAt', 'ok', 'state', 'canonicalRevision', 'indexWatermark', 'pendingReason'], '$'))
    if (input.ok !== true) issues.push(issue('$.ok', 'inconsistent', 'Successful receipts must have ok=true.'))
    const canonicalRevision = input.canonicalRevision === null ? null : identifier<'revision'>(input.canonicalRevision, 'Revision ID', '$.canonicalRevision', issues)
    const indexWatermark = input.indexWatermark === null ? null : stringValue(input.indexWatermark, '$.indexWatermark', issues, 160)
    if (state === 'captured' || state === 'pending') {
      if (canonicalRevision !== null || indexWatermark !== null) issues.push(issue('$', 'inconsistent', `${state} receipts cannot claim a canonical revision or index watermark.`))
    }
    if (state === 'accepted' && (canonicalRevision === null || indexWatermark !== null)) issues.push(issue('$', 'inconsistent', 'Accepted receipts require only a canonical revision.'))
    if (state === 'indexed' && (canonicalRevision === null || indexWatermark === null)) issues.push(issue('$', 'inconsistent', 'Indexed receipts require a revision and watermark.'))
    if (state === 'pending') enumValue(input.pendingReason, ['interpretation', 'indexing', 'provider'] as const, '$.pendingReason', issues)
    if (schemaVersion === MEMORY_CONTRACT_VERSION && receiptId && receivedAt && state && !issues.length) {
      if (state === 'captured') return parseResult({ schemaVersion: MEMORY_CONTRACT_VERSION, receiptId, eventId, receivedAt, ok: true, state, canonicalRevision: null, indexWatermark: null }, issues)
      if (state === 'pending') return parseResult({ schemaVersion: MEMORY_CONTRACT_VERSION, receiptId, eventId, receivedAt, ok: true, state, canonicalRevision: null, indexWatermark: null, pendingReason: input.pendingReason as 'interpretation' | 'indexing' | 'provider' }, issues)
      if (state === 'accepted') return parseResult({ schemaVersion: MEMORY_CONTRACT_VERSION, receiptId, eventId, receivedAt, ok: true, state, canonicalRevision: canonicalRevision as RevisionId, indexWatermark: null }, issues)
      return parseResult({ schemaVersion: MEMORY_CONTRACT_VERSION, receiptId, eventId, receivedAt, ok: true, state, canonicalRevision: canonicalRevision as RevisionId, indexWatermark: indexWatermark as string }, issues)
    }
  }
  return invalid(issues)
}

export function sourceBasisFor(sourceKind: EventSourceKind, actor: ActorRef, subject: ClaimSubject): SourceBasis {
  if (sourceKind === 'user_correction') return 'user_correction'
  if (sourceKind === 'verified_tool_result') return 'verified_tool_result'
  if (sourceKind === 'imported_legacy') return 'imported_legacy'
  if (sourceKind === 'quoted_third_party' || sourceKind === 'third_party_document' || actor.kind === 'third_party') return 'attributed_third_party'
  if (sourceKind === 'assistant_played' || sourceKind === 'assistant_displayed' || sourceKind === 'assistant_acknowledged') return 'assistant_delivery_observation'
  if (sourceKind === 'model_inference') return 'inference'
  if (sourceKind === 'user_statement' && actor.kind === 'principal' && subject.kind === 'known' && String(actor.principalId) === String(subject.subjectId)) return 'explicit_user_statement'
  return 'inference'
}

export function isSelfClaim(actor: ActorRef, subject: ClaimSubject): boolean {
  return actor.kind === 'principal' && subject.kind === 'known' && String(actor.principalId) === String(subject.subjectId)
}

/**
 * A self-authored event is not automatically a durable self-assertion. The
 * explicit mode markers are supplied by the trusted command/capture path, not
 * inferred from retrieved text. Hypotheticals, role-play, and quotations stay
 * conversation evidence until a later committed statement says otherwise.
 */
export function sourceCanEstablishSelfAssertion(
  sourceKind: EventSourceKind,
  actor: ActorRef,
  subject: ClaimSubject,
  eventPayload: BoundedPayload = {},
): boolean {
  if (!isSelfClaim(actor, subject)) return false
  if (sourceKind !== 'user_statement' && sourceKind !== 'user_correction') return false
  const mode = eventPayload.mode
  return mode !== 'hypothetical' && mode !== 'role_play' && mode !== 'quotation'
}

export function sourceCanEstablishAssistantText(sourceKind: EventSourceKind, authority: SourceAuthority): boolean {
  return sourceKind === 'assistant_generated' && authority.kind === 'server_generated'
}

export function evaluateGrant(
  session: Pick<MemorySession, 'scope' | 'grants' | 'trust'>,
  action: MemoryAction,
  requestedScope: ScopeId | null = null,
): { allowed: true } | { allowed: false; failure: MemoryFailure } {
  if (session.trust !== 'authenticated' && requestedScope && requestedScope !== session.scope.id) {
    return { allowed: false, failure: { code: 'unauthorized', message: 'That scope is not available to this session.', retryable: false } }
  }
  const scopeId = requestedScope ?? session.scope.id
  const grant = session.grants.find((candidate) => candidate.scopeId === scopeId && candidate.actions.includes(action) && (!candidate.expiresAt || Date.parse(candidate.expiresAt) > Date.now()))
  return grant
    ? { allowed: true }
    : { allowed: false, failure: { code: 'unauthorized', message: 'This session is not authorized for that memory operation.', retryable: false } }
}

export function bindMemoryCommand(session: MemorySession, command: PublicMemoryCommand): ParseResult<BoundMemoryCommand> {
  const decision = evaluateGrant(session, command.kind === 'recall' ? 'recall' : command.kind, session.scope.id)
  if (!decision.allowed) return { ok: false, error: new MemoryContractError([{ path: '$', code: 'unsafe_field', message: decision.failure.message }]) }
  return {
    ok: true,
    value: {
      schemaVersion: MEMORY_CONTRACT_VERSION,
      command,
      principalId: session.principal.id,
      subject: session.subject,
      scope: session.scope,
      sourceAuthority: { kind: session.authority === 'ephemeral_request' ? 'client_report' : 'authenticated_user', revision: `policy-${session.policyEpoch}` as RevisionId },
      policyEpoch: session.policyEpoch,
    },
  }
}

/** Validate the serializable identity/policy descriptor, never a storage handle. */
export function parseSessionDescriptor(input: unknown): ParseResult<MemorySessionDescriptor> {
  const issues: ContractIssue[] = []
  if (!isRecord(input)) return invalid([issue('$', 'invalid_type', 'Expected a memory session.')])
  // A storage handle is intentionally not part of the wire descriptor. Only a
  // trusted server resolver may attach one to a MemorySession.
  issues.push(...unknownFields(input, ['schemaVersion', 'trust', 'authority', 'principal', 'client', 'subject', 'scope', 'grants', 'policyEpoch'], '$'))
  const schemaVersion = numberValue(input.schemaVersion, '$.schemaVersion', issues, MEMORY_CONTRACT_VERSION, MEMORY_CONTRACT_VERSION)
  const trust = enumValue(input.trust, ['authenticated', 'ephemeral'] as const, '$.trust', issues)
  const authority = enumValue(input.authority, ['node_signed_cookie', 'worker_auth_session', 'worker_internal_owner', 'ephemeral_request'] as const, '$.authority', issues)
  if (!isRecord(input.principal)) issues.push(issue('$.principal', 'invalid_type', 'Expected principal.'))
  let principal: Principal | null = null
  if (isRecord(input.principal)) {
    issues.push(...unknownFields(input.principal, ['id', 'kind', 'trust'], '$.principal'))
    const id = identifier<'principal'>(input.principal.id, 'Principal ID', '$.principal.id', issues)
    const kind = enumValue(input.principal.kind, ['anonymous', 'user', 'service'] as const, '$.principal.kind', issues)
    const principalTrust = enumValue(input.principal.trust, ['authenticated', 'ephemeral'] as const, '$.principal.trust', issues)
    if (id && kind && principalTrust) principal = { id, kind, trust: principalTrust }
  }
  if (!isRecord(input.client)) issues.push(issue('$.client', 'invalid_type', 'Expected client context.'))
  let client: ClientContext | null = null
  if (isRecord(input.client)) {
    issues.push(...unknownFields(input.client, ['id', 'channel', 'connectionRevision'], '$.client'))
    const id = identifier<'client'>(input.client.id, 'Client ID', '$.client.id', issues)
    const channel = enumValue(input.client.channel, ['http', 'websocket', 'worker_http', 'worker_websocket', 'test'] as const, '$.client.channel', issues)
    const connectionRevision = input.client.connectionRevision === null ? null : stringValue(input.client.connectionRevision, '$.client.connectionRevision', issues, 160)
    if (id && channel) client = { id, channel, connectionRevision }
  }
  const subject = parseSubject(input.subject, '$.subject', issues)
  if (!isRecord(input.scope)) issues.push(issue('$.scope', 'invalid_type', 'Expected scope.'))
  let scope: Scope | null = null
  if (isRecord(input.scope)) {
    issues.push(...unknownFields(input.scope, ['id', 'kind', 'parentId'], '$.scope'))
    const id = identifier<'scope'>(input.scope.id, 'Scope ID', '$.scope.id', issues)
    const kind = enumValue(input.scope.kind, ['account', 'project', 'conversation', 'task', 'global'] as const, '$.scope.kind', issues)
    const parentId = input.scope.parentId === null ? null : identifier<'scope'>(input.scope.parentId, 'Scope ID', '$.scope.parentId', issues)
    if (id && kind) scope = { id, kind, parentId }
  }
  const grants: Grant[] = []
  if (!Array.isArray(input.grants)) issues.push(issue('$.grants', 'invalid_type', 'Expected grants.'))
  else {
    if (input.grants.length > MAX_GRANTS) issues.push(issue('$.grants', 'too_large', 'Too many grants.'))
    for (const [index, candidate] of input.grants.slice(0, MAX_GRANTS).entries()) {
      if (!isRecord(candidate)) {
        issues.push(issue(`$.grants[${index}]`, 'invalid_type', 'Expected a grant.'))
        continue
      }
      issues.push(...unknownFields(candidate, ['id', 'scopeId', 'actions', 'issuedBy', 'expiresAt'], `$.grants[${index}]`))
      const id = identifier<'grant'>(candidate.id, 'Grant ID', `$.grants[${index}].id`, issues)
      const scopeId = identifier<'scope'>(candidate.scopeId, 'Scope ID', `$.grants[${index}].scopeId`, issues)
      const issuedBy = enumValue(candidate.issuedBy, ['server_policy'] as const, `$.grants[${index}].issuedBy`, issues)
      const expiresAt = candidate.expiresAt === null ? null : instant(candidate.expiresAt, `$.grants[${index}].expiresAt`, issues)
      const actions: MemoryAction[] = []
      if (!Array.isArray(candidate.actions)) issues.push(issue(`$.grants[${index}].actions`, 'invalid_type', 'Expected grant actions.'))
      else for (const [actionIndex, action] of candidate.actions.entries()) {
        const parsed = enumValue(action, ['capture', 'read', 'remember', 'correct', 'forget', 'recall', 'inspect', 'export'] as const, `$.grants[${index}].actions[${actionIndex}]`, issues)
        if (parsed && !actions.includes(parsed)) actions.push(parsed)
      }
      if (id && scopeId && issuedBy) grants.push({ id, scopeId, actions, issuedBy, expiresAt })
    }
  }
  const policyEpoch = numberValue(input.policyEpoch, '$.policyEpoch', issues, 0)
  if (principal && trust && principal.trust !== trust) issues.push(issue('$.principal.trust', 'inconsistent', 'Principal and session trust must agree.'))
  if (principal && authority && ((trust === 'authenticated') !== (authority !== 'ephemeral_request'))) issues.push(issue('$.authority', 'inconsistent', 'Session authority does not match trust.'))
  if (schemaVersion !== MEMORY_CONTRACT_VERSION || !trust || !authority || !principal || !client || !subject || !scope || policyEpoch === null) return invalid(issues)
  return parseResult({ schemaVersion: MEMORY_CONTRACT_VERSION, trust, authority, principal, client, subject, scope, grants, policyEpoch }, issues)
}
