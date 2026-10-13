import { Client } from 'pg'
import type { AuditAudio, AuditSpeech, InteractionAudit, InteractionAuditFactory } from '../../../src/lib/interaction-audit'
import type { Env } from './types'

/**
 * The conversation record: every turn, who spoke when, the recordings, and
 * what the Worker did to answer.
 *
 * Written behind the reply, never in front of it. Callers leave a note and
 * carry on; one writer per connection drains the notes to PostgreSQL in the
 * background, a batch per round trip. It used to be the other way round, with
 * the transcript, the first token and each spoken chunk each waiting on a
 * transaction of their own, which put most of a second of database in front of
 * every reply. A write that fails is retried once and then dropped and counted:
 * the record is lost, the answer is not.
 */

const MAX_EVENTS_PER_TURN = 500
const MAX_STORED_AUDIO_BYTES = 32 * 1024 * 1024
/** Held in memory while the database is slow or away; past these, new notes are dropped. */
const MAX_QUEUED_JOBS = 4_000
const MAX_QUEUED_AUDIO_BYTES = 24 * 1024 * 1024
const MAX_EVENT_PAYLOAD_CHARS = 256_000
const EVENT_ROWS_PER_INSERT = 100
/** Turns a connection remembers, so late speech and screen reports still find theirs. */
const MAX_REMEMBERED_TURNS = 64
const RETRY_PAUSE_MS = 400
/** A recording waits this long for the turn that answers it before it is left on its own. */
const CLAIM_WINDOW_MS = 60_000

/**
 * Whether the database refused this one statement rather than the connection
 * failing. A refused record is dropped; a failed connection retries the batch.
 */
function refusedByDatabase(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) && !/^(?:08|53|57|58)/u.test(code)
}

interface AuditFactoryOptions {
  env: Env
  owner: string
  sessionKey: string | null
  channel: 'http' | 'websocket'
  /** Keeps the host alive until a background write has finished (`ctx.waitUntil`). */
  keepAlive?: (work: Promise<unknown>) => void
}

type Job =
  | { kind: 'event'; turnId: string; sequence: number; type: string; payload: string; at: number }
  | { kind: 'asset'; id: string; turnId: string | null; source: 'user' | 'assistant'; mime: string; bytes: Uint8Array; text: string | null; metadata: Record<string, unknown> }
  | { kind: 'segment'; id: string; turnId: string | null; clientTurnId: string | null; speaker: 'user' | 'assistant'; seq: number | null; text: string | null; startChar: number | null; endChar: number | null; startedAt: number | null; endedAt: number | null; assetId: string | null; details: Record<string, unknown> }
  | { kind: 'turn'; turn: TurnRecord }
  | { kind: 'turn_patch'; clientTurnId: string; committed: boolean | null; source: string | null; cardsDisplayed: number; client: Record<string, unknown> }
  | { kind: 'segment_patch'; id: string; startedAt: number | null; endedAt: number | null; interrupted: boolean }
  | { kind: 'claim'; turnId: string; clientTurnId: string; segmentIds: string[] }

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const instant = (at: number | null) => (at === null ? null : new Date(at).toISOString())

const integer = (value: unknown): number => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

