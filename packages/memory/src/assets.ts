import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryError } from './contract.ts'
import { normalizeText, sha256, terms } from './text.ts'

/**
 * Optional multimodal memory (Stage 18): images, documents and audio as
 * evidence, with consent per modality.
 *
 * - Raw bytes, derived text (descriptions, OCR, transcripts) and retention
 *   are consented separately per modality; text memory implies none of them.
 *   Embeddings are not supported and cannot be switched on.
 * - An upload is bytes, never a URL: nothing here fetches from the network.
 * - Derived text is evidence *about* an asset revision (producer, version,
 *   region or time span, confidence), not the asset, and every recall labels
 *   it a historical observation, never the current state of the world.
 * - Deleting an asset or withdrawing consent removes raw bytes, derived text
 *   and search terms, and a parse still running cannot bring them back.
 */

export type Modality = 'image' | 'document' | 'audio'
export type DerivedKind = 'description' | 'ocr' | 'transcript' | 'text'

export const MODALITY_TYPES: Record<Modality, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp'],
  document: ['application/pdf', 'text/plain', 'text/markdown'],
  audio: ['audio/wav'],
}

const DERIVED_KINDS: Record<Modality, readonly DerivedKind[]> = {
  image: ['description', 'ocr'],
  document: ['text', 'ocr'],
  audio: ['transcript'],
}

export interface AssetLimits { image: number; document: number; audio: number; scopeBytes: number }
export const DEFAULT_ASSET_LIMITS: AssetLimits = Object.freeze({ image: 10 * 2 ** 20, document: 20 * 2 ** 20, audio: 25 * 2 ** 20, scopeBytes: 200 * 2 ** 20 })

export interface ModalityConsent { raw: boolean; derived: boolean; embeddings: false; retentionDays: number | null }

export interface DerivedInput {
  kind: DerivedKind
  text: string
  /** Image region as fractions of width/height. */
  region?: { x: number; y: number; w: number; h: number }
  /** Audio span in milliseconds. */
  timeSpan?: { startMs: number; endMs: number }
  confidence: number
}

/** Something that reads an asset: a vision model, an OCR engine, an ASR service, or the built-in text reader. */
export interface AssetInterpreter {
  id: string
  version: string
  handles(contentType: string): boolean
  interpret(asset: { bytes: Uint8Array; contentType: string; modality: Modality; receivedMs?: number }, signal: AbortSignal): Promise<DerivedInput[]>
}

/** Plain-text and Markdown documents, paragraph by paragraph, with character spans. No model involved. */
export const TEXT_DOCUMENT_INTERPRETER: AssetInterpreter = Object.freeze({
  id: 'text-document-reader',
  version: '1.0.0',
  handles: (contentType: string) => contentType === 'text/plain' || contentType === 'text/markdown',
  async interpret(asset: { bytes: Uint8Array }) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes)
    return text.split(/\n\s*\n/u).map((block) => normalizeText(block)).filter(Boolean).slice(0, 200)
      .map((block) => ({ kind: 'text' as const, text: block.slice(0, 2_000), confidence: 1 }))
  },
})

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0))

/** The declared type must match the bytes; a mismatch is refused, not trusted. */
export function sniff(bytes: Uint8Array, contentType: string): boolean {
  switch (contentType) {
    case 'image/png': return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg': return startsWith(bytes, [0xff, 0xd8, 0xff])
    case 'image/webp': return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)
    case 'application/pdf': return startsWith(bytes, ascii('%PDF-'))
    case 'audio/wav': return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WAVE'), 8)
    case 'text/plain':
    case 'text/markdown':
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return !bytes.includes(0)
      } catch {
        return false
      }
    default: return false
  }
}

