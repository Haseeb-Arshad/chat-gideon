import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryError } from './contract.ts'
import { normalizeText, sha256, terms } from './text.ts'

/**
 * Optional verified procedural memory (Stage 17).
 *
 * A procedure is a declarative, versioned description of how a task was
 * done, learned only from episodes whose outcome was actually observed. It is
 * advice: it never runs, never grants a tool or a destination, and cannot
 * touch memory policy (identity, retention, authorization, extraction).
 *
 * candidate ──review──▶ reviewed ──independent verification──▶ verified
 *     verified ──newer verified──▶ superseded      verified ──rollback──▶ rolled_back
 *     any ──supporting evidence deleted──▶ invalidated
 */

export const PROCEDURE_MANIFEST_VERSION = 1
const PROCEDURE_STORE_VERSION = 1

export type ObservedBy = 'tool_result' | 'external_check' | 'assistant_claim' | 'user_silence'
export type OutcomeStatus = 'succeeded' | 'failed' | 'inconclusive'
export type VersionStatus = 'candidate' | 'reviewed' | 'verified' | 'superseded' | 'rolled_back' | 'invalidated' | 'rejected'

export interface Precondition { id: string; fact: string; op: 'eq' | 'neq' | 'gte' | 'lte' | 'present' | 'absent'; value?: string | number | boolean; description: string }
export interface ProcedureStep { id: string; instruction: string; capability?: string }

export interface ProcedureManifest {
  manifestVersion: 1
  kind: 'task'
  name: string
  trigger: { intent: string; keywords: string[] }
  inputs: { name: string; description: string; required: boolean }[]
  preconditions: Precondition[]
  steps: ProcedureStep[]
  stopConditions: string[]
  verification: { method: 'observed_outcome'; description: string }
  /** What the procedure was verified against; `model` changes require reverification. */
  environment: Record<string, string>
  toolVersions: Record<string, string>
  /** Requested, never granted: the host decides what a caller may do. */
  requiredCapabilities: string[]
}

