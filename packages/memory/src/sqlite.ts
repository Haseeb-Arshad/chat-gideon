import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LIMITS,
  MemoryError,
  STORED_SCHEMA_VERSION,
  type CallOptions,
  type Capabilities,
  type ClaimedJob,
  type MemoryBackend,
  type MemoryItem,
  type MemoryKind,
  type MemoryRevision,
  type Page,
  type Scope,
  type WriteResult,
} from './contract.ts'
import { canonicalKey, sha256, terms } from './text.ts'

/**
 * SQLite backend. Every write runs in `BEGIN IMMEDIATE`, which takes the
 * database write lock up front: writers in other processes wait on the
 * database (busy_timeout), never on an in-process queue. WAL lets readers run
 * alongside. Foreign keys are on. The database file and its directory are
 * created owner-only where the platform supports it.
 *
 * Calls are synchronous inside (node:sqlite); a waiting writer blocks its own
 * event loop for up to `busyTimeoutMs`, which suits local hosts, not a
 * shared multi-tenant server.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scopes (
  scope_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'deleted')),
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'constraint', 'decision')),
  canonical TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS items_canonical ON items (scope_id, canonical) WHERE canonical IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_page ON items (scope_id, status, created_at, id);
CREATE TABLE IF NOT EXISTS versions (
  scope_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  text TEXT NULL,
  valid_from TEXT NULL,
  valid_until TEXT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('explicit', 'correction', 'imported')),
  superseded_as_mistake INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, id, revision),
  FOREIGN KEY (scope_id, id) REFERENCES items(scope_id, id)
);
CREATE TABLE IF NOT EXISTS commands (
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'forgotten')),
  PRIMARY KEY (scope_id, command_id)
);
CREATE INDEX IF NOT EXISTS commands_item ON commands (scope_id, item_id);
CREATE TABLE IF NOT EXISTS item_terms (
  scope_id TEXT NOT NULL,
  id TEXT NOT NULL,
  term TEXT NOT NULL,
  PRIMARY KEY (scope_id, term, id),
  FOREIGN KEY (scope_id, id) REFERENCES items(scope_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  event_id TEXT NOT NULL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (scope_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed')),
  fence INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT NULL,
  worker_id TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs (scope_id, state, created_at);
`

interface ItemRow { id: string; current_revision: number; status: string; kind: string; created_at: string; updated_at: string }
interface VersionRow { text: string | null; valid_from: string | null; valid_until: string | null; basis: string; revision: number; created_at: string }

export interface SqliteBackendOptions {
  /** Path to the database file, or ':memory:' for a throwaway store. */
  path: string
  busyTimeoutMs?: number
  /** Current memories one scope may hold (the PostgreSQL default is also 1,000). */
  maxItemsPerScope?: number
}

export class SqliteMemoryBackend implements MemoryBackend {
  readonly capabilities: Capabilities = Object.freeze({
    backend: 'sqlite',
    storedSchemaVersion: STORED_SCHEMA_VERSION,
    atomicWrites: true,
    optimisticRevisions: true,
    idempotentCommands: true,
    temporal: 'valid_at',
    suppression: 'content_removed',
    crossProcessWriters: 'database_locking',
    fencedJobLeases: true,
    lexicalSearch: 'token_index',
    semanticSearch: false,
  } as const)

  private readonly db: DatabaseSync
  private readonly maxItems: number