/** Duration a WAV header promises versus what actually arrived (an interrupted upload or recording). */
export function wavDuration(bytes: Uint8Array): { declaredMs: number; receivedMs: number; truncated: boolean } | null {
  if (!sniff(bytes, 'audio/wav') || bytes.length < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') byteRate = view.getUint32(offset + 16, true)
    if (id === 'data' && byteRate > 0) {
      const received = Math.max(0, Math.min(size, bytes.length - offset - 8))
      return { declaredMs: Math.round((size / byteRate) * 1000), receivedMs: Math.round((received / byteRate) * 1000), truncated: received < size }
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset_scopes (scope_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, deletion_epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS asset_consent (
  scope_id TEXT NOT NULL REFERENCES asset_scopes(scope_id), modality TEXT NOT NULL CHECK (modality IN ('image', 'document', 'audio')),
  raw INTEGER NOT NULL, derived INTEGER NOT NULL, retention_days INTEGER NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, modality)
);
CREATE TABLE IF NOT EXISTS assets (
  scope_id TEXT NOT NULL REFERENCES asset_scopes(scope_id), asset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')), current_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, asset_id)
);
CREATE TABLE IF NOT EXISTS asset_revisions (
  scope_id TEXT NOT NULL, asset_id TEXT NOT NULL, revision INTEGER NOT NULL,
  modality TEXT NOT NULL, content_type TEXT NOT NULL, byte_length INTEGER NOT NULL, content_hash TEXT NOT NULL,
  source_time TEXT NULL, received_at TEXT NOT NULL, provenance TEXT NOT NULL,
  raw_object TEXT NULL, received_ms INTEGER NULL, declared_ms INTEGER NULL,
  PRIMARY KEY (scope_id, asset_id, revision),
  FOREIGN KEY (scope_id, asset_id) REFERENCES assets(scope_id, asset_id)
);
CREATE TABLE IF NOT EXISTS asset_derived (
  scope_id TEXT NOT NULL, derived_id TEXT NOT NULL, asset_id TEXT NOT NULL, revision INTEGER NOT NULL,
  kind TEXT NOT NULL, text TEXT NULL, producer TEXT NOT NULL, producer_version TEXT NOT NULL,
  region TEXT NULL, time_span TEXT NULL, confidence REAL NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted', 'deleted')), created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, derived_id),
  FOREIGN KEY (scope_id, asset_id, revision) REFERENCES asset_revisions(scope_id, asset_id, revision)
);
CREATE TABLE IF NOT EXISTS asset_terms (scope_id TEXT NOT NULL, derived_id TEXT NOT NULL, term TEXT NOT NULL, PRIMARY KEY (scope_id, term, derived_id));
CREATE TABLE IF NOT EXISTS asset_jobs (
  job_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, asset_id TEXT NOT NULL, revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  deletion_epoch INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_displays (
  scope_id TEXT NOT NULL, conversation_id TEXT NOT NULL, display_revision INTEGER NOT NULL,
  asset_id TEXT NOT NULL, revision INTEGER NOT NULL, shown_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, conversation_id, display_revision)
);
`

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u

export interface AssetRecall {
  derivedId: string
  assetId: string
  revision: number
  kind: DerivedKind
  text: string
  producer: string
  producerVersion: string
  confidence: number
  region: DerivedInput['region'] | null
  timeSpan: DerivedInput['timeSpan'] | null
  observedAt: string
  /** Always true: this is what an asset showed when captured, not how things are now. */
  historicalObservation: true
  /** Whether the original can still be fetched to re-check the description. */
  sourceAvailable: boolean
  supersededByRevision: number | null
  note: string
}

export class SqliteAssetStore {
  readonly db: DatabaseSync
  readonly objectDir: string
  readonly limits: AssetLimits

  constructor(options: { path: string; objectDir: string; limits?: Partial<AssetLimits> }) {
    if (options.path !== ':memory:') {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
      if (!existsSync(options.path)) closeSync(openSync(options.path, 'a', 0o600))
    }
    mkdirSync(options.objectDir, { recursive: true, mode: 0o700 })
    this.objectDir = options.objectDir
    this.limits = { ...DEFAULT_ASSET_LIMITS, ...options.limits }
    this.db = new DatabaseSync(options.path)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    if (options.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.write(() => {
      this.db.exec(SCHEMA)
      if (!this.db.prepare("SELECT 1 FROM asset_meta WHERE key = 'schema_version'").get()) this.db.prepare("INSERT INTO asset_meta (key, value) VALUES ('schema_version', '1')").run()
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

/** One owner's assets; built by the host from its own identity. */
export class ScopedAssets {
  constructor(private readonly store: SqliteAssetStore, readonly scopeId: string, readonly principalId: string) {}

  private get db() { return this.store.db }
  private now() { return new Date().toISOString() }

  private bind(create: boolean): boolean {
    const row = this.db.prepare('SELECT principal_id FROM asset_scopes WHERE scope_id = ?').get(this.scopeId) as { principal_id: string } | undefined
    if (row && row.principal_id !== this.principalId) throw new MemoryError('unauthorized', 'These assets belong to another principal.')
    if (!row && create) this.db.prepare('INSERT INTO asset_scopes (scope_id, principal_id) VALUES (?, ?)').run(this.scopeId, this.principalId)
    return Boolean(row) || create
  }

  consent(modality: Modality): ModalityConsent {
    this.bind(false)
    const row = this.db.prepare('SELECT raw, derived, retention_days FROM asset_consent WHERE scope_id = ? AND modality = ?').get(this.scopeId, modality) as { raw: number; derived: number; retention_days: number | null } | undefined
    return { raw: row?.raw === 1, derived: row?.derived === 1, embeddings: false, retentionDays: row?.retention_days ?? null }
  }

  /** Sets one modality's consent. Withdrawing raw or derived consent removes what it covered, at once. */
  setConsent(modality: Modality, consent: { raw: boolean; derived: boolean; embeddings?: boolean; retentionDays?: number | null }): { purgedRaw: number; purgedDerived: number } {
    if (!(modality in MODALITY_TYPES)) throw new MemoryError('validation', 'Unknown modality.')
    if (consent.embeddings) throw new MemoryError('unsupported', 'Embeddings of media are not supported.')
    if (consent.retentionDays !== undefined && consent.retentionDays !== null && (!Number.isInteger(consent.retentionDays) || consent.retentionDays < 1 || consent.retentionDays > 3650)) throw new MemoryError('validation', 'retentionDays is 1-3650 or null.')
    return this.store.write(() => {
      this.bind(true)
      this.db.prepare(`INSERT INTO asset_consent (scope_id, modality, raw, derived, retention_days, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (scope_id, modality) DO UPDATE SET raw = excluded.raw, derived = excluded.derived, retention_days = excluded.retention_days, updated_at = excluded.updated_at`)
        .run(this.scopeId, modality, consent.raw ? 1 : 0, consent.derived ? 1 : 0, consent.retentionDays ?? null, this.now())
      const purgedRaw = consent.raw ? 0 : this.purgeRaw('modality = ?', [modality])
      const purgedDerived = consent.derived ? 0 : this.purgeDerived('asset_id IN (SELECT asset_id FROM asset_revisions WHERE scope_id = ? AND modality = ?)', [this.scopeId, modality])
      if (!consent.raw || !consent.derived) this.bumpEpoch()
      return { purgedRaw, purgedDerived }
    })
  }

  private bumpEpoch(): void {
    this.db.prepare('UPDATE asset_scopes SET deletion_epoch = deletion_epoch + 1 WHERE scope_id = ?').run(this.scopeId)
    this.db.prepare("UPDATE asset_jobs SET state = 'cancelled' WHERE scope_id = ? AND state IN ('pending', 'running')").run(this.scopeId)
  }

  private purgeRaw(where: string, extra: (string | number)[] = []): number {
    const rows = this.db.prepare(`SELECT asset_id, revision, raw_object FROM asset_revisions WHERE scope_id = ? AND raw_object IS NOT NULL AND ${where}`).all(this.scopeId, ...extra) as { asset_id: string; revision: number; raw_object: string }[]
    for (const row of rows) {
      rmSync(join(this.store.objectDir, row.raw_object), { force: true })
      this.db.prepare('UPDATE asset_revisions SET raw_object = NULL WHERE scope_id = ? AND asset_id = ? AND revision = ?').run(this.scopeId, row.asset_id, row.revision)
    }
    return rows.length
  }

  private purgeDerived(where: string, extra: (string | number)[] = []): number {
    const rows = this.db.prepare(`SELECT derived_id FROM asset_derived WHERE scope_id = ? AND status = 'accepted' AND ${where}`).all(this.scopeId, ...extra) as { derived_id: string }[]
    for (const row of rows) {
      this.db.prepare("UPDATE asset_derived SET text = NULL, status = 'deleted' WHERE scope_id = ? AND derived_id = ?").run(this.scopeId, row.derived_id)
      this.db.prepare('DELETE FROM asset_terms WHERE scope_id = ? AND derived_id = ?').run(this.scopeId, row.derived_id)
    }
    return rows.length
  }

  /**
   * Stores one revision of an asset from bytes. Raw bytes are kept only with
   * raw consent (in the owner-only object directory, under a random name);
   * without it, derivation must happen now, with the interpreter given, and
   * the bytes are dropped afterwards.
   */
  async ingest(input: { assetId?: string; bytes: Uint8Array; contentType: string; filename?: string; sourceTime?: string | null; channel?: string; url?: never }, options: { interpreter?: AssetInterpreter; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ assetId: string; revision: number; rawRetained: boolean; derivation: 'queued' | 'completed' | 'not_interpreted' | 'not_consented' | 'unsupported' }> {
    if ('url' in (input as Record<string, unknown>)) throw new MemoryError('validation', 'Uploads are bytes; a URL is never fetched.')
    const modality = (Object.keys(MODALITY_TYPES) as Modality[]).find((key) => MODALITY_TYPES[key].includes(input.contentType))
    if (!modality) throw new MemoryError('unsupported', `Unsupported content type ${input.contentType}.`)
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) throw new MemoryError('validation', 'An upload needs content.')
    if (input.bytes.length > this.store.limits[modality]) throw new MemoryError('quota', `This ${modality} is larger than ${this.store.limits[modality]} bytes.`)
    if (!sniff(input.bytes, input.contentType)) throw new MemoryError('validation', `The content does not look like ${input.contentType}.`)
    if (input.assetId !== undefined && !ID.test(input.assetId)) throw new MemoryError('validation', 'assetId must be a stable id.')
    const sourceTime = input.sourceTime ? new Date(input.sourceTime).toISOString() : null
    const consent = this.consent(modality)
    if (!consent.raw && !consent.derived) throw new MemoryError('unauthorized', `No consent to keep anything from ${modality} uploads.`)
    const wav = modality === 'audio' ? wavDuration(input.bytes) : null
    if (modality === 'audio' && !wav) throw new MemoryError('validation', 'The audio could not be read.')

    const stored = this.store.write(() => {
      this.bind(true)
      const used = this.db.prepare("SELECT COALESCE(sum(r.byte_length), 0) AS used FROM asset_revisions r JOIN assets a ON a.scope_id = r.scope_id AND a.asset_id = r.asset_id WHERE r.scope_id = ? AND a.status = 'active' AND r.raw_object IS NOT NULL").get(this.scopeId) as { used: number }
      if (consent.raw && used.used + input.bytes.length > this.store.limits.scopeBytes) throw new MemoryError('quota', 'The media storage for this memory is full.')
      const assetId = input.assetId ?? `asset_${randomUUID().replace(/-/gu, '')}`
      const existing = this.db.prepare('SELECT status, current_revision FROM assets WHERE scope_id = ? AND asset_id = ?').get(this.scopeId, assetId) as { status: string; current_revision: number } | undefined
      if (existing?.status === 'deleted') throw new MemoryError('suppressed', 'This asset was deleted; upload it as a new asset.')
      const revision = (existing?.current_revision ?? 0) + 1
      let rawObject: string | null = null
      if (consent.raw) {
        rawObject = `${randomUUID()}.bin`
        writeFileSync(join(this.store.objectDir, rawObject), input.bytes, { mode: 0o600 })
      }
      if (!existing) this.db.prepare("INSERT INTO assets (scope_id, asset_id, status, current_revision, created_at) VALUES (?, ?, 'active', ?, ?)").run(this.scopeId, assetId, revision, this.now())
      else this.db.prepare('UPDATE assets SET current_revision = ? WHERE scope_id = ? AND asset_id = ?').run(revision, this.scopeId, assetId)
      const provenance = JSON.stringify({ principal: this.principalId, channel: input.channel ?? 'upload', filename: input.filename ? input.filename.replace(/[^\w.-]+/gu, '_').slice(0, 120) : null })
      this.db.prepare(`INSERT INTO asset_revisions (scope_id, asset_id, revision, modality, content_type, byte_length, content_hash, source_time, received_at, provenance, raw_object, received_ms, declared_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.scopeId, assetId, revision, modality, input.contentType, input.bytes.length, sha256(Buffer.from(input.bytes).toString('base64')), sourceTime, this.now(), provenance, rawObject, wav?.receivedMs ?? null, wav?.declaredMs ?? null)
      const epoch = (this.db.prepare('SELECT deletion_epoch FROM asset_scopes WHERE scope_id = ?').get(this.scopeId) as { deletion_epoch: number }).deletion_epoch
      if (consent.derived && consent.raw) this.db.prepare("INSERT INTO asset_jobs (job_id, scope_id, asset_id, revision, state, deletion_epoch, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(`ajob_${randomUUID()}`, this.scopeId, assetId, revision, epoch, this.now())
      return { assetId, revision, rawRetained: consent.raw, epoch }
    })
    if (!consent.derived) return { ...stored, derivation: 'not_consented' }
    if (consent.raw) return { ...stored, derivation: 'queued' }
    // No raw consent: interpret now, while the bytes are only in memory.
    if (!options.interpreter || !options.interpreter.handles(input.contentType)) return { ...stored, derivation: 'unsupported' }
    const outcome = await this.interpretAndCommit({ assetId: stored.assetId, revision: stored.revision, epoch: stored.epoch, fence: null }, input.bytes, input.contentType, modality, wav?.receivedMs, options)
    return { ...stored, derivation: outcome === 'committed' ? 'completed' : 'not_interpreted' }
  }

  private async interpretAndCommit(target: { assetId: string; revision: number; epoch: number; fence: { jobId: string; fence: number } | null }, bytes: Uint8Array, contentType: string, modality: Modality, receivedMs: number | undefined, options: { interpreter?: AssetInterpreter; signal?: AbortSignal; timeoutMs?: number }): Promise<'committed' | 'stale' | 'failed'> {
    const interpreter = options.interpreter!
    let derived: DerivedInput[]
    try {
      const signals = [AbortSignal.timeout(options.timeoutMs ?? 20_000), ...(options.signal ? [options.signal] : [])]
      derived = await interpreter.interpret({ bytes, contentType, modality, receivedMs }, AbortSignal.any(signals))
    } catch {
      return 'failed'
    }
    return this.store.write(() => {
      // A deletion, consent change or newer attempt since the job started makes this result stale.
      const scope = this.db.prepare('SELECT deletion_epoch FROM asset_scopes WHERE scope_id = ?').get(this.scopeId) as { deletion_epoch: number }
      const asset = this.db.prepare('SELECT status FROM assets WHERE scope_id = ? AND asset_id = ?').get(this.scopeId, target.assetId) as { status: string } | undefined
      if (scope.deletion_epoch !== target.epoch || asset?.status !== 'active' || !this.consent(modality).derived) return 'stale' as const
      if (target.fence) {
        const job = this.db.prepare('SELECT state, fence FROM asset_jobs WHERE job_id = ?').get(target.fence.jobId) as { state: string; fence: number } | undefined
        if (!job || job.state !== 'running' || job.fence !== target.fence.fence) return 'stale' as const
        this.db.prepare("UPDATE asset_jobs SET state = 'completed' WHERE job_id = ?").run(target.fence.jobId)
      }
      for (const item of derived.slice(0, 200)) {
        if (!DERIVED_KINDS[modality].includes(item.kind) || typeof item.text !== 'string' || !normalizeText(item.text)) continue
        let span = item.timeSpan ?? null
        if (span && receivedMs !== undefined) {
          // Only what was actually received can be transcribed; later spans are dropped, a straddling one is clipped.
          if (span.startMs >= receivedMs) continue
          span = { startMs: span.startMs, endMs: Math.min(span.endMs, receivedMs) }
        }
        const region = item.region && [item.region.x, item.region.y, item.region.w, item.region.h].every((value) => value >= 0 && value <= 1) ? item.region : null
        const derivedId = `der_${randomUUID().replace(/-/gu, '')}`
        this.db.prepare(`INSERT INTO asset_derived (scope_id, derived_id, asset_id, revision, kind, text, producer, producer_version, region, time_span, confidence, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`).run(this.scopeId, derivedId, target.assetId, target.revision, item.kind, item.text.slice(0, 4_000), interpreter.id, interpreter.version, region ? JSON.stringify(region) : null, span ? JSON.stringify(span) : null, Math.max(0, Math.min(1, item.confidence)), this.now())
        for (const term of terms(item.text)) this.db.prepare('INSERT OR IGNORE INTO asset_terms (scope_id, derived_id, term) VALUES (?, ?, ?)').run(this.scopeId, derivedId, term)
      }
      return 'committed' as const
    })
  }

  /**
   * Interprets queued uploads. A provider outage leaves the job pending for
   * a later attempt (up to three), and recall says the asset was not
   * interpreted rather than guessing.
   */
  async processPending(interpreter: AssetInterpreter, options: { limit?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ committed: number; stale: number; failed: number; skipped: number }> {
    const report = { committed: 0, stale: 0, failed: 0, skipped: 0 }
    const claimed = this.store.write(() => {
      if (!this.bind(false)) return []
      // Claim only what this interpreter can read; other modalities wait for theirs.
      const rows = (this.db.prepare(`SELECT j.job_id, j.asset_id, j.revision, j.deletion_epoch, r.content_type FROM asset_jobs j
        JOIN asset_revisions r ON r.scope_id = j.scope_id AND r.asset_id = j.asset_id AND r.revision = j.revision
        WHERE j.scope_id = ? AND j.state = 'pending' ORDER BY j.created_at`).all(this.scopeId) as { job_id: string; asset_id: string; revision: number; deletion_epoch: number; content_type: string }[])
        .filter((row) => interpreter.handles(row.content_type))
        .slice(0, options.limit ?? 10)
      return rows.map((row) => {
        this.db.prepare("UPDATE asset_jobs SET state = 'running', fence = fence + 1, attempts = attempts + 1 WHERE job_id = ?").run(row.job_id)
        const job = this.db.prepare('SELECT fence FROM asset_jobs WHERE job_id = ?').get(row.job_id) as { fence: number }
        const revision = this.db.prepare('SELECT modality, content_type, raw_object, received_ms FROM asset_revisions WHERE scope_id = ? AND asset_id = ? AND revision = ?').get(this.scopeId, row.asset_id, row.revision) as { modality: Modality; content_type: string; raw_object: string | null; received_ms: number | null }
        return { ...row, fence: job.fence, ...revision }
      })
    })
    for (const job of claimed) {
      if (!job.raw_object || !interpreter.handles(job.content_type)) {
        this.store.write(() => this.db.prepare("UPDATE asset_jobs SET state = 'failed', last_error = 'unsupported' WHERE job_id = ? AND fence = ?").run(job.job_id, job.fence))
        report.skipped += 1
        continue
      }
      const bytes = new Uint8Array(readFileSync(join(this.store.objectDir, job.raw_object)))
      const outcome = await this.interpretAndCommit({ assetId: job.asset_id, revision: job.revision, epoch: job.deletion_epoch, fence: { jobId: job.job_id, fence: job.fence } }, bytes, job.content_type, job.modality, job.received_ms ?? undefined, { interpreter, signal: options.signal, timeoutMs: options.timeoutMs })
      if (outcome === 'failed') {
        this.store.write(() => this.db.prepare("UPDATE asset_jobs SET state = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, last_error = 'interpreter_unavailable' WHERE job_id = ? AND fence = ? AND state = 'running'").run(job.job_id, job.fence))
      }
      report[outcome] += 1
    }
    return report
  }

  /** Derived evidence matching a question, labelled as past observation. */
  recall(query: string, limit = 5): AssetRecall[] {
    if (!this.bind(false)) return []
    const wanted = terms(query)
    if (!wanted.length) return []
    const rows = this.db.prepare(`SELECT d.derived_id, d.asset_id, d.revision, d.kind, d.text, d.producer, d.producer_version, d.confidence, d.region, d.time_span,
        r.modality, r.source_time, r.received_at, r.raw_object, a.current_revision, count(*) AS hits
      FROM asset_terms t JOIN asset_derived d ON d.scope_id = t.scope_id AND d.derived_id = t.derived_id
      JOIN asset_revisions r ON r.scope_id = d.scope_id AND r.asset_id = d.asset_id AND r.revision = d.revision
      JOIN assets a ON a.scope_id = d.scope_id AND a.asset_id = d.asset_id
      WHERE t.scope_id = ? AND d.status = 'accepted' AND a.status = 'active' AND t.term IN (${wanted.map(() => '?').join(', ')})
      GROUP BY d.derived_id ORDER BY hits DESC, d.confidence DESC, d.created_at DESC LIMIT ?`).all(this.scopeId, ...wanted, Math.max(1, Math.min(limit, 20))) as {
        derived_id: string; asset_id: string; revision: number; kind: DerivedKind; text: string; producer: string; producer_version: string; confidence: number; region: string | null; time_span: string | null
        modality: Modality; source_time: string | null; received_at: string; raw_object: string | null; current_revision: number
      }[]
    return rows.filter((row) => this.consent(row.modality).derived).map((row) => {
      const observedAt = row.source_time ?? row.received_at
      const what = row.kind === 'description' ? 'A model’s description of an image' : row.kind === 'transcript' ? 'A transcript of audio' : row.kind === 'ocr' ? 'Text read from an image or scan' : 'Text from a document'
      return {
        derivedId: row.derived_id, assetId: row.asset_id, revision: row.revision, kind: row.kind, text: row.text, producer: row.producer, producerVersion: row.producer_version,
        confidence: row.confidence, region: row.region ? JSON.parse(row.region) : null, timeSpan: row.time_span ? JSON.parse(row.time_span) : null, observedAt,
        historicalObservation: true as const, sourceAvailable: Boolean(row.raw_object), supersededByRevision: row.current_revision > row.revision ? row.current_revision : null,
        note: `${what} captured ${observedAt.slice(0, 10)} (confidence ${row.confidence.toFixed(2)}). It describes that moment, not how things are now${row.raw_object ? '' : '; the original was not kept, so it cannot be re-checked'}.`,
      }
    })
  }

  /** The original bytes, only if kept, consented and not deleted. */
  fetchSource(assetId: string, revision: number): { contentType: string; bytes: Uint8Array } {
    if (!this.bind(false)) throw new MemoryError('not_found', 'No such asset.')
    const row = this.db.prepare(`SELECT r.content_type, r.raw_object, r.modality, a.status FROM asset_revisions r JOIN assets a ON a.scope_id = r.scope_id AND a.asset_id = r.asset_id
      WHERE r.scope_id = ? AND r.asset_id = ? AND r.revision = ?`).get(this.scopeId, assetId, revision) as { content_type: string; raw_object: string | null; modality: Modality; status: string } | undefined
    if (!row || row.status !== 'active') throw new MemoryError('not_found', 'No such asset.')
    if (!row.raw_object || !this.consent(row.modality).raw) throw new MemoryError('unavailable', 'The original was not kept; only its derived description remains.')
    return { contentType: row.content_type, bytes: new Uint8Array(readFileSync(join(this.store.objectDir, row.raw_object))) }
  }

  /**
   * Inspector view of one asset: every revision with what was kept, and every
   * derived item with its producer, region or span and confidence. A deleted
   * asset shows only that it existed; nothing it contained.
   */
  inspect(assetId: string): { assetId: string; status: 'active' | 'deleted'; revisions: { revision: number; modality: Modality; contentType: string; byteLength: number; observedAt: string; rawKept: boolean; receivedMs: number | null; declaredMs: number | null; derived: { derivedId: string; kind: DerivedKind; text: string | null; producer: string; producerVersion: string; confidence: number; region: DerivedInput['region'] | null; timeSpan: DerivedInput['timeSpan'] | null; status: string }[] }[] } {
    if (!this.bind(false)) throw new MemoryError('not_found', 'No such asset.')
    const asset = this.db.prepare('SELECT status FROM assets WHERE scope_id = ? AND asset_id = ?').get(this.scopeId, assetId) as { status: 'active' | 'deleted' } | undefined
    if (!asset) throw new MemoryError('not_found', 'No such asset.')
    if (asset.status === 'deleted') return { assetId, status: 'deleted', revisions: [] }
    const revisions = this.db.prepare('SELECT revision, modality, content_type, byte_length, source_time, received_at, raw_object, received_ms, declared_ms FROM asset_revisions WHERE scope_id = ? AND asset_id = ? ORDER BY revision').all(this.scopeId, assetId) as { revision: number; modality: Modality; content_type: string; byte_length: number; source_time: string | null; received_at: string; raw_object: string | null; received_ms: number | null; declared_ms: number | null }[]
    return {
      assetId, status: 'active',
      revisions: revisions.map((row) => ({
        revision: row.revision, modality: row.modality, contentType: row.content_type, byteLength: row.byte_length, observedAt: row.source_time ?? row.received_at,
        rawKept: Boolean(row.raw_object), receivedMs: row.received_ms, declaredMs: row.declared_ms,
        derived: (this.db.prepare('SELECT derived_id, kind, text, producer, producer_version, confidence, region, time_span, status FROM asset_derived WHERE scope_id = ? AND asset_id = ? AND revision = ? ORDER BY created_at').all(this.scopeId, assetId, row.revision) as { derived_id: string; kind: DerivedKind; text: string | null; producer: string; producer_version: string; confidence: number; region: string | null; time_span: string | null; status: string }[])
          .map((item) => ({ derivedId: item.derived_id, kind: item.kind, text: item.text, producer: item.producer, producerVersion: item.producer_version, confidence: item.confidence, region: item.region ? JSON.parse(item.region) : null, timeSpan: item.time_span ? JSON.parse(item.time_span) : null, status: item.status })),
      })),
    }
  }

  /** Records which exact revision a conversation showed at one display step. */
  recordDisplay(input: { conversationId: string; displayRevision: number; assetId: string; revision: number }): void {
    this.store.write(() => {
      this.bind(true)
      const exists = this.db.prepare("SELECT 1 FROM asset_revisions r JOIN assets a ON a.scope_id = r.scope_id AND a.asset_id = r.asset_id WHERE r.scope_id = ? AND r.asset_id = ? AND r.revision = ? AND a.status = 'active'").get(this.scopeId, input.assetId, input.revision)
      if (!exists) throw new MemoryError('not_found', 'That asset revision does not exist here.')
      this.db.prepare('INSERT INTO asset_displays (scope_id, conversation_id, display_revision, asset_id, revision, shown_at) VALUES (?, ?, ?, ?, ?, ?)').run(this.scopeId, input.conversationId, input.displayRevision, input.assetId, input.revision, this.now())
    })
  }

  /** "The picture you showed me earlier": the revision that was on screen, even if a newer one exists. */
  resolveDisplay(conversationId: string, displayRevision: number): { status: 'resolved'; assetId: string; revision: number; newerRevision: number | null } | { status: 'deleted' } {
    if (!this.bind(false)) throw new MemoryError('not_found', 'That display step was never issued.')
    const row = this.db.prepare(`SELECT d.asset_id, d.revision, a.status, a.current_revision FROM asset_displays d JOIN assets a ON a.scope_id = d.scope_id AND a.asset_id = d.asset_id
      WHERE d.scope_id = ? AND d.conversation_id = ? AND d.display_revision = ?`).get(this.scopeId, conversationId, displayRevision) as { asset_id: string; revision: number; status: string; current_revision: number } | undefined
    if (!row) throw new MemoryError('not_found', 'That display step was never issued.')
    if (row.status !== 'active') return { status: 'deleted' }
    return { status: 'resolved', assetId: row.asset_id, revision: row.revision, newerRevision: row.current_revision > row.revision ? row.current_revision : null }
  }

  /** Deletes every revision: raw bytes, derived text and terms; running parses are cancelled and cannot commit. */
  deleteAsset(assetId: string): { revisions: number; derived: number; rawFiles: number } {
    return this.store.write(() => {
      if (!this.bind(false)) throw new MemoryError('not_found', 'No such asset.')
      const asset = this.db.prepare('SELECT status FROM assets WHERE scope_id = ? AND asset_id = ?').get(this.scopeId, assetId) as { status: string } | undefined
      if (!asset) throw new MemoryError('not_found', 'No such asset.')
      const revisions = (this.db.prepare('SELECT count(*) AS count FROM asset_revisions WHERE scope_id = ? AND asset_id = ?').get(this.scopeId, assetId) as { count: number }).count
      const rawFiles = this.purgeRaw('asset_id = ?', [assetId])
      const derived = this.purgeDerived('asset_id = ?', [assetId])
      this.db.prepare("UPDATE assets SET status = 'deleted' WHERE scope_id = ? AND asset_id = ?").run(this.scopeId, assetId)
      this.db.prepare("UPDATE asset_revisions SET provenance = '{}', content_hash = '' WHERE scope_id = ? AND asset_id = ?").run(this.scopeId, assetId)
      this.bumpEpoch()
      return { revisions, derived, rawFiles }
    })
  }

  /** Removes raw bytes older than each modality's retention window; derived text follows its own consent. */
  applyRetention(now = new Date()): number {
    return this.store.write(() => {
      if (!this.bind(false)) return 0
      let purged = 0
      for (const modality of Object.keys(MODALITY_TYPES) as Modality[]) {
        const days = this.consent(modality).retentionDays
        if (days === null) continue
        const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString()
        purged += this.purgeRaw('modality = ? AND received_at < ?', [modality, cutoff])
      }
      return purged
    })
  }

  /** Metadata and derived text for current assets; raw bytes only when asked for and still kept. */
  exportAll(options: { includeRaw?: boolean } = {}): { format: 'gideon-asset-export'; version: 1; assets: { assetId: string; revision: number; modality: Modality; contentType: string; observedAt: string; derived: { kind: DerivedKind; text: string; producer: string; confidence: number }[]; raw: string | null }[] } {
    if (!this.bind(false)) return { format: 'gideon-asset-export', version: 1, assets: [] }
    const rows = this.db.prepare(`SELECT r.asset_id, r.revision, r.modality, r.content_type, r.source_time, r.received_at, r.raw_object FROM asset_revisions r JOIN assets a ON a.scope_id = r.scope_id AND a.asset_id = r.asset_id
      WHERE r.scope_id = ? AND a.status = 'active' ORDER BY r.asset_id, r.revision`).all(this.scopeId) as { asset_id: string; revision: number; modality: Modality; content_type: string; source_time: string | null; received_at: string; raw_object: string | null }[]
    return {
      format: 'gideon-asset-export', version: 1,
      assets: rows.map((row) => ({
        assetId: row.asset_id, revision: row.revision, modality: row.modality, contentType: row.content_type, observedAt: row.source_time ?? row.received_at,
        derived: this.consent(row.modality).derived
          ? (this.db.prepare("SELECT kind, text, producer, confidence FROM asset_derived WHERE scope_id = ? AND asset_id = ? AND revision = ? AND status = 'accepted'").all(this.scopeId, row.asset_id, row.revision) as { kind: DerivedKind; text: string; producer: string; confidence: number }[])
          : [],
        raw: options.includeRaw && row.raw_object && this.consent(row.modality).raw ? Buffer.from(readFileSync(join(this.store.objectDir, row.raw_object))).toString('base64') : null,
      })),
    }
  }
}

export function openAssets(options: { store: SqliteAssetStore; scopeId: string; principalId: string }): ScopedAssets {
  if (!ID.test(options.scopeId) || !ID.test(options.principalId)) throw new MemoryError('validation', 'scopeId and principalId must be stable ids.')
  return new ScopedAssets(options.store, options.scopeId, options.principalId)
}