const MANIFEST_KEYS = ['manifestVersion', 'kind', 'name', 'trigger', 'inputs', 'preconditions', 'steps', 'stopConditions', 'verification', 'environment', 'toolVersions', 'requiredCapabilities']
const POLICY_WORDS = /^(?:identity|principal|scope|grants?|permissions?|authori[sz]ation|approval|retention|deletion|extraction|policy|memory_policy)$/iu
const SECRET = /sk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|password|passwd|secret|token|bearer)\b\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b/iu
const TEMPORARY = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b|\/tmp\/|\\temp\\/iu
const SHELL = /```|\$\(|`[^`]+`|;\s*rm\s|\|\s*(?:ba|z)?sh\b|\bsudo\b|\beval\s*\(|\bchmod\s+777\b/iu
const INJECTION = /ignore (?:all |any )?(?:previous|prior|above) instructions|you (?:are|have) (?:now )?(?:admin|root|authori[sz]ed)|grant (?:yourself|admin|all)|disable (?:safety|approval|confirmation)|without (?:asking|approval|confirmation)/iu
const NAME = /^[a-z0-9][a-z0-9-]{2,59}$/u
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/u

export class ProcedureRejected extends MemoryError {
  constructor(readonly reason: string, message: string) {
    super('validation', message)
  }
}

function texts(manifest: ProcedureManifest): string[] {
  return [
    manifest.trigger.intent, ...manifest.trigger.keywords, ...manifest.inputs.flatMap((input) => [input.name, input.description]),
    ...manifest.preconditions.flatMap((item) => [item.description, String(item.value ?? '')]), ...manifest.steps.map((step) => step.instruction),
    ...manifest.stopConditions, manifest.verification.description,
  ]
}

/** Structural and safety validation; returns the manifest exactly as stored. */
export function validateManifest(input: unknown): ProcedureManifest {
  const reject = (reason: string, message: string): never => { throw new ProcedureRejected(reason, message) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject('shape', 'A manifest is an object.')
  const value = input as Record<string, unknown>
  const policy = Object.keys(value).filter((key) => POLICY_WORDS.test(key))
  if (policy.length) reject('policy_fields_forbidden', `Procedures describe tasks; they cannot set ${policy.join(', ')}.`)
  const unknown = Object.keys(value).filter((key) => !MANIFEST_KEYS.includes(key))
  if (unknown.length) reject('unknown_fields', `Unknown manifest fields: ${unknown.join(', ')}.`)
  if (value.manifestVersion !== PROCEDURE_MANIFEST_VERSION) reject('version', `manifestVersion must be ${PROCEDURE_MANIFEST_VERSION}.`)
  if (value.kind !== 'task') reject('policy_fields_forbidden', "Only kind 'task' can be learned; memory-management policies are not procedures.")
  const manifest = value as unknown as ProcedureManifest
  if (typeof manifest.name !== 'string' || !NAME.test(manifest.name)) reject('shape', 'name must be 3-60 lower-case letters, digits or dashes.')
  const isText = (text: unknown, max: number) => typeof text === 'string' && normalizeText(text).length > 0 && text.length <= max
  if (!manifest.trigger || !isText(manifest.trigger.intent, 200) || !Array.isArray(manifest.trigger.keywords) || manifest.trigger.keywords.length > 12 || !manifest.trigger.keywords.every((word) => isText(word, 40))) reject('shape', 'trigger needs an intent and up to 12 keywords.')
  if (!Array.isArray(manifest.inputs) || manifest.inputs.length > 12 || !manifest.inputs.every((item) => ID.test(item?.name) && isText(item.description, 200) && typeof item.required === 'boolean')) reject('shape', 'inputs are up to 12 named, described entries.')
  if (!Array.isArray(manifest.preconditions) || manifest.preconditions.length > 12 || !manifest.preconditions.every((item) => ID.test(item?.id) && ID.test(item.fact) && ['eq', 'neq', 'gte', 'lte', 'present', 'absent'].includes(item.op) && isText(item.description, 200))) reject('shape', 'preconditions are up to 12 declarative checks.')
  if (!Array.isArray(manifest.steps) || !manifest.steps.length || manifest.steps.length > 20 || !manifest.steps.every((step) => ID.test(step?.id) && isText(step.instruction, 400) && (step.capability === undefined || ID.test(step.capability)))) reject('shape', 'steps are 1-20 short instructions.')
  if (!Array.isArray(manifest.stopConditions) || manifest.stopConditions.length > 10 || !manifest.stopConditions.every((item) => isText(item, 200))) reject('shape', 'stopConditions are up to 10 short sentences.')
  if (manifest.verification?.method !== 'observed_outcome' || !isText(manifest.verification.description, 300)) reject('shape', 'verification must describe an observed outcome.')
  for (const field of ['environment', 'toolVersions'] as const) {
    const record = manifest[field]
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length > 12 || !Object.entries(record).every(([key, item]) => ID.test(key) && isText(item, 60))) reject('shape', `${field} is up to 12 short key/value pairs.`)
  }
  if (!Array.isArray(manifest.requiredCapabilities) || manifest.requiredCapabilities.length > 12 || !manifest.requiredCapabilities.every((item) => ID.test(item))) reject('shape', 'requiredCapabilities are up to 12 capability names.')
  const undeclared = manifest.steps.filter((step) => step.capability && !manifest.requiredCapabilities.includes(step.capability))
  if (undeclared.length) reject('shape', `Steps use undeclared capabilities: ${undeclared.map((step) => step.capability).join(', ')}.`)
  const all = texts(manifest)
  if (all.some((text) => SECRET.test(text))) reject('credential', 'A procedure may not contain credentials.')
  if (all.some((text) => TEMPORARY.test(text))) reject('temporary_id', 'A procedure may not contain temporary ids or paths; make them inputs.')
  if (all.some((text) => SHELL.test(text))) reject('shell', 'Steps are instructions, not scripts to run.')
  if (all.some((text) => INJECTION.test(text))) reject('instruction_injection', 'A procedure may not instruct the assistant to bypass instructions, approval or authorization.')
  return JSON.parse(JSON.stringify(manifest)) as ProcedureManifest
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proc_scopes (scope_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proc_episodes (
  scope_id TEXT NOT NULL REFERENCES proc_scopes(scope_id), episode_id TEXT NOT NULL, task_id TEXT NOT NULL,
  summary TEXT NULL, output TEXT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'inconclusive')),
  observed_by TEXT NOT NULL CHECK (observed_by IN ('tool_result', 'external_check', 'assistant_claim', 'user_silence')),
  evidence_ref TEXT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, episode_id)
);
CREATE TABLE IF NOT EXISTS proc_versions (
  scope_id TEXT NOT NULL REFERENCES proc_scopes(scope_id), name TEXT NOT NULL, version INTEGER NOT NULL,
  manifest TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, status_reason TEXT NULL,
  PRIMARY KEY (scope_id, name, version)
);
CREATE TABLE IF NOT EXISTS proc_sources (
  scope_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, episode_id TEXT NOT NULL,
  PRIMARY KEY (scope_id, name, version, episode_id),
  FOREIGN KEY (scope_id, name, version) REFERENCES proc_versions(scope_id, name, version),
  FOREIGN KEY (scope_id, episode_id) REFERENCES proc_episodes(scope_id, episode_id)
);
CREATE TABLE IF NOT EXISTS proc_reviews (
  scope_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, reviewer TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')), note TEXT NOT NULL, at TEXT NOT NULL,
  FOREIGN KEY (scope_id, name, version) REFERENCES proc_versions(scope_id, name, version)
);
CREATE TABLE IF NOT EXISTS proc_verifications (
  scope_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, verifier TEXT NOT NULL, variant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('held_out_variant', 'negative_precondition')),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'inconclusive')),
  observed_by TEXT NOT NULL, answer_key TEXT NULL, at TEXT NOT NULL,
  FOREIGN KEY (scope_id, name, version) REFERENCES proc_versions(scope_id, name, version)
);
CREATE TABLE IF NOT EXISTS proc_adoptions (
  scope_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NULL,
  decision TEXT NOT NULL CHECK (decision IN ('adopt', 'reject', 'defer')), reason TEXT NOT NULL, metrics TEXT NULL, at TEXT NOT NULL
);
`

export interface EpisodeInput {
  episodeId: string
  /** Groups variants of one task; verification variants must differ from every source's task. */
  taskId: string
  summary: string
  /** Task-specific output (never copied into a procedure). */
  output?: string
  outcome: OutcomeStatus
  observedBy: ObservedBy
  /** Reference to the tool result or external check that observed the outcome. */
  evidenceRef?: string
}

export interface AdviceRequest {
  task: string
  environment: Record<string, string>
  toolVersions?: Record<string, string>
  facts?: Record<string, string | number | boolean>
  /** What the host actually lets this caller do. Advice never adds to it. */
  capabilities: readonly string[]
}

export type Compatibility = 'compatible' | 'incompatible' | 'needs_reverification'

export interface Advice {
  name: string
  version: number
  advisory: true
  compatibility: Compatibility
  compatibilityNotes: string[]
  preconditions: { id: string; result: 'met' | 'unmet' | 'unknown'; description: string }[]
  /** Capabilities the procedure asks for that this caller does not have; they are not granted. */
  missingCapabilities: string[]
  usable: boolean
  steps: ProcedureStep[]
  stopConditions: string[]
  verifiedAgainst: Record<string, string>
}

function evaluate(pre: Precondition, facts: Record<string, string | number | boolean>): 'met' | 'unmet' | 'unknown' {
  const fact = facts[pre.fact]
  if (pre.op === 'present') return fact === undefined ? 'unmet' : 'met'
  if (pre.op === 'absent') return fact === undefined ? 'met' : 'unmet'
  if (fact === undefined) return 'unknown'
  if (pre.op === 'eq') return String(fact) === String(pre.value) ? 'met' : 'unmet'
  if (pre.op === 'neq') return String(fact) !== String(pre.value) ? 'met' : 'unmet'
  const left = Number(fact)
  const right = Number(pre.value)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 'unknown'
  return (pre.op === 'gte' ? left >= right : left <= right) ? 'met' : 'unmet'
}

const major = (version: string) => version.split('.')[0]

export function compatibility(manifest: ProcedureManifest, request: Pick<AdviceRequest, 'environment' | 'toolVersions'>): { result: Compatibility; notes: string[] } {
  const notes: string[] = []
  let result: Compatibility = 'compatible'
  const worsen = (next: Compatibility) => {
    if (next === 'incompatible' || (next === 'needs_reverification' && result === 'compatible')) result = next
  }
  for (const [key, expected] of Object.entries(manifest.environment)) {
    const actual = request.environment[key]
    if (actual === undefined) { worsen('needs_reverification'); notes.push(`${key} unknown here (verified with ${expected})`) }
    else if (actual !== expected) {
      // A different model can follow the same steps differently: reverify, do not refuse outright.
      worsen(key === 'model' ? 'needs_reverification' : 'incompatible')
      notes.push(`${key} is ${actual}; verified with ${expected}`)
    }
  }
  for (const [tool, version] of Object.entries(manifest.toolVersions)) {
    const actual = request.toolVersions?.[tool]
    if (actual === undefined) { worsen('needs_reverification'); notes.push(`${tool} version unknown (verified with ${version})`) }
    else if (major(actual) !== major(version)) { worsen('incompatible'); notes.push(`${tool} ${actual}; verified with ${version}`) }
  }
  return { result, notes }
}

/** Advice for one manifest in one request; the same check the store applies at recall. */
export function adviceFromManifest(name: string, version: number, manifest: ProcedureManifest, request: AdviceRequest): Advice {
  const compatible = compatibility(manifest, request)
  const preconditions = manifest.preconditions.map((pre) => ({ id: pre.id, result: evaluate(pre, request.facts ?? {}), description: pre.description }))
  const missingCapabilities = manifest.requiredCapabilities.filter((capability) => !request.capabilities.includes(capability))
  return {
    name, version, advisory: true,
    compatibility: compatible.result, compatibilityNotes: compatible.notes, preconditions, missingCapabilities,
    usable: compatible.result === 'compatible' && preconditions.every((pre) => pre.result === 'met') && missingCapabilities.length === 0,
    steps: manifest.steps, stopConditions: manifest.stopConditions, verifiedAgainst: { ...manifest.environment, ...manifest.toolVersions },
  }
}

export class SqliteProcedureStore {
  readonly db: DatabaseSync
  constructor(options: { path: string }) {
    if (options.path !== ':memory:') {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
      if (!existsSync(options.path)) closeSync(openSync(options.path, 'a', 0o600))
    }
    this.db = new DatabaseSync(options.path)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    if (options.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.write(() => {
      this.db.exec(SCHEMA)
      const stored = this.db.prepare("SELECT value FROM proc_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (!stored) this.db.prepare("INSERT INTO proc_meta (key, value) VALUES ('schema_version', ?)").run(String(PROCEDURE_STORE_VERSION))
      else if (Number(stored.value) !== PROCEDURE_STORE_VERSION) throw new MemoryError('unsupported', `Procedure store schema ${stored.value} is not ${PROCEDURE_STORE_VERSION}.`)
    })
  }

  write<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}

export interface InspectedVersion {
  version: number
  status: VersionStatus
  statusReason: string | null
  createdBy: string
  createdAt: string
  manifest: ProcedureManifest
  sources: { episodeId: string; outcome: OutcomeStatus; observedBy: ObservedBy; deleted: boolean }[]
  reviews: { reviewer: string; decision: string; note: string; at: string }[]
  verifications: { verifier: string; variantId: string; kind: string; outcome: string; observedBy: string; at: string }[]
}

/** One owner's procedures; built by the host from its own identity, like openMemory. */
export class ScopedProcedures {
  constructor(private readonly store: SqliteProcedureStore, readonly scopeId: string, readonly principalId: string) {}

  private get db() { return this.store.db }

  private bind(create: boolean): boolean {
    const row = this.db.prepare('SELECT principal_id FROM proc_scopes WHERE scope_id = ?').get(this.scopeId) as { principal_id: string } | undefined
    if (row && row.principal_id !== this.principalId) throw new MemoryError('unauthorized', 'These procedures belong to another principal.')
    if (!row && create) this.db.prepare('INSERT INTO proc_scopes (scope_id, principal_id) VALUES (?, ?)').run(this.scopeId, this.principalId)
    return Boolean(row) || create
  }

  private now(): string { return new Date().toISOString() }

  recordEpisode(input: EpisodeInput): void {
    if (!ID.test(input.episodeId) || !ID.test(input.taskId)) throw new MemoryError('validation', 'episodeId and taskId must be short ids.')
    this.store.write(() => {
      this.bind(true)
      this.db.prepare(`INSERT INTO proc_episodes (scope_id, episode_id, task_id, summary, output, outcome, observed_by, evidence_ref, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.scopeId, input.episodeId, input.taskId, input.summary.slice(0, 1_000), input.output?.slice(0, 2_000) ?? null, input.outcome, input.observedBy, input.evidenceRef ?? null, this.now())
    })
  }

  /**
   * A candidate needs at least one source episode whose success was observed
   * by a tool result or an external check. An assistant saying it worked, or
   * the user saying nothing, is not evidence. Task outputs from the sources
   * may not appear in the manifest.
   */
  propose(input: { manifest: unknown; sourceEpisodes: string[]; createdBy: string }): { name: string; version: number } {
    const manifest = validateManifest(input.manifest)
    if (!input.sourceEpisodes.length) throw new ProcedureRejected('no_evidence', 'A procedure needs source episodes.')
    return this.store.write(() => {
      this.bind(true)
      const episodes = input.sourceEpisodes.map((id) => this.db.prepare('SELECT episode_id, output, outcome, observed_by, evidence_ref, deleted FROM proc_episodes WHERE scope_id = ? AND episode_id = ?').get(this.scopeId, id) as { episode_id: string; output: string | null; outcome: string; observed_by: string; evidence_ref: string | null; deleted: number } | undefined)
      if (episodes.some((item) => !item || item.deleted)) throw new ProcedureRejected('no_evidence', 'Every source episode must exist and not be deleted.')
      const eligible = episodes.filter((item) => item!.outcome === 'succeeded' && (item!.observed_by === 'tool_result' || item!.observed_by === 'external_check') && item!.evidence_ref)
      if (!eligible.length) throw new ProcedureRejected('unverified_claim', 'No source shows an observed success; assistant claims and silence do not count.')
      const body = texts(manifest).map((text) => normalizeText(text).toLocaleLowerCase('und')).join('\n')
      for (const item of episodes) {
        const output = normalizeText(item!.output ?? '').toLocaleLowerCase('und')
        if (output.length >= 4 && body.includes(output)) throw new ProcedureRejected('task_specific_output', 'A procedure may not carry a source task’s specific output; make it an input.')
      }
      const last = this.db.prepare('SELECT max(version) AS version FROM proc_versions WHERE scope_id = ? AND name = ?').get(this.scopeId, manifest.name) as { version: number | null }
      const version = (last.version ?? 0) + 1
      this.db.prepare("INSERT INTO proc_versions (scope_id, name, version, manifest, status, created_by, created_at) VALUES (?, ?, ?, ?, 'candidate', ?, ?)").run(this.scopeId, manifest.name, version, JSON.stringify(manifest), input.createdBy, this.now())
      for (const item of episodes) this.db.prepare('INSERT INTO proc_sources (scope_id, name, version, episode_id) VALUES (?, ?, ?, ?)').run(this.scopeId, manifest.name, version, item!.episode_id)
      return { name: manifest.name, version }
    })
  }

  private status(name: string, version: number): { status: VersionStatus; created_by: string; manifest: string } {
    const row = this.db.prepare('SELECT status, created_by, manifest FROM proc_versions WHERE scope_id = ? AND name = ? AND version = ?').get(this.scopeId, name, version) as { status: VersionStatus; created_by: string; manifest: string } | undefined
    if (!row) throw new MemoryError('not_found', 'No such procedure version.')
    return row
  }

  review(input: { name: string; version: number; reviewer: string; decision: 'approve' | 'reject'; note: string }): VersionStatus {
    return this.store.write(() => {
      this.bind(false)
      const row = this.status(input.name, input.version)
      if (row.status !== 'candidate') throw new MemoryError('conflict', `Only a candidate can be reviewed (this is ${row.status}).`)
      if (input.reviewer === row.created_by) throw new MemoryError('conflict', 'The author cannot review their own procedure.')
      this.db.prepare('INSERT INTO proc_reviews (scope_id, name, version, reviewer, decision, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(this.scopeId, input.name, input.version, input.reviewer, input.decision, input.note.slice(0, 500), this.now())
      const next: VersionStatus = input.decision === 'approve' ? 'reviewed' : 'rejected'
      this.db.prepare('UPDATE proc_versions SET status = ? WHERE scope_id = ? AND name = ? AND version = ?').run(next, this.scopeId, input.name, input.version)
      return next
    })
  }

  /**
   * An independent check of one variant. `inconclusive` is recorded as such
   * and never counts as a pass. `answerKey` is the variant's expected output,
   * kept to prove it did not leak into the procedure.
   */
  recordVerification(input: { name: string; version: number; verifier: string; variantId: string; kind: 'held_out_variant' | 'negative_precondition'; outcome: 'passed' | 'failed' | 'inconclusive'; observedBy: ObservedBy; answerKey?: string }): void {
    this.store.write(() => {
      this.bind(false)
      const row = this.status(input.name, input.version)
      if (input.verifier === row.created_by) throw new MemoryError('conflict', 'Verification must be independent of the author.')
      const sourceTasks = (this.db.prepare('SELECT e.task_id FROM proc_sources s JOIN proc_episodes e ON e.scope_id = s.scope_id AND e.episode_id = s.episode_id WHERE s.scope_id = ? AND s.name = ? AND s.version = ?').all(this.scopeId, input.name, input.version) as { task_id: string }[]).map((item) => item.task_id)
      if (sourceTasks.includes(input.variantId)) throw new MemoryError('conflict', 'A held-out variant cannot be one of the tasks the procedure was learned from.')
      const observed = input.observedBy === 'tool_result' || input.observedBy === 'external_check'
      const outcome = input.outcome === 'passed' && !observed ? 'inconclusive' : input.outcome
      this.db.prepare('INSERT INTO proc_verifications (scope_id, name, version, verifier, variant_id, kind, outcome, observed_by, answer_key, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(this.scopeId, input.name, input.version, input.verifier, input.variantId, input.kind, outcome, input.observedBy, input.answerKey?.slice(0, 500) ?? null, this.now())
    })
  }

  /**
   * Promotion needs: an approved review; at least one passed held-out variant
   * and one passed negative-precondition case, all observed; no failed
   * verification; no answer key appearing in the manifest; and still-valid
   * source evidence. The previous verified version is superseded, not deleted.
   */
  promote(input: { name: string; version: number }): void {
    this.store.write(() => {
      this.bind(false)
      const row = this.status(input.name, input.version)
      if (row.status !== 'reviewed') throw new MemoryError('conflict', `Only a reviewed version can be promoted (this is ${row.status}).`)
      const checks = this.db.prepare('SELECT kind, outcome, answer_key FROM proc_verifications WHERE scope_id = ? AND name = ? AND version = ?').all(this.scopeId, input.name, input.version) as { kind: string; outcome: string; answer_key: string | null }[]
      if (checks.some((check) => check.outcome === 'failed')) throw new ProcedureRejected('verification_failed', 'A verification failed.')
      if (!checks.some((check) => check.kind === 'held_out_variant' && check.outcome === 'passed')) throw new ProcedureRejected('needs_held_out', 'An observed pass on a held-out variant is required.')
      if (!checks.some((check) => check.kind === 'negative_precondition' && check.outcome === 'passed')) throw new ProcedureRejected('needs_negative_case', 'An observed pass on a case whose preconditions are not met (the procedure must stop) is required.')
      const body = texts(JSON.parse(row.manifest) as ProcedureManifest).map((text) => normalizeText(text).toLocaleLowerCase('und')).join('\n')
      for (const check of checks) {
        const key = normalizeText(check.answer_key ?? '').toLocaleLowerCase('und')
        if (key.length >= 4 && body.includes(key)) throw new ProcedureRejected('answer_key_leak', 'A verification answer appears in the procedure.')
      }
      if (!this.hasValidEvidence(input.name, input.version)) throw new ProcedureRejected('no_evidence', 'The supporting evidence is gone.')
      this.db.prepare("UPDATE proc_versions SET status = 'superseded', status_reason = ? WHERE scope_id = ? AND name = ? AND status = 'verified'").run(`superseded by v${input.version}`, this.scopeId, input.name)
      this.db.prepare("UPDATE proc_versions SET status = 'verified', status_reason = NULL WHERE scope_id = ? AND name = ? AND version = ?").run(this.scopeId, input.name, input.version)
    })
  }

  private hasValidEvidence(name: string, version: number): boolean {
    const row = this.db.prepare(`SELECT count(*) AS count FROM proc_sources s JOIN proc_episodes e ON e.scope_id = s.scope_id AND e.episode_id = s.episode_id
      WHERE s.scope_id = ? AND s.name = ? AND s.version = ? AND e.deleted = 0 AND e.outcome = 'succeeded' AND e.observed_by IN ('tool_result', 'external_check') AND e.evidence_ref IS NOT NULL`).get(this.scopeId, name, version) as { count: number }
    return row.count > 0
  }

  /** Puts the previous superseded version back; the current one is kept as rolled_back. */
  rollback(input: { name: string; reason: string }): number {
    return this.store.write(() => {
      this.bind(false)
      const current = this.db.prepare("SELECT version FROM proc_versions WHERE scope_id = ? AND name = ? AND status = 'verified'").get(this.scopeId, input.name) as { version: number } | undefined
      if (!current) throw new MemoryError('not_found', 'No verified version to roll back.')
      const previous = this.db.prepare("SELECT version FROM proc_versions WHERE scope_id = ? AND name = ? AND status = 'superseded' AND version < ? ORDER BY version DESC LIMIT 1").get(this.scopeId, input.name, current.version) as { version: number } | undefined
      this.db.prepare("UPDATE proc_versions SET status = 'rolled_back', status_reason = ? WHERE scope_id = ? AND name = ? AND version = ?").run(input.reason.slice(0, 200), this.scopeId, input.name, current.version)
      if (previous && this.hasValidEvidence(input.name, previous.version)) {
        this.db.prepare("UPDATE proc_versions SET status = 'verified', status_reason = 'restored by rollback' WHERE scope_id = ? AND name = ? AND version = ?").run(this.scopeId, input.name, previous.version)
        return previous.version
      }
      return 0
    })
  }

  /** Deleting an episode removes its content and invalidates every version it alone supported. */
  deleteEpisode(episodeId: string): { invalidated: { name: string; version: number }[] } {
    return this.store.write(() => {
      this.bind(false)
      this.db.prepare('UPDATE proc_episodes SET deleted = 1, summary = NULL, output = NULL, evidence_ref = NULL WHERE scope_id = ? AND episode_id = ?').run(this.scopeId, episodeId)
      const affected = this.db.prepare(`SELECT DISTINCT v.name, v.version FROM proc_sources s JOIN proc_versions v ON v.scope_id = s.scope_id AND v.name = s.name AND v.version = s.version
        WHERE s.scope_id = ? AND s.episode_id = ? AND v.status NOT IN ('invalidated', 'rejected')`).all(this.scopeId, episodeId) as { name: string; version: number }[]
      const invalidated = affected.filter((item) => !this.hasValidEvidence(item.name, item.version))
      for (const item of invalidated) this.db.prepare("UPDATE proc_versions SET status = 'invalidated', status_reason = 'supporting evidence deleted' WHERE scope_id = ? AND name = ? AND version = ?").run(this.scopeId, item.name, item.version)
      return { invalidated }
    })
  }

  recordAdoption(input: { name: string; version: number | null; decision: 'adopt' | 'reject' | 'defer'; reason: string; metrics?: Record<string, number> }): void {
    this.store.write(() => {
      this.bind(true)
      this.db.prepare('INSERT INTO proc_adoptions (scope_id, name, version, decision, reason, metrics, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(this.scopeId, input.name, input.version, input.decision, input.reason.slice(0, 500), input.metrics ? JSON.stringify(input.metrics) : null, this.now())
    })
  }

  private matching(task: string, statuses: readonly VersionStatus[]): { name: string; version: number; manifest: ProcedureManifest }[] {
    if (!this.bind(false)) return []
    const wanted = new Set(terms(task))
    const rows = this.db.prepare(`SELECT name, version, manifest FROM proc_versions WHERE scope_id = ? AND status IN (${statuses.map(() => '?').join(', ')}) ORDER BY name, version DESC`).all(this.scopeId, ...statuses) as { name: string; version: number; manifest: string }[]
    return rows.map((row) => ({ name: row.name, version: row.version, manifest: JSON.parse(row.manifest) as ProcedureManifest }))
      .map((row) => ({ row, score: terms([row.manifest.trigger.intent, ...row.manifest.trigger.keywords].join(' ')).filter((term) => wanted.has(term)).length }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((item) => item.row)
  }

  private toAdvice(item: { name: string; version: number; manifest: ProcedureManifest }, request: AdviceRequest): Advice {
    return adviceFromManifest(item.name, item.version, item.manifest, request)
  }

  /** Advice from verified versions only. Nothing here runs anything or grants anything. */
  advise(request: AdviceRequest): Advice[] {
    return this.matching(request.task, ['verified']).map((item) => this.toAdvice(item, request))
  }

  /** Shadow mode: what unpromoted versions would advise, for comparison only. */
  adviseShadow(request: AdviceRequest): Advice[] {
    return this.matching(request.task, ['candidate', 'reviewed']).map((item) => this.toAdvice(item, request))
  }

  /** Verified procedures that need another look in a given environment (model upgrade review). */
  reviewForEnvironment(environment: Record<string, string>, toolVersions: Record<string, string> = {}): { name: string; version: number; compatibility: Compatibility; notes: string[] }[] {
    if (!this.bind(false)) return []
    const rows = this.db.prepare("SELECT name, version, manifest FROM proc_versions WHERE scope_id = ? AND status = 'verified'").all(this.scopeId) as { name: string; version: number; manifest: string }[]
    return rows.map((row) => ({ row, check: compatibility(JSON.parse(row.manifest) as ProcedureManifest, { environment, toolVersions }) }))
      .filter((item) => item.check.result !== 'compatible')
      .map((item) => ({ name: item.row.name, version: item.row.version, compatibility: item.check.result, notes: item.check.notes }))
  }

  /** Every version with its evidence, reviews and verifications (answer keys never shown), plus adoption decisions. */
  inspect(name: string): { versions: InspectedVersion[]; adoptions: { version: number | null; decision: string; reason: string; metrics: Record<string, number> | null; at: string }[] } {
    if (!this.bind(false)) return { versions: [], adoptions: [] }
    const versions = (this.db.prepare('SELECT version, status, status_reason, created_by, created_at, manifest FROM proc_versions WHERE scope_id = ? AND name = ? ORDER BY version').all(this.scopeId, name) as { version: number; status: VersionStatus; status_reason: string | null; created_by: string; created_at: string; manifest: string }[]).map((row) => ({
      version: row.version, status: row.status, statusReason: row.status_reason, createdBy: row.created_by, createdAt: row.created_at, manifest: JSON.parse(row.manifest) as ProcedureManifest,
      sources: (this.db.prepare('SELECT e.episode_id, e.outcome, e.observed_by, e.deleted FROM proc_sources s JOIN proc_episodes e ON e.scope_id = s.scope_id AND e.episode_id = s.episode_id WHERE s.scope_id = ? AND s.name = ? AND s.version = ?').all(this.scopeId, name, row.version) as { episode_id: string; outcome: OutcomeStatus; observed_by: ObservedBy; deleted: number }[]).map((item) => ({ episodeId: item.episode_id, outcome: item.outcome, observedBy: item.observed_by, deleted: item.deleted === 1 })),
      reviews: this.db.prepare('SELECT reviewer, decision, note, at FROM proc_reviews WHERE scope_id = ? AND name = ? AND version = ? ORDER BY at').all(this.scopeId, name, row.version) as InspectedVersion['reviews'],
      verifications: (this.db.prepare('SELECT verifier, variant_id, kind, outcome, observed_by, at FROM proc_verifications WHERE scope_id = ? AND name = ? AND version = ? ORDER BY at').all(this.scopeId, name, row.version) as { verifier: string; variant_id: string; kind: string; outcome: string; observed_by: string; at: string }[]).map((item) => ({ verifier: item.verifier, variantId: item.variant_id, kind: item.kind, outcome: item.outcome, observedBy: item.observed_by, at: item.at })),
    }))
    const adoptions = (this.db.prepare('SELECT version, decision, reason, metrics, at FROM proc_adoptions WHERE scope_id = ? AND name = ? ORDER BY at').all(this.scopeId, name) as { version: number | null; decision: string; reason: string; metrics: string | null; at: string }[]).map((item) => ({ ...item, metrics: item.metrics ? JSON.parse(item.metrics) as Record<string, number> : null }))
    return { versions, adoptions }
  }
}

export function openProcedures(options: { store: SqliteProcedureStore; scopeId: string; principalId: string }): ScopedProcedures {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(options.scopeId) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(options.principalId)) throw new MemoryError('validation', 'scopeId and principalId must be stable ids.')
  return new ScopedProcedures(options.store, options.scopeId, options.principalId)
}

/** Stable id for callers that need one per manifest body (not used for identity). */
export function manifestDigest(manifest: ProcedureManifest): string {
  return sha256(JSON.stringify(manifest)).slice(0, 16)
}