  constructor(options: SqliteBackendOptions) {
    this.maxItems = Math.max(1, options.maxItemsPerScope ?? 1_000)
    if (options.path !== ':memory:') {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
      // Create the file owner-only before SQLite opens it with default permissions.
      if (!existsSync(options.path)) closeSync(openSync(options.path, 'a', 0o600))
    }
    this.db = new DatabaseSync(options.path)
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.min(options.busyTimeoutMs ?? 5_000, 60_000))}`)
    this.db.exec('PRAGMA foreign_keys = ON')
    if (options.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.write(() => {
      this.db.exec(SCHEMA)
      const stored = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
      if (!stored) this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(STORED_SCHEMA_VERSION))
      else if (Number(stored.value) !== STORED_SCHEMA_VERSION) throw new MemoryError('unsupported', `This database has stored schema ${stored.value}; this library reads ${STORED_SCHEMA_VERSION}.`)
    })
  }

  /** One immediate (write-locked) transaction; rolled back on any error. */
  private write<T>(work: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch (error) {
      throw new MemoryError('unavailable', `The database is busy: ${(error as Error).message}`, true)
    }
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      if (error instanceof MemoryError) throw error
      throw new MemoryError('unavailable', 'The memory write failed and was rolled back.', true)
    }
  }

  /** The scope row binds a scope to one principal; another principal is refused. */
  private bindScope(scope: Scope, now: string, create: boolean): void {
    const row = this.db.prepare('SELECT principal_id FROM scopes WHERE scope_id = ?').get(scope.scopeId) as { principal_id: string } | undefined
    if (row && row.principal_id !== scope.principalId) throw new MemoryError('unauthorized', 'This scope belongs to another principal.')
    if (!row && create) this.db.prepare('INSERT INTO scopes (scope_id, principal_id, created_at) VALUES (?, ?, ?)').run(scope.scopeId, scope.principalId, now)
  }

  private readScope(scope: Scope): boolean {
    const row = this.db.prepare('SELECT principal_id FROM scopes WHERE scope_id = ?').get(scope.scopeId) as { principal_id: string } | undefined
    if (row && row.principal_id !== scope.principalId) throw new MemoryError('unauthorized', 'This scope belongs to another principal.')
    return Boolean(row)
  }

  private itemAt(item: ItemRow, version: VersionRow): MemoryItem {
    return {
      id: item.id, revision: version.revision, kind: item.kind as MemoryKind, text: version.text ?? '',
      validFrom: version.valid_from, validUntil: version.valid_until, basis: version.basis as MemoryItem['basis'],
      createdAt: item.created_at, updatedAt: version.created_at,
    }
  }

  private current(scope: Scope, id: string): MemoryItem | null {
    const item = this.db.prepare('SELECT id, current_revision, status, kind, created_at, updated_at FROM items WHERE scope_id = ? AND id = ?').get(scope.scopeId, id) as ItemRow | undefined
    if (!item || item.status !== 'accepted') return null
    const version = this.db.prepare('SELECT text, valid_from, valid_until, basis, revision, created_at FROM versions WHERE scope_id = ? AND id = ? AND revision = ?').get(scope.scopeId, id, item.current_revision) as unknown as VersionRow
    return this.itemAt(item, version)
  }

  private index(scope: Scope, id: string, text: string): void {
    this.db.prepare('DELETE FROM item_terms WHERE scope_id = ? AND id = ?').run(scope.scopeId, id)
    const insert = this.db.prepare('INSERT OR IGNORE INTO item_terms (scope_id, id, term) VALUES (?, ?, ?)')
    for (const term of terms(text)) insert.run(scope.scopeId, id, term)
  }

  /** Replays a command id, or refuses it: a different payload, or a command whose memory was forgotten. */
  private replay(scope: Scope, commandId: string, payloadHash: string): WriteResult | null {
    const row = this.db.prepare('SELECT payload_hash, item_id, status FROM commands WHERE scope_id = ? AND command_id = ?').get(scope.scopeId, commandId) as { payload_hash: string; item_id: string; status: string } | undefined
    if (!row) return null
    if (row.payload_hash !== payloadHash) throw new MemoryError('conflict', 'This command id was already used with different content.')
    if (row.status === 'forgotten') throw new MemoryError('suppressed', 'This command created a memory that was forgotten; it is not replayed.')
    const item = this.current(scope, row.item_id)
    if (!item) throw new MemoryError('suppressed', 'The memory this command created is no longer available.')
    return { outcome: 'replayed', item }
  }

  private recordCommand(scope: Scope, commandId: string, payloadHash: string, id: string, revision: number, outcome: string): void {
    this.db.prepare('INSERT INTO commands (scope_id, command_id, payload_hash, item_id, revision, outcome, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(scope.scopeId, commandId, payloadHash, id, revision, outcome, 'active')
  }

  async remember(scope: Scope, input: { commandId: string; text: string; kind: MemoryKind; validFrom?: string | null; basis?: 'explicit' | 'imported'; sourceId?: string }, options: CallOptions = {}): Promise<WriteResult> {
    const now = options.now ?? new Date().toISOString()
    const payloadHash = sha256(JSON.stringify(['remember', input.text, input.kind, input.validFrom ?? null]))
    return this.write(() => {
      this.bindScope(scope, now, true)
      const replayed = this.replay(scope, input.commandId, payloadHash)
      if (replayed) return replayed
      if (input.sourceId) {
        const source = this.db.prepare('SELECT status FROM items WHERE scope_id = ? AND id = ?').get(scope.scopeId, input.sourceId) as { status: string } | undefined
        if (source?.status === 'deleted') throw new MemoryError('suppressed', 'This memory was forgotten; an older export cannot bring it back.')
      }
      const canonical = canonicalKey(input.kind, input.text)
      const existing = this.db.prepare("SELECT id FROM items WHERE scope_id = ? AND canonical = ? AND status = 'accepted'").get(scope.scopeId, canonical) as { id: string } | undefined
      if (existing) {
        const item = this.current(scope, existing.id)!
        this.recordCommand(scope, input.commandId, payloadHash, item.id, item.revision, 'duplicate')
        return { outcome: 'duplicate', item }
      }
      const held = this.db.prepare("SELECT count(*) AS count FROM items WHERE scope_id = ? AND status = 'accepted'").get(scope.scopeId) as { count: number }
      if (held.count >= this.maxItems) throw new MemoryError('quota', `This memory is full (${this.maxItems} items); nothing was saved.`)
      const id = `mem_${sha256(`${scope.scopeId}\0${input.commandId}`).slice(0, 32)}`
      this.db.prepare("INSERT INTO items (scope_id, id, current_revision, status, kind, canonical, created_at, updated_at) VALUES (?, ?, 1, 'accepted', ?, ?, ?, ?)").run(scope.scopeId, id, input.kind, canonical, now, now)
      this.db.prepare('INSERT INTO versions (scope_id, id, revision, text, valid_from, valid_until, basis, created_at) VALUES (?, ?, 1, ?, ?, NULL, ?, ?)').run(scope.scopeId, id, input.text, input.validFrom ?? null, input.basis ?? 'explicit', now)
      this.index(scope, id, input.text)
      this.recordCommand(scope, input.commandId, payloadHash, id, 1, 'created')
      return { outcome: 'created', item: this.current(scope, id)! }
    })
  }

  async correct(scope: Scope, input: { commandId: string; id: string; expectedRevision: number; text: string; change: 'mistake' | 'changed'; since?: string | null }, options: CallOptions = {}): Promise<WriteResult> {
    const now = options.now ?? new Date().toISOString()
    const payloadHash = sha256(JSON.stringify(['correct', input.id, input.expectedRevision, input.text, input.change, input.since ?? null]))
    return this.write(() => {
      this.bindScope(scope, now, true)
      const replayed = this.replay(scope, input.commandId, payloadHash)
      if (replayed) return replayed
      const item = this.db.prepare('SELECT id, current_revision, status, kind, created_at, updated_at FROM items WHERE scope_id = ? AND id = ?').get(scope.scopeId, input.id) as ItemRow | undefined
      if (!item || item.status !== 'accepted') throw new MemoryError('not_found', 'There is no such memory to correct.')
      if (item.current_revision !== input.expectedRevision) throw new MemoryError('conflict', 'The memory changed since it was read; read it again before correcting.')
      const canonical = canonicalKey(item.kind, input.text)
      const clash = this.db.prepare("SELECT id FROM items WHERE scope_id = ? AND canonical = ? AND status = 'accepted' AND id <> ?").get(scope.scopeId, canonical, item.id)
      if (clash) throw new MemoryError('conflict', 'Another memory already says exactly this.')
      const previous = this.db.prepare('SELECT valid_from FROM versions WHERE scope_id = ? AND id = ? AND revision = ?').get(scope.scopeId, item.id, item.current_revision) as { valid_from: string | null }
      const revision = item.current_revision + 1
      let validFrom = previous.valid_from
      if (input.change === 'changed') {
        // A real change: the old value was true until `since`, the new one from then on.
        const since = input.since ?? now
        this.db.prepare('UPDATE versions SET valid_until = ? WHERE scope_id = ? AND id = ? AND revision = ?').run(since, scope.scopeId, item.id, item.current_revision)
        validFrom = since
      } else {
        // A mistake: the old value was never right, so no point in time reads it back.
        this.db.prepare('UPDATE versions SET superseded_as_mistake = 1 WHERE scope_id = ? AND id = ? AND revision = ?').run(scope.scopeId, item.id, item.current_revision)
      }
      this.db.prepare("INSERT INTO versions (scope_id, id, revision, text, valid_from, valid_until, basis, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'correction', ?)").run(scope.scopeId, item.id, revision, input.text, validFrom, now)
      this.db.prepare('UPDATE items SET current_revision = ?, canonical = ?, updated_at = ? WHERE scope_id = ? AND id = ?').run(revision, canonical, now, scope.scopeId, item.id)
      this.index(scope, item.id, input.text)
      this.recordCommand(scope, input.commandId, payloadHash, item.id, revision, 'created')
      return { outcome: 'created', item: this.current(scope, item.id)! }
    })
  }

  async forget(scope: Scope, input: { commandId: string; id: string; expectedRevision: number }, options: CallOptions = {}): Promise<{ id: string; forgotten: true }> {
    const now = options.now ?? new Date().toISOString()
    return this.write(() => {
      this.bindScope(scope, now, true)
      const item = this.db.prepare('SELECT id, current_revision, status FROM items WHERE scope_id = ? AND id = ?').get(scope.scopeId, input.id) as ItemRow | undefined
      if (!item) throw new MemoryError('not_found', 'There is no such memory to forget.')
      if (item.status === 'deleted') return { id: item.id, forgotten: true }
      if (item.current_revision !== input.expectedRevision) throw new MemoryError('conflict', 'The memory changed since it was read; read it again before forgetting.')
      // Content goes now, in this transaction; ids stay as tombstones so nothing can bring it back.
      this.db.prepare('UPDATE versions SET text = NULL WHERE scope_id = ? AND id = ?').run(scope.scopeId, item.id)
      this.db.prepare('DELETE FROM item_terms WHERE scope_id = ? AND id = ?').run(scope.scopeId, item.id)
      this.db.prepare("UPDATE items SET status = 'deleted', canonical = NULL, updated_at = ? WHERE scope_id = ? AND id = ?").run(now, scope.scopeId, item.id)
      this.db.prepare("UPDATE commands SET status = 'forgotten' WHERE scope_id = ? AND item_id = ?").run(scope.scopeId, item.id)
      return { id: item.id, forgotten: true }
    })
  }

  async get(scope: Scope, id: string): Promise<MemoryItem | null> {
    if (!this.readScope(scope)) return null
    return this.current(scope, id)
  }

  async getAt(scope: Scope, id: string, validAt: string): Promise<MemoryItem | null> {
    if (!this.readScope(scope)) return null
    const item = this.db.prepare('SELECT id, current_revision, status, kind, created_at, updated_at FROM items WHERE scope_id = ? AND id = ?').get(scope.scopeId, id) as ItemRow | undefined
    if (!item || item.status !== 'accepted') return null
    const version = this.db.prepare(
      `SELECT text, valid_from, valid_until, basis, revision, created_at FROM versions
       WHERE scope_id = ? AND id = ? AND superseded_as_mistake = 0
         AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)
       ORDER BY revision DESC LIMIT 1`,
    ).get(scope.scopeId, id, validAt, validAt) as VersionRow | undefined
    return version ? this.itemAt(item, version) : null
  }

  async history(scope: Scope, id: string): Promise<MemoryRevision[]> {
    if (!this.readScope(scope)) return []
    const rows = this.db.prepare('SELECT revision, basis, text, valid_from, valid_until, superseded_as_mistake, created_at FROM versions WHERE scope_id = ? AND id = ? ORDER BY revision').all(scope.scopeId, id) as { revision: number; basis: string; text: string | null; valid_from: string | null; valid_until: string | null; superseded_as_mistake: number; created_at: string }[]
    return rows.map((row) => ({ revision: row.revision, basis: row.basis as MemoryRevision['basis'], text: row.text, validFrom: row.valid_from, validUntil: row.valid_until, supersededAsMistake: row.superseded_as_mistake === 1, createdAt: row.created_at }))
  }

  async list(scope: Scope, page: { limit: number; cursor: string | null }): Promise<Page<MemoryItem>> {
    // A cursor from another memory is refused even when this one is still empty.
    const after = page.cursor ? decodeCursor(scope, page.cursor) : null
    if (!this.readScope(scope)) return { items: [], nextCursor: null }
    const limit = Math.max(1, Math.min(page.limit, LIMITS.pageSize))
    const rows = (after
      ? this.db.prepare("SELECT id FROM items WHERE scope_id = ? AND status = 'accepted' AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?").all(scope.scopeId, after.createdAt, after.createdAt, after.id, limit + 1)
      : this.db.prepare("SELECT id FROM items WHERE scope_id = ? AND status = 'accepted' ORDER BY created_at, id LIMIT ?").all(scope.scopeId, limit + 1)) as { id: string }[]
    const items = rows.slice(0, limit).map((row) => this.current(scope, row.id)!)
    const last = items.at(-1)
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(scope, last.createdAt, last.id) : null }
  }

  async search(scope: Scope, query: string, limit: number): Promise<MemoryItem[]> {
    if (!this.readScope(scope)) return []
    const wanted = terms(query)
    if (!wanted.length) return []
    const rows = this.db.prepare(
      `SELECT t.id, count(*) AS hits, i.updated_at FROM item_terms t JOIN items i ON i.scope_id = t.scope_id AND i.id = t.id
       WHERE t.scope_id = ? AND i.status = 'accepted' AND t.term IN (${wanted.map(() => '?').join(', ')})
       GROUP BY t.id ORDER BY hits DESC, i.updated_at DESC, t.id LIMIT ?`,
    ).all(scope.scopeId, ...wanted, Math.max(1, Math.min(limit, LIMITS.searchResults))) as { id: string }[]
    return rows.map((row) => this.current(scope, row.id)!).filter(Boolean)
  }

  async capture(scope: Scope, input: { idempotencyKey: string; text: string }, options: CallOptions = {}) {
    const now = options.now ?? new Date().toISOString()
    const hash = sha256(input.text)
    return this.write(() => {
      this.bindScope(scope, now, true)
      const existing = this.db.prepare('SELECT event_id, content_hash FROM events WHERE scope_id = ? AND idempotency_key = ?').get(scope.scopeId, input.idempotencyKey) as { event_id: string; content_hash: string } | undefined
      if (existing) {
        if (existing.content_hash !== hash) throw new MemoryError('conflict', 'This idempotency key is already bound to different content.')
        return { eventId: existing.event_id, outcome: 'replayed' as const }
      }
      const eventId = `evt_${sha256(`${scope.scopeId}\0${input.idempotencyKey}`).slice(0, 32)}`
      this.db.prepare('INSERT INTO events (scope_id, event_id, idempotency_key, content_hash, text, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(scope.scopeId, eventId, input.idempotencyKey, hash, input.text, now)
      this.db.prepare("INSERT INTO jobs (job_id, scope_id, event_id, state, created_at) VALUES (?, ?, ?, 'pending', ?)").run(`job_${eventId.slice(4)}`, scope.scopeId, eventId, now)
      return { eventId, outcome: 'captured' as const }
    })
  }

  async claimJobs(scope: Scope, input: { workerId: string; limit: number; leaseMs: number }, options: CallOptions = {}): Promise<ClaimedJob[]> {
    const now = options.now ?? new Date().toISOString()
    const leaseUntil = new Date(Date.parse(now) + Math.max(1, input.leaseMs)).toISOString()
    return this.write(() => {
      this.bindScope(scope, now, true)
      const rows = this.db.prepare(
        `SELECT job_id FROM jobs WHERE scope_id = ? AND (state = 'pending' OR (state = 'running' AND lease_until <= ?))
         ORDER BY created_at, job_id LIMIT ?`,
      ).all(scope.scopeId, now, Math.max(1, Math.min(input.limit, 100))) as { job_id: string }[]
      const claimed: ClaimedJob[] = []
      for (const row of rows) {
        this.db.prepare("UPDATE jobs SET state = 'running', fence = fence + 1, attempt = attempt + 1, lease_until = ?, worker_id = ? WHERE job_id = ?").run(leaseUntil, input.workerId, row.job_id)
        const job = this.db.prepare('SELECT job_id, event_id, fence, attempt, lease_until FROM jobs WHERE job_id = ?').get(row.job_id) as { job_id: string; event_id: string; fence: number; attempt: number; lease_until: string }
        claimed.push({ jobId: job.job_id, eventId: job.event_id, fence: job.fence, attempt: job.attempt, leaseUntil: job.lease_until })
      }
      return claimed
    })
  }

  async completeJob(scope: Scope, input: { jobId: string; fence: number }, options: CallOptions = {}): Promise<'completed' | 'lease_lost'> {
    const now = options.now ?? new Date().toISOString()
    return this.write(() => {
      this.bindScope(scope, now, false)
      const result = this.db.prepare("UPDATE jobs SET state = 'completed', lease_until = NULL WHERE job_id = ? AND scope_id = ? AND state = 'running' AND fence = ? AND lease_until > ?").run(input.jobId, scope.scopeId, input.fence, now)
      return Number(result.changes) === 1 ? 'completed' : 'lease_lost'
    })
  }

  async close(): Promise<void> {
    this.db.close()
  }
}

/** Cursors are bound to the scope that made them; one from another scope is refused. */
function encodeCursor(scope: Scope, createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: sha256(scope.scopeId).slice(0, 16), c: createdAt, i: id })).toString('base64url')
}

function decodeCursor(scope: Scope, cursor: string): { createdAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: string; c?: string; i?: string }
    if (value.s !== sha256(scope.scopeId).slice(0, 16) || typeof value.c !== 'string' || typeof value.i !== 'string') throw new Error('mismatch')
    return { createdAt: value.c, id: value.i }
  } catch {
    throw new MemoryError('validation', 'This cursor does not belong to this memory.')
  }
}