/** How long a PCM WAV plays for, read from its header; null for anything else. */
export function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let byteRate = 0
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true)
    if (tag(offset) === 'fmt ' && offset + 20 <= bytes.byteLength) byteRate = view.getUint32(offset + 16, true)
    if (tag(offset) === 'data') {
      if (!byteRate) return null
      return Math.round((Math.min(size, bytes.byteLength - offset - 8) / byteRate) * 1000)
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

/** One turn as it will be read back: counted while it runs, written when it changes. */
class TurnRecord implements InteractionAudit {
  readonly turnId = crypto.randomUUID()
  readonly startedAt = Date.now()
  private sequence = 0
  private overflow = 0
  /** Bumped by anything the stored row would show, so an unchanged row is not rewritten. */
  version = 1
  written = 0

  status: 'completed' | 'failed' | 'cancelled' | null = null
  finishedAt: number | null = null
  userText: string | null = null
  assistantText: string | null = null
  model: string | null = null
  rounds = 0
  promptTokens = 0
  completionTokens = 0
  cachedTokens = 0
  totalTokens = 0
  cost = 0
  toolCalls = 0
  searches = 0
  pagesRead = 0
  cards = 0
  spokenSegments = 0
  readonly timings: Record<string, number> = {}
  readonly tools: { call: string | null; name: string; ok: boolean | null; at: number; ms: number | null }[] = []
  readonly usage: Record<string, unknown>[] = []
  memory: Record<string, unknown> = {}

  constructor(
    readonly clientTurnId: string,
    readonly channel: 'http' | 'websocket',
    readonly speculative: boolean,
    private readonly writer: AuditWriter,
  ) {}

  private elapsed(at = Date.now()) {
    return Math.max(0, at - this.startedAt)
  }

  record(type: string, payload: Record<string, unknown>, at = Date.now()) {
    if (this.sequence >= MAX_EVENTS_PER_TURN) {
      this.overflow += 1
      return
    }
    this.summarise(type, payload, at)
    let body: string
    try {
      body = JSON.stringify(payload)
    } catch {
      body = '{"unserialisable":true}'
    }
    if (body.length > MAX_EVENT_PAYLOAD_CHARS) body = JSON.stringify({ truncated: true, characters: body.length })
    this.writer.push({ kind: 'event', turnId: this.turnId, sequence: ++this.sequence, type: type.slice(0, 80), payload: body, at })
  }

  /** Keeps the totals a reader wants without making them aggregate the event log. */
  private summarise(type: string, payload: Record<string, unknown>, at: number) {
    const usage = payload.usage
    if (usage && typeof usage === 'object') {
      const raw = usage as Record<string, unknown>
      const details = raw.prompt_tokens_details as Record<string, unknown> | null | undefined
      const prompt = integer(raw.prompt_tokens)
      const completion = integer(raw.completion_tokens)
      const cached = integer(details?.cached_tokens)
      const cost = Number(raw.cost)
      this.promptTokens += prompt
      this.completionTokens += completion
      this.cachedTokens += cached
      this.totalTokens += integer(raw.total_tokens) || prompt + completion
      if (Number.isFinite(cost) && cost > 0) this.cost += cost
      if (this.usage.length < 32) {
        this.usage.push({
          source: type,
          model: typeof payload.model === 'string' ? payload.model : null,
          promptTokens: prompt, completionTokens: completion, cachedTokens: cached,
          cost: Number.isFinite(cost) ? cost : null,
          at: this.elapsed(at),
        })
      }
      this.version += 1
    }
    switch (type) {
      case 'submitted_messages': {
        const messages = Array.isArray(payload.messages) ? payload.messages as { role?: unknown; content?: unknown }[] : []
        const last = [...messages].reverse().find((message) => message?.role === 'user')
        if (typeof last?.content === 'string') this.userText = last.content
        break
      }
      case 'provider_response':
        this.rounds += 1
        if (typeof payload.model === 'string') this.model = payload.model
        break
      case 'tool_call':
        this.toolCalls += 1
        // Finding pictures is a search too, though it is not research's.
        if (payload.name === 'show_images') this.searches += 1
        if (this.tools.length < 64) {
          this.tools.push({ call: typeof payload.callId === 'string' ? payload.callId : null, name: String(payload.name ?? ''), ok: null, at: this.elapsed(at), ms: null })
        }
        break
      case 'tool_result': {
        const tool = this.tools.find((item) => item.call === payload.callId && item.ok === null)
        if (tool) {
          tool.ok = payload.ok === true
          tool.ms = Math.max(0, this.elapsed(at) - tool.at)
        }
        break
      }
      case 'research_search_request':
      case 'research_direct_answer_request':
        this.searches += 1
        break
      case 'research_page_read_request':
        this.pagesRead += 1
        break
      case 'card_result':
        if (payload.card) this.cards += 1
        break
      case 'assistant_message':
        if (typeof payload.text === 'string') this.assistantText = payload.text
        break
      case 'memory_context':
      case 'memory_recall':
      case 'memory_capture_result':
        this.memory = { ...this.memory, [type.replace(/^memory_/u, '')]: payload }
        break
      default:
        return
    }
    this.version += 1
  }

  mark(stage: string, ms = this.elapsed()) {
    const name = stage.slice(0, 60)
    if (name in this.timings || Object.keys(this.timings).length >= 48) return
    this.timings[name] = Math.max(0, Math.round(ms))
    this.version += 1
    // A stage reached after the turn was written still belongs on its row.
    if (this.finishedAt !== null) this.save()
  }

  saveAudio(input: AuditAudio): string {
    return this.writer.speech({ ...input, clientTurnId: this.clientTurnId }, this)
  }

  /** Counts a segment spoken for this turn, whether or not the turn is still running. */
  spoke() {
    this.spokenSegments += 1
    this.version += 1
    this.mark('first_audio')
    if (this.finishedAt !== null) this.save()
  }

  finish(status: 'completed' | 'failed' | 'cancelled') {
    if (this.finishedAt !== null) return
    if (this.overflow) this.writer.push({ kind: 'event', turnId: this.turnId, sequence: ++this.sequence, type: 'audit_events_dropped', payload: JSON.stringify({ count: this.overflow }), at: Date.now() })
    this.record('turn_finished', { status })
    this.status = status
    this.finishedAt = Date.now()
    this.version += 1
    this.save()
  }

  save() {
    this.writer.push({ kind: 'turn', turn: this })
  }

  values(conversationId: string, owner: string): unknown[] {
    return [
      this.turnId, conversationId, owner, this.clientTurnId.slice(0, 200), this.channel, this.speculative,
      this.status, instant(this.startedAt), instant(this.finishedAt),
      this.finishedAt === null ? null : this.finishedAt - this.startedAt,
      this.userText, this.assistantText, this.model, this.rounds,
      this.promptTokens, this.completionTokens, this.cachedTokens, this.totalTokens, this.cost.toFixed(8),
      this.toolCalls, this.searches, this.pagesRead, this.cards, this.spokenSegments,
      this.timings.first_token ?? null, this.timings.first_audio ?? null,
      JSON.stringify(this.timings), JSON.stringify(this.tools), JSON.stringify(this.usage), JSON.stringify(this.memory),
    ]
  }
}

const TURN_COLUMNS = [
  'id', 'conversation_id', 'owner_id', 'client_turn_id', 'channel', 'speculative',
  'status', 'started_at', 'finished_at', 'duration_ms',
  'user_text', 'assistant_text', 'model', 'model_rounds',
  'prompt_tokens', 'completion_tokens', 'cached_tokens', 'total_tokens', 'cost_usd',
  'tool_calls', 'searches', 'pages_read', 'cards', 'spoken_segments',
  'first_token_ms', 'first_audio_ms', 'timings', 'tools', 'usage', 'memory',
]
const TURN_JSON = new Set(['timings', 'tools', 'usage', 'memory'])
/** A turn is only ever written by the connection that ran it, so the newest row simply wins. */
const TURN_UPSERT = `INSERT INTO public.gideon_turns (${TURN_COLUMNS.join(', ')}, committed)
  VALUES (${TURN_COLUMNS.map((column, index) => `$${index + 1}${TURN_JSON.has(column) ? '::jsonb' : ''}`).join(', ')}, $${TURN_COLUMNS.length + 1})
  ON CONFLICT (id) DO UPDATE SET ${TURN_COLUMNS.slice(6).map((column) => `${column} = excluded.${column}`).join(', ')}, updated_at = now()`

/** Drains what was noted to the database, in order, off the caller's path. */
class AuditWriter {
  private jobs: Job[] = []
  private queuedAudio = 0
  private dropped = 0
  private draining: Promise<void> | null = null
  private conversation: string | null = null

  constructor(
    private readonly connectionString: string,
    private readonly owner: string,
    private readonly sessionHash: Promise<string>,
    private readonly channel: 'http' | 'websocket',
    private readonly keepAlive: (work: Promise<unknown>) => void,
  ) {}

  push(job: Job): boolean {
    if (this.jobs.length >= MAX_QUEUED_JOBS
      || (job.kind === 'asset' && this.queuedAudio + job.bytes.byteLength > MAX_QUEUED_AUDIO_BYTES)) {
      this.dropped += 1
      return false
    }
    if (job.kind === 'asset') this.queuedAudio += job.bytes.byteLength
    this.jobs.push(job)
    if (!this.draining) {
      const run = this.drain().finally(() => {
        if (this.draining === run) this.draining = null
      })
      this.draining = run
      this.keepAlive(run)
    }
    return true
  }

  /** Stores a recording and its place on the timeline; returns the segment's id. */
  speech(input: AuditSpeech, turn: TurnRecord | null): string {
    const bytes = input.audio instanceof Uint8Array ? input.audio : new Uint8Array(input.audio)
    const source = input.source
    const segmentId = input.segmentId ?? crypto.randomUUID()
    const metadata = input.metadata ?? {}
    const stored = bytes.byteLength > 0 && bytes.byteLength <= MAX_STORED_AUDIO_BYTES
    const assetId = stored ? crypto.randomUUID() : null
    // The user's recording runs up to the moment it was handed over. The
    // assistant's times are the browser's to report, once it has played it.
    let startedAt = input.startedAt ?? null
    let endedAt = input.endedAt ?? null
    if (source === 'user') {
      endedAt ??= Date.now()
      const duration = wavDurationMs(bytes)
      if (startedAt === null && duration !== null) startedAt = endedAt - duration
    }
    const kept = !assetId || this.push({
      kind: 'asset', id: assetId, turnId: turn?.turnId ?? null, source, mime: input.mime.slice(0, 120),
      bytes, text: input.text ?? null, metadata,
    })
    this.push({
      kind: 'segment', id: segmentId, turnId: turn?.turnId ?? null, clientTurnId: input.clientTurnId?.slice(0, 200) ?? null,
      speaker: source, seq: input.seq ?? null, text: input.text ?? null,
      startChar: input.startChar ?? null, endChar: input.endChar ?? null, startedAt, endedAt,
      assetId: kept ? assetId : null,
      details: { ...metadata, mime: input.mime.slice(0, 120), byteLength: bytes.byteLength, ...(kept && assetId ? {} : { audioStored: false }) },
    })
    return segmentId
  }

  settled(): Promise<void> {
    return this.draining ?? Promise.resolve()
  }

  private release(batch: Job[]) {
    for (const job of batch) if (job.kind === 'asset') this.queuedAudio -= job.bytes.byteLength
  }

  private async drain() {
    // Let everything noted in this turn of the event loop ride in one batch.
    await Promise.resolve()
    let failed = false
    while (this.jobs.length) {
      const batch = this.jobs.splice(0, this.jobs.length)
      try {
        await this.write(batch)
        this.release(batch)
        failed = false
      } catch {
        if (failed) {
          // No content, owner or database detail enters platform logs.
          this.release(batch)
          this.dropped += batch.length
          failed = false
          console.warn(`[audit] dropped ${batch.length} records after a failed retry`)
          continue
        }
        failed = true
        // Every statement is idempotent, so the whole batch can go again.
        this.jobs.unshift(...batch)
        await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS))
      }
    }
  }

  private async write(batch: Job[]) {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000, query_timeout: 15_000 })
    client.on('error', () => undefined)
    await client.connect()
    try {
      if (!this.conversation) {
        const result = await client.query<{ id: string }>(
          `INSERT INTO public.gideon_conversations (owner_id, client_session_hash, channel)
           VALUES ($1, $2, $3)
           ON CONFLICT (owner_id, client_session_hash) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [this.owner, await this.sessionHash, this.channel],
        )
        const id = result.rows[0]?.id
        if (!id) throw new Error('Conversation audit record was not created')
        this.conversation = id
      }
      const conversation = this.conversation
      const refused = new Set<string>()
      const run = async (text: string, values: unknown[]): Promise<boolean> => {
        try {
          await client.query(text, values)
          return true
        } catch (error) {
          if (!refusedByDatabase(error)) throw error
          this.dropped += 1
          return false
        }
      }
      // Events refer to nothing else in the batch and carry their own order,
      // so however they were interleaved they go as one INSERT per hundred
      // rather than one round trip each.
      const noted = batch.filter((job): job is Extract<Job, { kind: 'event' }> => job.kind === 'event')
      for (let offset = 0; offset < noted.length; offset += EVENT_ROWS_PER_INSERT) {
        const events = noted.slice(offset, offset + EVENT_ROWS_PER_INSERT)
        const rows = events.map((_, row) => {
          const base = row * 7
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7})`
        }).join(', ')
        await run(
          `INSERT INTO public.gideon_interaction_events
            (conversation_id, owner_id, turn_id, sequence, event_type, payload, occurred_at)
           VALUES ${rows}
           ON CONFLICT (turn_id, sequence) DO NOTHING`,
          events.flatMap((event) => [conversation, this.owner, event.turnId, event.sequence, event.type, event.payload, instant(event.at)]),
        )
      }
      // The rest in the order it was noted: a recording before the segment
      // that points at it, a turn before what amends it.
      for (const job of batch) {
        if (job.kind === 'event') continue
        if (job.kind === 'asset') {
          const stored = await run(
            `INSERT INTO public.gideon_voice_assets
              (id, conversation_id, owner_id, turn_id, source, mime_type, byte_length, sha256, transcript, audio, metadata, transcription_model)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
             ON CONFLICT (id) DO NOTHING`,
            [job.id, conversation, this.owner, job.turnId, job.source, job.mime, job.bytes.byteLength,
              await sha256(job.bytes), job.text, job.bytes, JSON.stringify(job.metadata),
              typeof job.metadata.transcriptionModel === 'string' ? job.metadata.transcriptionModel.slice(0, 160) : null],
          )
          if (!stored) refused.add(job.id)
        } else if (job.kind === 'segment') {
          const assetId = job.assetId && !refused.has(job.assetId) ? job.assetId : null
          await run(
            `INSERT INTO public.gideon_speech_segments
              (id, conversation_id, owner_id, turn_id, client_turn_id, speaker, seq, text, start_char, end_char,
               started_at, ended_at, duration_ms, asset_id, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
             ON CONFLICT (id) DO NOTHING`,
            [job.id, conversation, this.owner, job.turnId, job.clientTurnId, job.speaker, job.seq, job.text, job.startChar, job.endChar,
              instant(job.startedAt), instant(job.endedAt),
              job.startedAt !== null && job.endedAt !== null ? Math.max(0, job.endedAt - job.startedAt) : null,
              assetId, JSON.stringify(assetId === job.assetId ? job.details : { ...job.details, audioStored: false })],
          )
        } else if (job.kind === 'turn') {
          const { turn } = job
          if (turn.written === turn.version) continue
          const version = turn.version
          // A turn that was not a guess was used by definition; a guess waits to be told.
          if (await run(TURN_UPSERT, [...turn.values(conversation, this.owner), turn.speculative ? null : true])) turn.written = version
        } else if (job.kind === 'turn_patch') {
          await run(
            `UPDATE public.gideon_turns
             SET committed = coalesce($3, committed), source = coalesce($4, source),
                 cards_displayed = cards_displayed + $5, client = client || $6::jsonb, updated_at = now()
             WHERE conversation_id = $1 AND client_turn_id = $2`,
            [conversation, job.clientTurnId, job.committed, job.source, job.cardsDisplayed, JSON.stringify(job.client)],
          )
        } else if (job.kind === 'segment_patch') {
          await run(
            `UPDATE public.gideon_speech_segments
             SET started_at = coalesce(started_at, $3::timestamptz),
                 ended_at = coalesce($4::timestamptz, ended_at),
                 interrupted = interrupted OR $5,
                 duration_ms = CASE
                   WHEN coalesce(started_at, $3::timestamptz) IS NOT NULL AND coalesce($4::timestamptz, ended_at) IS NOT NULL
                   THEN greatest(0, round(extract(epoch FROM coalesce($4::timestamptz, ended_at) - coalesce(started_at, $3::timestamptz)) * 1000))::integer
                   ELSE duration_ms END
             WHERE id = $1 AND conversation_id = $2`,
            [job.id, conversation, instant(job.startedAt), instant(job.endedAt), job.interrupted],
          )
        } else {
          await run(
            `UPDATE public.gideon_speech_segments SET turn_id = $3, client_turn_id = $4
             WHERE conversation_id = $1 AND id = ANY($2::uuid[]) AND turn_id IS NULL`,
            [conversation, job.segmentIds, job.turnId, job.clientTurnId],
          )
        }
      }
      if (this.dropped) {
        const dropped = this.dropped
        this.dropped = 0
        await client.query(
          `INSERT INTO public.gideon_interaction_events (conversation_id, owner_id, turn_id, sequence, event_type, payload, occurred_at)
           VALUES ($1, $2, $3, 1, 'audit_records_dropped', $4::jsonb, now())`,
          [conversation, this.owner, crypto.randomUUID(), JSON.stringify({ count: dropped })],
        ).catch(() => { this.dropped += dropped })
      }
    } finally {
      await client.end().catch(() => undefined)
    }
  }
}

/** Private Hyperdrive writer. The browser session value is hashed and is never an owner key. */
export function createWorkerInteractionAudit(options: AuditFactoryOptions): InteractionAuditFactory | null {
  if (options.env.GIDEON_AUDIT_ENABLED !== '1') {
    if (options.env.GIDEON_AUDIT_REQUIRED === '1') throw new Error('Required conversation audit is disabled')
    return null
  }
  const connectionString = options.env.HYPERDRIVE?.connectionString
  if (!connectionString) {
    if (options.env.GIDEON_AUDIT_REQUIRED === '1') throw new Error('Conversation audit storage is unavailable')
    return null
  }

  const sessionValue = (options.sessionKey || crypto.randomUUID()).slice(0, 256)
  const writer = new AuditWriter(
    connectionString,
    options.owner,
    sha256(`${options.owner}\0${sessionValue}`),
    options.channel,
    // A rejection is the writer's to handle; it must never surface as the host's.
    (work) => options.keepAlive?.(work.catch(() => undefined)),
  )

  const turns = new Map<string, TurnRecord>()
  /** The user's recordings not yet tied to the turn that answered them. */
  let unclaimed: { id: string; at: number }[] = []

  const remember = (turn: TurnRecord) => {
    turns.set(turn.clientTurnId, turn)
    if (turns.size > MAX_REMEMBERED_TURNS) turns.delete(turns.keys().next().value!)
  }
  const claim = (turn: TurnRecord) => {
    const segmentIds = unclaimed.filter((segment) => Date.now() - segment.at <= CLAIM_WINDOW_MS).map((segment) => segment.id)
    unclaimed = []
    if (segmentIds.length) writer.push({ kind: 'claim', turnId: turn.turnId, clientTurnId: turn.clientTurnId.slice(0, 200), segmentIds })
  }

  return {
    startTurn(input) {
      const turn = new TurnRecord(input.clientTurnId, options.channel, input.speculative === true, writer)
      remember(turn)
      turn.record('turn_started', { channel: options.channel, clientTurnId: input.clientTurnId.slice(0, 200), speculative: input.speculative === true })
      turn.record('submitted_messages', { messages: input.messages })
      turn.save()
      // What was just said is what this turn answers. A guess is tied to it
      // only if the browser later says the guess was used.
      if (!turn.speculative) claim(turn)
      return turn
    },
    recordSpeech(input) {
      const turn = input.clientTurnId ? turns.get(input.clientTurnId) ?? null : null
      const segmentId = writer.speech(input, turn)
      // Silence that was transcribed to nothing starts no turn, so it waits for none.
      if (input.source === 'user' && !turn && input.text?.trim()) {
        unclaimed.push({ id: segmentId, at: Date.now() })
        if (unclaimed.length > 32) unclaimed.shift()
      }
      if (input.source === 'assistant' && turn) turn.spoke()
      return segmentId
    },
    recordEvent(input) {
      const turn = turns.get(input.clientTurnId)
      if (turn) {
        turn.record(input.type, input.payload, input.at)
        if (turn.finishedAt !== null) turn.save()
        return
      }
      // A turn this connection never ran, such as one answered over HTTP.
      writer.push({
        kind: 'event', turnId: crypto.randomUUID(), sequence: 1, type: input.type.slice(0, 80),
        payload: JSON.stringify({ ...input.payload, clientTurnId: input.clientTurnId.slice(0, 200) }).slice(0, MAX_EVENT_PAYLOAD_CHARS),
        at: input.at ?? Date.now(),
      })
    },
    amendTurn(clientTurnId, patch) {
      const { committed, source, cardsDisplayed, ...client } = patch
      const turn = turns.get(clientTurnId)
      if (turn && committed === true) claim(turn)
      writer.push({
        kind: 'turn_patch',
        clientTurnId: clientTurnId.slice(0, 200),
        committed: typeof committed === 'boolean' ? committed : null,
        source: source === 'voice' || source === 'typed' || source === 'card' ? source : null,
        cardsDisplayed: Number.isSafeInteger(cardsDisplayed) ? Math.max(0, cardsDisplayed as number) : 0,
        client,
      })
    },
    amendSpeech(segmentId, patch) {
      writer.push({
        kind: 'segment_patch', id: segmentId,
        startedAt: patch.startedAt ?? null, endedAt: patch.endedAt ?? null, interrupted: patch.interrupted === true,
      })
    },
    settled() {
      return writer.settled()
    },
  }
}
